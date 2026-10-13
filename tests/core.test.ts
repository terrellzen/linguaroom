import { test } from "node:test";
import assert from "node:assert/strict";
import { Normalizer } from "../apps/server/src/providers/soniox/normalizer.js";
import { configuration } from "../apps/server/src/providers/soniox/provider.js";
import { config } from "../apps/server/src/config.js";
import { exportTranscript } from "../apps/server/src/export.js";
import { startSchema, type Snapshot } from "../packages/shared/protocol.js";
import { readFileSync } from "node:fs";
test("documented Soniox configuration never contains API key", () => {
  const c = configuration(
    startSchema.parse({ key: "secret1234", target: "bg" }),
  );
  assert.equal(c.model, "stt-rt-v5");
  assert.equal(c.audio_format, "pcm_s16le");
  assert.equal(c.sample_rate, 16000);
  assert.deepEqual(c.translation, { type: "one_way", target_language: "bg" });
  assert.ok(!JSON.stringify(c).includes("secret"));
});
test("partial replacement and final deltas do not duplicate words", () => {
  const n = new Normalizer("en", "s");
  const a = n.accept({
    tokens: [{ text: "Hel", is_final: false, language: "de", speaker: "1" }],
  })[0];
  const b = n.accept({
    tokens: [{ text: "Hello", is_final: true, language: "de", speaker: "1" }],
  })[0];
  assert.equal(a.id, b.id);
  assert.ok(b.revision > a.revision);
  assert.equal(b.original, "Hello");
  assert.equal(b.final, false);
  const c = n.accept({
    tokens: [{ text: " world", is_final: false, language: "de", speaker: "1" }],
  })[0];
  assert.equal(c.original, "Hello world");
  assert.equal(c.final, false);
});
test("translation has independent IDs and no fabricated timing", () => {
  const n = new Normalizer("en", "s");
  const result = n.accept({
    tokens: [
      {
        text: "Здравей",
        is_final: true,
        language: "bg",
        speaker: "2",
        start_ms: 0,
        end_ms: 600,
      },
      {
        text: "Hello",
        is_final: false,
        translation_status: "translation",
        source_language: "bg",
        language: "en",
        speaker: "2",
      },
    ],
  });
  assert.equal(result.length, 2);
  assert.equal(result[1].translated, "Hello");
  assert.equal(result[1].startMs, undefined);
  assert.equal(result[1].speakerId, "2");
  assert.notEqual(result[0].id, result[1].id);
});
test("synthetic multilingual fixtures preserve metadata", () => {
  for (const [language, text] of [
    ["bg", "Здравей"],
    ["de", "Hallo"],
    ["es", "Hola"],
    ["ja", "こんにちは"],
    ["en", "Hello"],
  ]) {
    const n = new Normalizer("en", language);
    assert.equal(
      n.accept({
        tokens: [{ text, is_final: true, language, speaker: "15" }],
      })[0].original,
      text,
    );
  }
});
test("repeated provisional snapshot emits no update", () => {
  const n = new Normalizer("en", "s");
  const r = { tokens: [{ text: "hola", is_final: false }] };
  n.accept(r);
  assert.deepEqual(n.accept(r), []);
});
test("config validates TLS pair, LAN binding, ports and reverse proxy", () => {
  assert.equal(config({}).BIND, "127.0.0.1");
  assert.equal(config({ BIND: "0.0.0.0" }).BIND, "0.0.0.0");
  assert.throws(() => config({ PORT: "70000" }));
  assert.throws(() => config({ TLS_CERT: "cert" }));
  assert.throws(() => config({ TRUST_PROXY: "true" }));
  assert.equal(
    config({ PUBLIC_ORIGIN: "", TLS_CERT: "", TLS_KEY: "" }).https,
    undefined,
  );
});
test("exports refuse untimed SRT and never contain credentials", () => {
  const room: Snapshot = {
    id: "s",
    name: "test",
    state: "ended",
    target: "en",
    segments: [
      {
        id: "a",
        revision: 1,
        final: true,
        original: "",
        translated: "Hello",
        targetLanguage: "en",
        channel: "translation",
      },
    ],
    speakers: {},
    startedAt: "2026-01-01",
    metrics: {},
  };
  assert.throws(() => exportTranscript(room, "srt"), /timestamps/);
  assert.match(exportTranscript(room, "txt"), /Hello/);
  room.segments.push({
    id: "b",
    revision: 1,
    final: true,
    original: "Hola",
    translated: "",
    targetLanguage: "en",
    startMs: 1000,
    endMs: 2000,
    channel: "original",
  });
  assert.match(exportTranscript(room, "srt"), /00:00:01,000 --> 00:00:02,000/);
  assert.ok(!exportTranscript(room, "json").includes("key"));
});
test("deployment files share production entry and avoid privileged audio", () => {
  for (const file of ["Containerfile", "scripts/start-termux.sh"])
    assert.match(
      readFileSync(file, "utf8"),
      /dist\/apps\/server\/src\/main.js/,
    );
  assert.match(readFileSync("Containerfile", "utf8"), /USER node/);
  assert.doesNotMatch(
    readFileSync("compose.yaml", "utf8"),
    /privileged: true|\/dev\/snd/,
  );
  for (const name of ["install", "start", "update", "diagnose"])
    assert.ok(
      readFileSync(`scripts/${name}-termux.sh`, "utf8").includes(
        "set -euo pipefail",
      ),
    );
});
test("endpoint seals stable caption and next utterance uses fresh ID", () => {
  const n = new Normalizer("en", "s");
  const first = n.accept({ tokens: [{ text: "Hallo", is_final: false }] })[0];
  const final = n.accept({
    tokens: [
      { text: "Hallo", is_final: true },
      { text: "<end>", is_final: true },
    ],
  })[0];
  assert.equal(first.id, final.id);
  assert.equal(final.final, true);
  const next = n.accept({ tokens: [{ text: "Hola", is_final: false }] })[0];
  assert.notEqual(next.id, final.id);
});
test("revised provisional speakers do not leave stale caption text", () => {
  const n = new Normalizer("en", "s");
  n.accept({
    tokens: [
      { text: "one", is_final: false, speaker: "1" },
      { text: "two", is_final: false, speaker: "2" },
    ],
  });
  const revised = n.accept({
    tokens: [{ text: "one two", is_final: false, speaker: "1" }],
  });
  assert.equal(revised[0].original, "one two");
  assert.equal(revised[1].original, "");
});
test("a vanished provisional ID can return with a newer revision", () => {
  const n = new Normalizer("en", "s");
  const original = n.accept({
    tokens: [
      { text: "one", is_final: false, speaker: "1" },
      { text: "two", is_final: false, speaker: "2" },
    ],
  })[1];
  const cleared = n
    .accept({ tokens: [{ text: "one", is_final: false, speaker: "1" }] })
    .find((s) => s.id === original.id)!;
  const returned = n
    .accept({
      tokens: [
        { text: "one", is_final: false, speaker: "1" },
        { text: "three", is_final: false, speaker: "3" },
      ],
    })
    .find((s) => s.id === original.id)!;
  assert.ok(returned.revision > cleared.revision);
  assert.equal(returned.original, "three");
});
