import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/src/app.js";
import type {
  SpeechProvider,
  ProviderCallbacks,
} from "../apps/server/src/providers/speech-provider.js";
/** Explicitly simulated provider. Never selectable in production. */
class MockProvider implements SpeechProvider {
  readonly id = "test-mock";
  connections = 0;
  callbacks?: ProviderCallbacks;
  capabilities() {
    return { translation: true, diarization: true, languages: ["en"] };
  }
  async initialize() {}
  async create(_key: string, _options: unknown, cb: ProviderCallbacks) {
    this.connections++;
    this.callbacks = cb;
    cb.state("connected");
    return {
      audio: (data: Buffer) => data.length <= 160000,
      end: async () => {
        cb.state("ended");
      },
    };
  }
}
async function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const provider = new MockProvider();
  const { app } = await createApp(provider, {
    HOST_PASSWORD: "test-password",
    LOG_LEVEL: "silent",
    ...extraEnv,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin, host: `127.0.0.1:${address.port}` },
    payload: { password: "test-password" },
  });
  const cookie = login.headers["set-cookie"]!.toString().split(";")[0];
  return {
    provider,
    app,
    origin,
    cookie,
    headers: { origin, host: `127.0.0.1:${address.port}`, cookie },
  };
}
test("host permissions, CSRF and key protection, one processing session", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject("/api/status")).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/session",
          headers: { cookie: f.cookie },
          payload: { target: "en", key: "testsecret" },
        })
      ).statusCode,
      403,
    );
    const start = await f.app.inject({
      method: "POST",
      url: "/api/session",
      headers: f.headers,
      payload: { target: "en", key: "testsecret" },
    });
    assert.equal(start.statusCode, 200);
    assert.ok(!start.body.includes("testsecret"));
    assert.equal(f.provider.connections, 1);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/session",
          headers: f.headers,
          payload: { target: "en", key: "testsecret" },
        })
      ).statusCode,
      500,
    );
    assert.equal(f.provider.connections, 1);
    const status = await f.app.inject({
      url: "/api/status",
      headers: f.headers,
    });
    assert.ok(!status.body.includes("testsecret"));
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/stop",
          headers: f.headers,
          payload: {},
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.app.close();
  }
});
test("viewer snapshot reconnect, no new provider connection, read-only socket", async () => {
  const f = await fixture();
  try {
    const result = await f.app.inject({
      method: "POST",
      url: "/api/session",
      headers: f.headers,
      payload: { target: "en", key: "testsecret" },
    });
    const token = result.json().viewerUrl.split("#")[1];
    const connect = () =>
      new WebSocket(
        `${f.origin.replace("http", "ws")}/ws/viewer?token=${token}`,
        { headers: { Origin: f.origin } },
      );
    for (let i = 0; i < 2; i++) {
      const ws = connect();
      const snapshot = await new Promise<string>((resolve, reject) => {
        ws.once("message", (raw) => resolve(raw.toString()));
        ws.once("error", reject);
      });
      assert.equal(JSON.parse(snapshot).room.target, "en");
      ws.send("attempt mutation");
      await new Promise<void>((resolve) =>
        ws.once("close", (code) => {
          assert.equal(code, 1008);
          resolve();
        }),
      );
    }
    assert.equal(f.provider.connections, 1);
  } finally {
    await f.app.close();
  }
});
test("plain LAN administration is rejected", async () => {
  const { app } = await createApp(new MockProvider(), {
    HOST_PASSWORD: "test",
    LOG_LEVEL: "silent",
  });
  try {
    const r = await app.inject({
      method: "POST",
      url: "/api/login",
      remoteAddress: "192.168.1.5",
      headers: { host: "192.168.1.2", origin: "http://192.168.1.2" },
      payload: { password: "test" },
    });
    assert.equal(r.statusCode, 403);
  } finally {
    await app.close();
  }
});
test("speaker correction survives provider revisions and stale partial cannot replace final", async () => {
  const f = await fixture();
  try {
    await f.app.inject({
      method: "POST",
      url: "/api/session",
      headers: f.headers,
      payload: { target: "en", key: "testsecret" },
    });
    const segment = {
      id: "caption",
      revision: 1,
      final: false,
      original: "Hallo",
      translated: "",
      targetLanguage: "en",
      speakerId: "1",
      channel: "original" as const,
    };
    f.provider.callbacks!.segment({ ...segment });
    await f.app.inject({
      method: "POST",
      url: "/api/speaker",
      headers: f.headers,
      payload: { id: "2", name: "Maria", segmentId: "caption" },
    });
    f.provider.callbacks!.segment({
      ...segment,
      revision: 2,
      original: "Hallo Welt",
    });
    let status = (
      await f.app.inject({ url: "/api/status", headers: f.headers })
    ).json();
    assert.equal(status.room.segments[0].speakerId, "2");
    assert.equal(status.room.segments[0].original, "Hallo Welt");
    f.provider.callbacks!.segment({ ...segment, revision: 3, final: true });
    f.provider.callbacks!.segment({
      ...segment,
      revision: 4,
      original: "stale",
    });
    status = (
      await f.app.inject({ url: "/api/status", headers: f.headers })
    ).json();
    assert.equal(status.room.segments[0].final, true);
    assert.equal(status.room.segments[0].original, "Hallo");
  } finally {
    await f.app.close();
  }
});
test("API noncanonical URLs never bypass authorization", async () => {
  const { app } = await createApp(new MockProvider(), {
    HOST_PASSWORD: "test",
    LOG_LEVEL: "silent",
  });
  try {
    for (const url of [
      "/%61pi/status",
      "/api%2fstatus",
      "/api/../api/status",
      "/api//status",
    ]) {
      const response = await app.inject({ url });
      assert.notEqual(response.statusCode, 200, `${url} must be rejected`);
    }
  } finally {
    await app.close();
  }
});

