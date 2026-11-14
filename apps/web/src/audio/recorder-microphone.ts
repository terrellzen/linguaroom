/** Native encoded capture for direct-to-Soniox sessions; no playback context. */
export class RecorderMicrophone {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private pending: Blob[] = [];
  private pendingBytes = 0;
  private send?: (audio: Blob, level: number) => void;
  private live = false;
  private generation = 0;

  static supportedMimeType() {
    return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"].find(
      (type) =>
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(type),
    );
  }

  async start(
    deviceId: string,
    send: (audio: Blob, level: number) => void,
    onInterrupt: (message: string) => void,
    progress: (message: string) => void = () => {},
  ) {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext)
      throw new Error("Microphone needs localhost or trusted HTTPS.");
    if (this.recorder || this.stream)
      throw new Error("Microphone is already starting or active.");
    const mimeType = RecorderMicrophone.supportedMimeType();
    if (!mimeType)
      throw new Error(
        "This browser cannot stream WebM or Ogg microphone audio.",
      );
    this.generation++;
    let accepting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      progress("Waiting for microphone permission…");
      const requested = navigator.mediaDevices
        .getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        })
        .then((stream) => {
          if (!accepting) stream.getTracks().forEach((track) => track.stop());
          return stream;
        });
      try {
        this.stream = await Promise.race([
          requested,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Microphone permission timed out. Check microphone access and retry.",
                  ),
                ),
              30000,
            );
          }),
        ]);
      } finally {
        accepting = false;
        clearTimeout(timer);
      }
      this.send = send;
      this.stream.getAudioTracks().forEach((track) => {
        track.onended = () => onInterrupt("Microphone ended. Restart capture.");
        track.onmute = () =>
          onInterrupt("Microphone interrupted; audio may be lost.");
      });
      const recorder = new MediaRecorder(this.stream, {
        mimeType,
        audioBitsPerSecond: 64000,
      });
      this.recorder = recorder;
      progress("Starting native microphone recording…");
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          const track = this.stream?.getAudioTracks()[0];
          reject(
            new Error(
              `Native microphone produced no audio (recorder: ${recorder.state}, track: ${track?.readyState ?? "missing"}, muted: ${track?.muted ?? "unknown"}).`,
            ),
          );
        }, 10000);
        recorder.onerror = () => {
          const message =
            "Native microphone recording failed. Restart the meeting.";
          reject(new Error(message));
          onInterrupt(message);
        };
        recorder.ondataavailable = ({ data }) => {
          if (!data.size) return;
          if (this.live) this.send?.(data, 0);
          else {
            // Keep the first container header and all following chunks until
            // the provider socket is ready. Dropping that header corrupts audio.
            if (this.pendingBytes + data.size > 128000) {
              const message =
                "Audio connection took too long. Stop and restart the meeting.";
              reject(new Error(message));
              onInterrupt(message);
              void this.stop();
              return;
            }
            this.pending.push(data);
            this.pendingBytes += data.size;
          }
          resolve();
        };
        recorder.start(100);
      });
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Release the preserved container header only after Soniox is connected. */
  commit() {
    if (!this.recorder || this.recorder.state === "inactive")
      throw new Error(
        "Microphone stopped before the audio connection was ready. Restart the meeting.",
      );
    this.live = true;
    for (const data of this.pending) this.send?.(data, 0);
    this.pending = [];
    this.pendingBytes = 0;
  }

  async pause() {
    if (this.recorder?.state === "recording") this.recorder.pause();
  }
  async resume() {
    if (this.recorder?.state === "paused") this.recorder.resume();
  }
  async stop() {
    const { recorder, stream, send, live, generation } = this;
    this.recorder = undefined;
    this.stream = undefined;
    this.pending = [];
    this.pendingBytes = 0;
    this.live = false;
    this.send = undefined;
    if (recorder) {
      // Final chunks belong to this session, even if a new capture starts
      // while its stop event is pending.
      recorder.ondataavailable = ({ data }) => {
        if (live && data.size && this.generation === generation)
          send?.(data, 0);
      };
    }
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        recorder.onstop = () => {
          clearTimeout(timer);
          resolve();
        };
        recorder.stop();
      });
    }
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    }
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.onmute = null;
      track.stop();
    });
  }
}
