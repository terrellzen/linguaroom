import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup(
  pendingPermission = false,
  pendingActivation = false,
  pendingClose = false,
  deliversAudio = !pendingActivation,
) {
  const events: string[] = [];
  const timers = new Set<() => void>();
  let finishClose!: () => void;
  let grant!: (stream: unknown) => void;
  const track = { stop: () => events.push("stop") };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let worklet: { port: { onmessage?: (event: unknown) => void } } | undefined;
  const connection = { connect: () => connection, disconnect() {} };
  class Context {
    state = "running";
    audioWorklet = { addModule: async () => {} };
    resume() {
      events.push("resume");
      if (deliversAudio)
        worklet?.port.onmessage?.({
          data: { pcm: new ArrayBuffer(3200), level: 0 },
        });
      return pendingActivation ? new Promise(() => {}) : Promise.resolve();
    }
    createMediaStreamSource() {
      return connection;
    }
    createGain() {
      return { ...connection, gain: { value: 1 } };
    }
    async close() {
      events.push("close");
      if (pendingClose)
        await new Promise<void>((resolve) => {
          finishClose = resolve;
        });
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
      port = {};
      constructor() {
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
    grant: () => grant(stream),
    finishClose: () => finishClose(),
  };
}

test("microphone activates audio before awaiting permission and cleans up", async () => {
  const { mic, events, timers } = setup();
  await mic.start(
    "",
    () => {},
    () => {},
  );
  assert.deepEqual(events, ["resume", "permission", "resume"]);
  assert.equal(timers.size, 0);
  await mic.stop();
  assert.deepEqual(events.slice(3), ["stop", "close"]);
});

test("permission timeout releases a microphone granted after the failed attempt", async () => {
  const { mic, events, timers, grant } = setup(true);
  const started = mic.start(
    "",
    () => {},
    () => {},
  );
  const rejected = assert.rejects(started, /Microphone permission timed out/);
  [...timers].forEach((callback) => callback());
  await rejected;
  grant();
  await Promise.resolve();
  assert.ok(events.includes("stop"));
  assert.ok(events.includes("close"));
  assert.equal(timers.size, 0);
});

test("blocked audio activation fails with retry guidance and releases capture", async () => {
  const { mic, events, timers } = setup(false, true);
  const started = mic.start(
    "",
    () => {},
    () => {},
  );
  const rejected = assert.rejects(started, /Firefox did not deliver audio/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  [...timers].forEach((callback) => callback());
  await rejected;
  assert.ok(events.includes("stop"));
  assert.ok(events.includes("close"));
});

test("a delayed old close cannot erase a restarted microphone", async () => {
  const { mic, events, finishClose } = setup(false, false, true);
  await mic.start(
    "",
    () => {},
    () => {},
  );
  const closing = mic.stop();
  await mic.start(
    "",
    () => {},
    () => {},
  );
  finishClose();
  await closing;
  const closingAgain = mic.stop();
  assert.equal(events.filter((event) => event === "stop").length, 2);
  finishClose();
  await closingAgain;
});

test("cleanup completes even when the browser never resolves close", async () => {
  const { mic, timers } = setup(false, false, true);
  await mic.start(
    "",
    () => {},
    () => {},
  );
  const closing = mic.stop();
  [...timers].forEach((callback) => callback());
  await closing;
  await mic.start(
    "",
    () => {},
    () => {},
  );
  const closingAgain = mic.stop();
  [...timers].forEach((callback) => callback());
  await closingAgain;
  assert.equal(timers.size, 0);
});

test("capture succeeds when Firefox delivers PCM but never resolves resume", async () => {
  const { mic, timers } = setup(false, true, false, true);
  const frames: ArrayBuffer[] = [];
  await mic.start(
    "",
    (pcm: ArrayBuffer) => frames.push(pcm),
    () => {},
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].byteLength, 3200);
  assert.equal(timers.size, 0);
  await mic.stop();
});
