import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup({
  pendingPermission = false,
  pendingActivation = false,
  pendingSuspend = false,
  pendingClose = false,
} = {}) {
  const events: string[] = [];
  const timers = new Set<() => void>();
  let activate!: () => void;
  let finishSuspend!: () => void;
  let grant!: (stream: unknown) => void;
  let contexts = 0;
  const track = { stop: () => events.push("track stopped") };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let worklet: { port: { onmessage?: (event: unknown) => void } } | undefined;
  const connection = { connect: () => connection, disconnect() {} };
  class Context {
    state = "suspended";
    constructor() {
      contexts++;
    }
    audioWorklet = {
      addModule: async () => {
        events.push("module");
      },
    };
    resume() {
      events.push("resume");
      if (!pendingActivation) {
        this.state = "running";
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        activate = () => {
          this.state = "running";
          resolve();
        };
      });
    }
    suspend() {
      events.push("suspend");
      this.state = "suspended";
      return pendingSuspend
        ? new Promise<void>((resolve) => {
            finishSuspend = resolve;
          })
        : Promise.resolve();
    }
    createMediaStreamSource() {
      return {
        connect() {
          worklet?.port.onmessage?.({
            data: { pcm: new ArrayBuffer(3200), level: 0.5 },
          });
        },
        disconnect() {},
      };
    }
    createGain() {
      return { ...connection, gain: { value: 1 } };
    }
    async close() {
      events.push("close");
      if (pendingClose) await new Promise<void>(() => {});
      this.state = "closed";
    }
  }
  const source = readFileSync("apps/web/src/audio/microphone.ts", "utf8")
    .replace(/^import .*;\n/, 'const workletUrl = "worklet.js";\n')
    .replace("export class Microphone", "class Microphone");
  const scope = vm.createContext({
    navigator: {
      mediaDevices: {
        getUserMedia: () => {
          events.push("permission");
          return pendingPermission
            ? new Promise((resolve) => {
                grant = resolve;
              })
            : Promise.resolve(stream);
        },
      },
    },
    window: { isSecureContext: true },
    AudioContext: Context,
    AudioWorkletNode: class {
      port = {
        postMessage: () => events.push("processor stopped"),
        close: () => events.push("port closed"),
      };
      constructor() {
        events.push("node");
        worklet = { port: this.port };
      }
      connect = connection.connect;
      disconnect() {}
    },
    setTimeout: (callback: () => void) => {
      timers.add(callback);
      return callback;
    },
    clearTimeout: (callback: () => void) => timers.delete(callback),
  });
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.mic = new Microphone();", {
      target: ts.ScriptTarget.ES2022,
    }),
    scope,
  );
  return {
    mic: scope.mic,
    events,
    timers,
    contexts: () => contexts,
    grant: () => grant(stream),
    activate: () => activate(),
    finishSuspend: () => finishSuspend(),
  };
}
const ignore = () => {};

test("twenty meetings reuse one audio context and module, with fresh input processors", async () => {
  const { mic, events, contexts, timers } = setup();
  for (let i = 0; i < 20; i++) {
    await mic.start("", ignore, ignore);
    assert.equal(mic.diagnostics().receivedChunks, 1);
    await mic.stop();
  }
  assert.equal(contexts(), 1);
  assert.equal(events.filter((event) => event === "module").length, 1);
  for (const event of [
    "node",
    "track stopped",
    "processor stopped",
    "port closed",
    "suspend",
  ])
    assert.equal(events.filter((value) => value === event).length, 20);
  assert.equal(events.includes("close"), false);
  assert.equal(timers.size, 0);
  await mic.dispose();
  assert.equal(events.filter((event) => event === "close").length, 1);
});

test("activation still completes before loading the processor", async () => {
  const { mic, events, activate } = setup({ pendingActivation: true });
  const starting = mic.start("", ignore, ignore);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(events, ["resume", "permission"]);
  activate();
  await starting;
  assert.deepEqual(events, ["resume", "permission", "module", "node"]);
  assert.equal(mic.diagnostics().peakLevel, 0.5);
  await mic.stop();
});

test("duplicate stop shares shutdown and a new start cannot overlap it", async () => {
  const { mic, finishSuspend, contexts } = setup({ pendingSuspend: true });
  await mic.start("", ignore, ignore);
  const stopping = mic.stop();
  assert.equal(mic.stop(), stopping);
  await assert.rejects(mic.start("", ignore, ignore), /stopping/);
  finishSuspend();
  await stopping;
  await mic.start("", ignore, ignore);
  assert.equal(contexts(), 1);
  const stoppingAgain = mic.stop();
  finishSuspend();
  await stoppingAgain;
});

test("permission timeout releases a late stream without replacing the engine", async () => {
  const { mic, events, timers, grant, contexts } = setup({
    pendingPermission: true,
  });
  const started = mic.start("", ignore, ignore);
  const rejected = assert.rejects(started, /Microphone permission timed out/);
  [...timers].forEach((callback) => callback());
  await rejected;
  grant();
  await Promise.resolve();
  assert.ok(events.includes("track stopped"));
  assert.equal(contexts(), 1);
  assert.equal(timers.size, 0);
});

test("blocked activation releases capture and reports the timeout", async () => {
  const { mic, events, timers } = setup({ pendingActivation: true });
  const started = mic.start("", ignore, ignore);
  const rejected = assert.rejects(started, /Audio activation timed out/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  [...timers].forEach((callback) => callback());
  await rejected;
  assert.ok(events.includes("track stopped"));
  assert.equal(events.includes("module"), false);
});

test("disposal bounds a stalled browser close and clears page ownership", async () => {
  const { mic, timers } = setup({ pendingClose: true });
  await mic.start("", ignore, ignore);
  const disposing = mic.dispose();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  [...timers].forEach((callback) => callback());
  await disposing;
  assert.equal(mic.diagnostics().contextState, "closed");
  assert.equal(timers.size, 0);
});
