import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
test("actual worklet resamples 48k PCM across quanta to 16k little endian with bounded frames", () => {
  const messages: { pcm: ArrayBuffer; level: number }[] = [];
  let Processor: new () => { process(inputs: Float32Array[][]): boolean };
  class Base {
    port = {
      postMessage: (message: { pcm: ArrayBuffer; level: number }) =>
        messages.push(message),
    };
  }
  vm.runInNewContext(
    readFileSync("apps/web/src/audio/pcm-worklet.js", "utf8"),
    {
      AudioWorkletProcessor: Base,
      sampleRate: 48000,
      registerProcessor: (_name: string, p: typeof Processor) => {
        Processor = p;
      },
    },
  );
  const processor = new Processor!();
  for (let i = 0; i < 75; i++)
    processor.process([[new Float32Array(128).fill(0.5)]]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].pcm.byteLength, 3200);
  assert.equal(new DataView(messages[0].pcm).getInt16(0, true), 16384);
  assert.equal(messages[0].level, 0.5);
});
test("worklet carries fractional resampling phase at 44.1k", () => {
  const messages: { pcm: ArrayBuffer }[] = [];
  let Processor: new () => { process(inputs: Float32Array[][]): boolean };
  class Base {
    port = { postMessage: (m: { pcm: ArrayBuffer }) => messages.push(m) };
  }
  vm.runInNewContext(
    readFileSync("apps/web/src/audio/pcm-worklet.js", "utf8"),
    {
      AudioWorkletProcessor: Base,
      sampleRate: 44100,
      registerProcessor: (_n: string, p: typeof Processor) => {
        Processor = p;
      },
    },
  );
  const processor = new Processor!();
  for (let i = 0; i < 345; i++)
    processor.process([[new Float32Array(128).fill(-1)]]);
  assert.equal(messages.length, 10);
  assert.equal(new DataView(messages[0].pcm).getInt16(0, true), -32768);
});
