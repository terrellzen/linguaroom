import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup() {
  const timeouts = new Map<() => void, number>();
  const intervals = new Map<() => void, number>();
  const sockets: Socket[] = [];
  const notices: string[] = [];
  let ended = 0;
  let now = 100000;
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    sent: unknown[] = [];
    constructor() {
      super();
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(data: unknown) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 2;
    }
    message(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
    finishClose() {
      this.readyState = 3;
      this.onclose?.();
      this.dispatchEvent(new Event("close"));
    }
  }
  const scope = vm.createContext({
    WebSocket: Socket,
    Blob,
    crypto: { randomUUID: () => "test-room" },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    Normalizer: class {
      accept() {
        return [];
      }
    },
    responseSchema: { parse: (data: unknown) => data },
    setTimeout: (callback: () => void, ms: number) => {
      timeouts.set(callback, ms);
      return callback;
    },
    clearTimeout: (callback: () => void) => timeouts.delete(callback),
    setInterval: (callback: () => void, ms: number) => {
      intervals.set(callback, ms);
      return callback;
    },
    clearInterval: (callback: () => void) => intervals.delete(callback),
    notice: (message: string) => notices.push(message),
    ended: () => ended++,
  });
  const source = readFileSync("apps/web/src/standalone.ts", "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export class", "class");
  vm.runInContext(
    ts.transpile(
      source +
        "\nglobalThis.session = new StandaloneSession(() => {}, notice, ended);",
      { target: ts.ScriptTarget.ES2022 },
    ),
    scope,
  );
  const start = async () => {
    const started = scope.session.start({
      key: "synthetic-test-key",
      target: "es",
      name: "Test",
    });
    await Promise.resolve();
    sockets.at(-1)!.open();
    await started;
  };
  return {
    session: scope.session,
    sockets,
    start,
    notices,
    timeouts,
    intervals,
    ended: () => ended,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("socket open is not confirmation that Soniox processed microphone audio", async () => {
  const { session, sockets, start, notices } = setup();
  await start();
  assert.equal(session.room.metrics.audioConfirmed, 0);
  session.audio(new ArrayBuffer(3200));
  sockets[0].message({ tokens: [], total_audio_proc_ms: 0 });
  assert.equal(session.room.metrics.audioConfirmed, 0);
  assert.equal(notices.length, 0);
  sockets[0].message({ tokens: [], total_audio_proc_ms: 1200 });
  assert.equal(session.room.metrics.audioConfirmed, 1);
  assert.match(notices.at(-1)!, /Audio is being processed/);
  assert.equal(session.room.metrics.audioChunksSent, 1);
});

test("health check distinguishes missing microphone chunks from missing provider processing", async () => {
  const { session, start, notices, intervals, advance } = setup();
  await start();
  session.audio(new ArrayBuffer(3200));
  advance(9000);
  session.audio(new ArrayBuffer(3200));
  const health = [...intervals].find(([, ms]) => ms === 1000)![0];
  health();
  assert.match(notices.at(-1)!, /Soniox has not confirmed processing/);
  advance(6000);
  health();
  assert.match(notices.at(-1)!, /Microphone stopped sending audio/);
  session.setPaused(true);
  const count = notices.length;
  health();
  assert.equal(notices.length, count);
});

test("timed out socket shutdown retires ownership and ignores late old callbacks", async () => {
  const { session, sockets, start, timeouts, ended } = setup();
  await start();
  const oldSocket = sockets[0];
  const stopping = session.stop();
  assert.equal(session.stop(), stopping);
  [...timeouts].find(([, ms]) => ms === 5000)![0]();
  await stopping;
  assert.equal(session.socket, undefined);
  await start();
  const endedBefore = ended();
  oldSocket.finishClose();
  oldSocket.message({ error_code: 400, error_type: "old_error" });
  assert.equal(ended(), endedBefore);
  assert.equal(session.socket, sockets[1]);
  assert.equal(session.room.state, "connected");
});