test("opt-in persistence saves transcript without key and authenticated deletion removes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linguaroom-storage-"));
  const f = await fixture({ DATA_DIR: dir });
  try {
    const started = await f.app.inject({
      method: "POST",
      url: "/api/session",
      headers: f.headers,
      payload: { target: "en", key: "synthetic-storage-key", save: true },
    });
    const id = started.json().room.id;
    f.provider.callbacks!.segment({
      id: "stored",
      revision: 1,
      final: true,
      original: "Hola",
      translated: "",
      sourceLanguage: "es",
      targetLanguage: "en",
      channel: "original",
      startMs: 0,
      endMs: 400,
    });
    await f.app.inject({
      method: "POST",
      url: "/api/stop",
      headers: f.headers,
      payload: {},
    });
    const stored = await readFile(join(dir, `${id}.json`), "utf8");
    assert.match(stored, /Hola/);
    assert.ok(!stored.includes("synthetic-storage-key"));
    const removed = await f.app.inject({
      method: "DELETE",
      url: `/api/saved/${id}`,
      headers: f.headers,
    });
    assert.equal(removed.statusCode, 200);
    await assert.rejects(() => readFile(join(dir, `${id}.json`)));
  } finally {
    await f.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("host WebSocket requires cookie and matching Origin; invalid viewer token is rejected", async () => {
  const f = await fixture();
  try {
    for (const [path, origin, cookie] of [
      ["/ws/host", f.origin, ""],
      ["/ws/host", "http://foreign.example", f.cookie],
      ["/ws/viewer?token=invalid", f.origin, ""],
    ]) {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${f.origin.replace("http", "ws")}${path}`, {
          headers: { Origin: origin, Cookie: cookie },
        });
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("Handshake rejection timeout"));
        }, 5000);
        ws.once("open", () => {
          clearTimeout(timer);
          ws.close();
          reject(new Error("Unauthorized socket accepted"));
        });
        ws.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    assert.equal(f.provider.connections, 0);
  } finally {
    await f.app.close();
  }
});
