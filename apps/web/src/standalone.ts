import type { Snapshot, Start } from "../../../packages/shared/protocol";
import {
  Normalizer,
  responseSchema,
} from "../../server/src/providers/soniox/normalizer";

/** Device-owned session; no application server or credentials are involved. */
export class StandaloneSession {
  room: Snapshot | null = null;
  socket?: WebSocket;
  private keepalive?: ReturnType<typeof setInterval>;
  private limit?: ReturnType<typeof setTimeout>;
  constructor(
    private update: (room: Snapshot) => void,
    private notice: (message: string) => void,
    private ended: () => void,
  ) {}
  private publish() {
    if (this.room) this.update(this.room);
  }
  async start(options: Start) {
    if (this.socket) throw new Error("Stop the current session first.");
    if (!options.key) throw new Error("Enter your Soniox API key.");
    const ws = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket", [
      "soniox-api-key",
      options.key,
    ]);
    this.socket = ws;
    this.room = {
      id: crypto.randomUUID(),
      name: options.name,
      target: options.target,
      state: "connecting",
      segments: [],
      speakers: {},
      startedAt: new Date().toISOString(),
      metrics: {},
    };
    const room = this.room;
    const normalizer = new Normalizer(options.target, room.id);
    let ending = false;
    this.publish();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Soniox connection timed out."));
      }, 10000);
      ws.onopen = () => {
        clearTimeout(timeout);
        ws.send(
          JSON.stringify({
            model: "stt-rt-v5",
            audio_format: "pcm_s16le",
            sample_rate: 16000,
            num_channels: 1,
            enable_language_identification: true,
            enable_speaker_diarization: options.diarization,
            enable_endpoint_detection: options.endpoint,
            translation: { type: "one_way", target_language: options.target },
          }),
        );
        room.state = "connected";
        this.publish();
        this.keepalive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "keepalive" }));
        }, 15000);
        this.limit = setTimeout(() => {
          this.notice("Session time limit reached. Start a new meeting.");
          void this.stop();
        }, 295 * 60000);
        resolve();
      };
      ws.onmessage = (event) => {
        try {
          const data = responseSchema.parse(JSON.parse(event.data));
          if (data.error_code) {
            this.notice(
              `Soniox ${data.error_code}: ${data.error_type ?? "provider_error"}. Check your key, quota and payment.`,
            );
            ws.close();
            return;
          }
          for (const segment of normalizer.accept(data)) {
            const index = room.segments.findIndex((s) => s.id === segment.id);
            if (index < 0) room.segments.push(segment);
            else room.segments[index] = segment;
          }
          room.segments = room.segments.slice(-10000);
          room.metrics.processedAudioMs = data.total_audio_proc_ms ?? 0;
          this.publish();
          if (data.finished) {
            ending = true;
            ws.close();
          }
        } catch {
          this.notice("Invalid Soniox response. Restart the meeting.");
          ws.close();
        }
      };
      ws.onerror = () => {
        this.notice(
          "Soniox connection failed. Check internet access and API key.",
        );
        reject(new Error("Unable to connect to Soniox."));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        clearInterval(this.keepalive);
        clearTimeout(this.limit);
        if (this.socket === ws) this.socket = undefined;
        room.state =
          ending || room.state === "ending" ? "ended" : "disconnected";
        this.ended();
        this.publish();
        reject(
          new Error(
            "Soniox connection closed. Check your API key and restart.",
          ),
        );
      };
    });
    return { room };
  }
  audio(pcm: ArrayBuffer) {
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.socket.bufferedAmount < 32000
    )
      this.socket.send(pcm);
    else this.notice("Audio connection unavailable or behind; audio dropped.");
  }
  async stop() {
    const ws = this.socket;
    if (!ws) return;
    if (this.room) this.room.state = "ending";
    clearInterval(this.keepalive);
    clearTimeout(this.limit);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send("");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          ws.close();
          resolve();
        }, 5000);
        ws.addEventListener(
          "close",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    } else ws.close();
  }
}
