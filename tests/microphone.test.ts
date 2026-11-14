import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup(pendingPermission = false, pendingActivation = false) {
  const events: string[] = [];
  const timers = new Set<() => void>();
  let grant!: (stream: unknown) => void;
  const track = { stop: () => events.push("stop") };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const connection = { connect: () => connection, disconnect() {} };
  class Context {
    state = "running";
    audioWorklet = { addModule: async () => {} };
    resume() {
      events.push("resume");
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
  return { mic: scope.mic, events, timers, grant: () => grant(stream) };
}

test("microphone activates audio before awaiting permission and cleans up", async () => {
  const { mic, events, timers } = setup();
  await mic.start(
    "",
    () => {},
    () => {},
  );
  assert.deepEqual(events, ["resume", "permission"]);
  assert.equal(timers.size, 0);
  await mic.stop();
  assert.deepEqual(events.slice(2), ["stop", "close"]);
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
  const rejected = assert.rejects(started, /Allow audio playback/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  [...timers].forEach((callback) => callback());
  await rejected;
  assert.ok(events.includes("stop"));
  assert.ok(events.includes("close"));
});
