import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import {
  languages,
  type Start,
} from "../../../../../packages/shared/protocol.js";
import type {
  SpeechProvider,
  ProviderCallbacks,
  SpeechStream,
} from "../speech-provider.js";
import { Normalizer, responseSchema } from "./normalizer.js";
export function configuration(o: Start) {
  return {
    model: "stt-rt-v5",
    audio_format: "pcm_s16le",
    sample_rate: 16000,
    num_channels: 1,
    enable_language_identification: true,
    enable_speaker_diarization: o.diarization,
    enable_endpoint_detection: o.endpoint,
    translation: { type: "one_way", target_language: o.target },
  };
}
export class SonioxProvider implements SpeechProvider {
  readonly id = "soniox";
  constructor(
    private endpoint = "wss://stt-rt.soniox.com/transcribe-websocket",
  ) {}
  capabilities() {
    return { translation: true, diarization: true, languages };
  }
  async initialize() {}
  async create(
    key: string,
    options: Start,
    cb: ProviderCallbacks,
  ): Promise<SpeechStream> {
    const ws = new WebSocket(this.endpoint, {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 10000,
      maxPayload: 2 * 1024 * 1024,
    });
    key = "";
    const normalizer = new Normalizer(options.target, randomUUID());
    let ending = false;
    let timer: NodeJS.Timeout | undefined;
    let rotation: NodeJS.Timeout | undefined;
    const began = Date.now();
    let first = true;
    let firstFinal = true;
    let audioBegan: number | undefined;
    ws.on("message", (raw) => {
      try {
        const response = responseSchema.parse(JSON.parse(raw.toString()));
        if (response.error_code) {
          cb.error(
            `Soniox ${response.error_code}: ${response.error_type ?? "provider_error"}. Check credentials, quota or payment; restart the session.`,
          );
          ws.close();
          return;
        }
        for (const s of normalizer.accept(response)) {
          if (first) {
            cb.usage({
              timeToFirstResultMs: Date.now() - (audioBegan ?? began),
            });
            first = false;
          }
          if (s.final && firstFinal) {
            cb.usage({
              timeToFirstFinalResultMs: Date.now() - (audioBegan ?? began),
            });
            firstFinal = false;
          }
          cb.segment(s);
        }
        cb.usage({
          processedAudioMs: response.total_audio_proc_ms ?? 0,
          finalAudioMs: response.final_audio_proc_ms ?? 0,
          providerQueueBytes: ws.bufferedAmount,
        });
        if (response.finished) {
          ending = true;
          ws.close();
        }
      } catch {
        cb.error("Invalid provider response");
        ws.close();
      }
    });
    ws.on("error", () =>
      cb.error(
        "Soniox connection failed. Check internet and API credentials. Some audio may be lost.",
      ),
    );
    ws.on("close", () => {
      clearInterval(timer);
      clearTimeout(rotation);
      cb.state(ending ? "ended" : "disconnected");
      if (!ending)
        cb.error(
          "Provider disconnected; audio may be lost. Stop and start to reconnect without duplicate paid streams.",
        );
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(JSON.stringify(configuration(options)));
        cb.state("connected");
        timer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "keepalive" }));
        }, 15000);
        rotation = setTimeout(() => {
          cb.error("Approaching Soniox 300-minute limit. Start a new session.");
          ending = true;
          ws.send("");
        }, 295 * 60000);
        resolve();
      });
      ws.once("close", () =>
        reject(new Error("Provider closed during connection")),
      );
      ws.once("error", () => reject(new Error("Unable to connect to Soniox")));
      ws.once("unexpected-response", (_req, res) => {
        res.resume();
        ws.terminate();
        reject(
          new Error(
            `Soniox authentication/connection rejected (${res.statusCode})`,
          ),
        );
      });
    });
    return {
      audio(data) {
        if (ws.readyState !== WebSocket.OPEN || ending) return false;
        if (ws.bufferedAmount + data.length > 160000) {
          cb.error("Audio backlog exceeded five seconds; dropping audio.");
          return false;
        }
        audioBegan ??= Date.now();
        ws.send(data);
        return true;
      },
      async end() {
        ending = true;
        clearInterval(timer);
        clearTimeout(rotation);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("");
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              ws.terminate();
              resolve();
            }, 5000);
            ws.once("close", () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        } else ws.terminate();
      },
    };
  }
}
