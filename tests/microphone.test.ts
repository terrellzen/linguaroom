import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup({
  pendingPermission = false,
  permissionDenied = false,
  pendingActivation = false,
  pendingModule = false,
  pendingSamples = false,
  pendingSuspend = false,
  pendingClose = false,
  activationNeedsPermission = false,
  activationNeedsReset = false,
  activationNeedsGraph = false,
  activationNeedsFreshContext = false,
} = {}) {
  const events: string[] = [];
  const timers = new Set<() => void>();
  let activate!: () => void;
  let finishSuspend!: () => void;
  let grant!: (stream: unknown) => void;
  let contexts = 0;
  let permissionGranted = false;
  let inputReset = false;
  let graphConnected = false;
  const track = {
    stop: () => {
      events.push("track stopped");
      inputReset = true;
    },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let worklet: { port: { onmessage?: (event: unknown) => void } } | undefined;
  const connection = {
    connect: () => {
      graphConnected = true;
      return connection;
    },
    disconnect() {},
  };
  class Context {
    state = "suspended";
    readonly index: number;
    constructor() {
      contexts++;
      this.index = contexts;
    }
    audioWorklet = {
      addModule: async () => {
        events.push("module");
        if (pendingModule) await new Promise<void>(() => {});
      },
    };
    resume() {
      events.push("resume");
      if (activationNeedsFreshContext && this.index === 1)
        return new Promise<void>(() => {});
      if (activationNeedsGraph && !graphConnected)
        return new Promise<void>(() => {});
      if (activationNeedsReset && !inputReset)
        return new Promise<void>(() => {});
      if (activationNeedsPermission && !permissionGranted)
        return new Promise<void>(() => {});
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
          if (!pendingSamples)
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
    .replace(/export /g, "");
  const scope = vm.createContext({
    navigator: {
      mediaDevices: {
        getUserMedia: () => {
          events.push("permission");
          if (permissionDenied)
            return Promise.reject(new Error("Permission denied"));
          const requested = pendingPermission
            ? new Promise((resolve) => {
                grant = resolve;
              })
            : Promise.resolve(stream);
          return requested.then((result) => {
            permissionGranted = true;
            return result;
          });
        },
      },
    },
    window: { isSecureContext: true },
    AbortController,
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

test("healthy meetings reuse one engine with fresh input processors", async () => {
  const { mic, contexts, timers, events } = setup();
  for (let i = 0; i < 20; i++) {
    await mic.start("", ignore, ignore);
    assert.equal(mic.diagnostics().receivedChunks, 1);
    await mic.stop();
  }
  assert.equal(contexts(), 1);
  assert.equal(events.filter((event) => event === "module").length, 1);
  assert.equal(events.filter((event) => event === "track stopped").length, 20);
  assert.equal(timers.size, 0);
});

for (const stage of [
  "pendingPermission",
  "pendingActivation",
  "pendingModule",
  "pendingSamples",
] as const) {
  test(`Stop cancels ${stage} without waiting for Firefox`, async () => {
    const { mic, events, timers, grant } = setup({ [stage]: true });
    const started = mic.start("", ignore, ignore);
    const rejected = assert.rejects(started, /Microphone stopped/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await mic.stop();
    await rejected;
    if (stage === "pendingPermission") {
      grant();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(events.filter((event) => event === "permission").length, 1);
    assert.ok(events.includes("track stopped"));
    assert.equal(mic.diagnostics().contextState, "closed");
    assert.equal(timers.size, 0);
  });
}

test("ten-second deadline stops activation without an automatic retry", async () => {
  const { mic, events, contexts, timers } = setup({ pendingActivation: true });
  const started = mic.start("", ignore, ignore);
  const rejected = assert.rejects(started, /10 seconds/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  [...timers].forEach((callback) => callback());
  await rejected;
  assert.equal(contexts(), 1);
  assert.equal(events.filter((event) => event === "permission").length, 1);
  assert.equal(timers.size, 0);
});

test("manual replacement retires a stalled engine and starts fresh", async () => {
  const { mic, contexts, events, timers } = setup({
    activationNeedsFreshContext: true,
  });
  const started = mic.start("", ignore, ignore);
  const rejected = assert.rejects(started, /Microphone stopped/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await mic.dispose();
  await rejected;
  await mic.start("", ignore, ignore);
  assert.equal(contexts(), 2);
  assert.equal(events.filter((event) => event === "close").length, 1);
  assert.equal(mic.diagnostics().receivedChunks, 1);
  assert.equal(timers.size, 0);
  await mic.stop();
});

test("external cancellation owns the single startup deadline", async () => {
  const { mic, timers } = setup({ pendingActivation: true });
  const controller = new AbortController();
  const started = mic.start("", ignore, ignore, ignore, controller.signal);
  const rejected = assert.rejects(started, /User stopped/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 0);
  controller.abort(new Error("User stopped"));
  await rejected;
  assert.equal(timers.size, 0);
});

test("permission denial is reported without a retry", async () => {
  const { mic, events, timers } = setup({ permissionDenied: true });
  await assert.rejects(mic.start("", ignore, ignore), /Permission denied/);
  assert.equal(events.filter((event) => event === "permission").length, 1);
  assert.equal(timers.size, 0);
});

test("a pending pre-permission resume does not block the connected graph", async () => {
  const { mic, timers } = setup({
    activationNeedsPermission: true,
    activationNeedsGraph: true,
  });
  await mic.start("", ignore, ignore);
  assert.equal(mic.diagnostics().receivedChunks, 1);
  assert.equal(timers.size, 0);
  await mic.stop();
});

test("cleanup is bounded when native close never resolves", async () => {
  const { mic, timers } = setup({ pendingClose: true });
  await mic.start("", ignore, ignore);
  const disposing = mic.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  [...timers].forEach((callback) => callback());
  await disposing;
  assert.equal(mic.diagnostics().contextState, "closed");
  assert.equal(timers.size, 0);
});
