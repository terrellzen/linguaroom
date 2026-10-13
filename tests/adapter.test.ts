import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { SonioxProvider } from "../apps/server/src/providers/soniox/provider.js";
import { startSchema, type Segment } from "../packages/shared/protocol.js";
test("real adapter sends bearer header, PCM binary, normalized results and empty-text termination", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const messages: string[] = [];
  const segments: Segment[] = [];
  let auth = "";
  let binary = false;
  const errors: string[] = [];
  server.on("connection", (ws, req) => {
    auth = req.headers.authorization ?? "";
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        binary = true;
        ws.send(
          JSON.stringify({
            tokens: [
              {
                text: "Hola",
                is_final: true,
                speaker: "1",
                language: "es",
                start_ms: 0,
                end_ms: 400,
              },
              { text: "<end>", is_final: true },
              {
                text: "Hello",
                is_final: true,
                translation_status: "translation",
                language: "en",
                source_language: "es",
                speaker: "1",
              },
            ],
          }),
        );
      } else {
        messages.push(raw.toString());
        if (raw.toString() === "") {
          ws.send(JSON.stringify({ tokens: [], finished: true }));
          ws.close();
        }
      }
    });
  });
  try {
    const provider = new SonioxProvider(`ws://127.0.0.1:${address.port}`);
    const stream = await provider.create(
      "synthetic-secret",
      startSchema.parse({ target: "en" }),
      {
        segment: (s) => segments.push(s),
        state() {},
        error(m) {
          errors.push(m);
        },
        usage() {},
      },
    );
    assert.equal(stream.audio(Buffer.alloc(160002)), false);
    assert.match(errors[0], /backlog/);
    assert.equal(stream.audio(Buffer.alloc(3200)), true);
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (segments.length >= 2) {
          clearInterval(poll);
          resolve();
        }
      }, 5);
    });
    await stream.end();
    assert.equal(auth, "Bearer synthetic-secret");
    assert.equal(binary, true);
    assert.ok(!messages[0].includes("secret"));
    assert.equal(messages.at(-1), "");
    assert.equal(segments[0].original, "Hola");
    assert.equal(segments.at(-1)?.translated, "Hello");
    assert.equal(segments.at(-1)?.final, true);
    assert.equal(stream.audio(Buffer.alloc(10)), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("adapter rejects an unauthorized WebSocket handshake without credential leakage", async () => {
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: () => false,
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  try {
    await assert.rejects(
      () =>
        new SonioxProvider(`ws://127.0.0.1:${address.port}`).create(
          "synthetic-secret",
          startSchema.parse({ target: "en" }),
          { segment() {}, state() {}, error() {}, usage() {} },
        ),
      /rejected|connect/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test(
  "optional live Soniox connection (explicit opt-in, may incur charges)",
  { skip: process.env.RUN_LIVE_SONIOX !== "1" || !process.env.SONIOX_TEST_KEY },
  async () => {
    let failed = "";
    const stream = await new SonioxProvider().create(
      process.env.SONIOX_TEST_KEY!,
      startSchema.parse({ target: "en" }),
      {
        segment() {},
        state() {},
        error(m) {
          failed = m;
        },
        usage() {},
      },
    );
    stream.audio(Buffer.alloc(3200));
    await stream.end();
    assert.equal(failed, "");
  },
);
