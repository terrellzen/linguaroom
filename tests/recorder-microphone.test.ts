import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup(emitInitial = true) {
  const timers = new Set<() => void>();
  const events: string[] = [];
  const recorders: Recorder[] = [];
  const track = { stop: () => events.push("track stopped") };
  class Recorder {
    static isTypeSupported(type: string) {
      return type.startsWith("audio/ogg");
    }
    state = "inactive";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    emit(text: string) {
      this.ondataavailable?.({ data: new Blob([text]) });
    }
    constructor() {
      recorders.push(this);
    }
    start() {
      this.state = "recording";
      if (emitInitial) queueMicrotask(() => this.emit("OggS header"));
    }
    pause() {
      this.state = "paused";
    }
    resume() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.emit("final chunk");
        this.onstop?.();
      });
    }
  }
  const scope = vm.createContext({
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }),
      },
    },
    window: { isSecureContext: true },
    MediaRecorder: Recorder,
    setTimeout: (callback: () => void) => {
      timers.add(callback);
      return callback;
    },
    clearTimeout: (callback: () => void) => timers.delete(callback),
  });
  const source = readFileSync(
    "apps/web/src/audio/recorder-microphone.ts",
    "utf8",
  ).replace("export class", "class");
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.mic = new RecorderMicrophone();", {
      target: ts.ScriptTarget.ES2022,
    }),
    scope,
  );
  return { mic: scope.mic, timers, events, recorders };
}

test("native capture preserves the header and ordered chunks until connection is ready", async () => {
  const { mic, recorders, events } = setup();
  const chunks: Blob[] = [];
  await mic.start(
    "",
    (data: Blob) => chunks.push(data),
    () => {},
  );
  recorders[0].emit("second chunk");
  assert.equal(chunks.length, 0);
  mic.commit();
  recorders[0].emit("third chunk");
  await mic.stop();
  assert.deepEqual(await Promise.all(chunks.map((blob) => blob.text())), [
    "OggS header",
    "second chunk",
    "third chunk",
    "final chunk",
  ]);
  assert.deepEqual(events, ["track stopped"]);
});

test("native pause and resume retain one recorder and its container", async () => {
  const { mic, recorders } = setup();
  await mic.start(
    "",
    () => {},
    () => {},
  );
  await mic.pause();
  assert.equal(recorders[0].state, "paused");
  await mic.resume();
  assert.equal(recorders[0].state, "recording");
  assert.equal(recorders.length, 1);
  await mic.stop();
});

test("native startup timeout releases the track and recorder", async () => {
  const { mic, recorders, timers, events } = setup(false);
  const started = mic.start(
    "",
    () => {},
    () => {},
  );
  const rejected = assert.rejects(
    started,
    /Native microphone produced no audio/,
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  [...timers].forEach((callback) => callback());
  await rejected;
  assert.equal(recorders[0].state, "inactive");
  assert.deepEqual(events, ["track stopped"]);
  assert.equal(timers.size, 0);
});

test("a new session gets a fresh header and survives a pending old stop", async () => {
  const { mic, recorders } = setup();
  const chunks: Blob[] = [];
  await mic.start(
    "",
    () => {},
    () => {},
  );
  const stopping = mic.stop();
  await mic.start(
    "",
    (data: Blob) => chunks.push(data),
    () => {},
  );
  await stopping;
  mic.commit();
  recorders[1].emit("new audio");
  assert.deepEqual(await Promise.all(chunks.map((blob) => blob.text())), [
    "OggS header",
    "new audio",
  ]);
  await mic.stop();
});
