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
  private stopping?: Promise<void>;
  private health?: ReturnType<typeof setInterval>;
  private paused = false;
  constructor(
    private update: (room: Snapshot) => void,
    private notice: (message: string) => void,
    private ended: () => void,
  ) {}
  private publish() {
    if (this.room) this.update(this.room);
  }
  async start(options: Start) {
    await this.stopping;
    if (this.socket) throw new Error("Stop the current session first.");
    if (!options.key) throw new Error("Enter your Soniox API key.");
    const ws = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket", [
      "soniox-api-key",
      options.key,
    ]);
    this.socket = ws;
    this.paused = false;
    this.room = {
      id: crypto.randomUUID(),
      name: options.name,
      target: options.target,
      state: "connecting",
      segments: [],
      speakers: {},
      startedAt: new Date().toISOString(),
      metrics: {
        audioBytesSent: 0,
        audioChunksSent: 0,
        processedAudioMs: 0,
        audioConfirmed: 0,
      },
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
        if (this.socket !== ws) return;
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
        let warned = "";
        this.health = setInterval(() => {
          if (this.socket !== ws || this.paused || room.state !== "connected")
            return;
          this.publish();
          const firstSent = room.metrics.firstAudioSentAt;
          if (!firstSent || Date.now() - firstSent < 8000) return;
          const message =
            Date.now() - room.metrics.lastAudioSentAt > 5000
              ? "Microphone stopped sending audio. Stop and restart the meeting."
              : !room.metrics.audioConfirmed
                ? "Audio is being sent, but Soniox has not confirmed processing. Check Settings → Audio diagnostics."
                : "";
          if (message && message !== warned) this.notice(message);
          warned = message;
        }, 1000);
        resolve();
      };
      ws.onmessage = (event) => {
        if (this.socket !== ws) return;
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
          room.metrics.providerResponses =
            (room.metrics.providerResponses ?? 0) + 1;
          room.metrics.processedAudioMs =
            data.total_audio_proc_ms ?? room.metrics.processedAudioMs;
          if (
            !room.metrics.audioConfirmed &&
            (room.metrics.processedAudioMs > 0 || room.segments.length > 0)
          ) {
            room.metrics.audioConfirmed = 1;
            if (!this.paused)
              this.notice("Meeting live. Audio is being processed by Soniox.");
          }
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
        if (this.socket !== ws) return;
        this.notice(
          "Soniox connection failed. Check internet access and API key.",
        );
        reject(new Error("Unable to connect to Soniox."));
      };
      ws.onclose = () => {
        if (this.socket !== ws) return;
        clearTimeout(timeout);
        clearInterval(this.keepalive);
        clearTimeout(this.limit);
        clearInterval(this.health);
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
      this.room?.state === "connected" &&
      this.socket?.readyState === WebSocket.OPEN &&
      this.socket.bufferedAmount + pcm.byteLength <= 32000
    ) {
      this.socket.send(pcm);
      const metrics = this.room.metrics;
      metrics.audioBytesSent += pcm.byteLength;
      metrics.audioChunksSent++;
      metrics.firstAudioSentAt ||= Date.now();
      metrics.lastAudioSentAt = Date.now();
    } else {
      // End a stalled transport instead of displaying a silently broken meeting.
      this.notice(
        "Audio connection unavailable or behind. Restart the meeting.",
      );
      void this.stop();
    }
  }
  setPaused(paused: boolean) {
    this.paused = paused;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = this.finish();
    this.stopping = stopping;
    const cleared = () => {
      if (this.stopping === stopping) this.stopping = undefined;
    };
    void stopping.then(cleared, cleared);
    return stopping;
  }

  private async finish() {
    const ws = this.socket;
    if (!ws || this.room?.state === "ending") return;
    if (this.room) this.room.state = "ending";
    clearInterval(this.keepalive);
    clearTimeout(this.limit);
    clearInterval(this.health);
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
    // A mobile socket can remain CLOSING after the close deadline. Retire its
    // ownership now; late callbacks must not stop a later microphone session.
    if (this.socket === ws) {
      this.socket = undefined;
      if (this.room) this.room.state = "ended";
      this.ended();
      this.publish();
    }
  }
}
