import workletUrl from "./pcm-worklet.js?url";
// Browser permission and audio activation promises can remain pending indefinitely.
async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 30000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class Microphone {
  private context?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private receivedBytes = 0;
  private receivedChunks = 0;
  private peakLevel = 0;
  async start(
    deviceId: string,
    send: (pcm: ArrayBuffer, level: number) => void,
    onInterrupt: (message: string) => void,
    progress: (message: string) => void = () => {},
  ) {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext)
      throw new Error(
        "Microphone needs localhost or trusted HTTPS. Check certificate trust and browser permissions.",
      );
    if (this.context)
      throw new Error("Microphone is already starting or active.");
    try {
      progress("Waiting for microphone permission…");
      // Activate audio synchronously during the Start button gesture, before
      // permission prompts or worklet loading can consume user activation.
      this.context = new AudioContext();
      this.receivedBytes = 0;
      this.receivedChunks = 0;
      this.peakLevel = 0;
      const ready = withTimeout(
        this.context.resume(),
        "Audio activation timed out. Keep this tab visible and retry.",
        20000,
      );
      void ready.catch(() => {});
      let acceptingStream = true;
      const requestedStream = navigator.mediaDevices
        .getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        })
        .then((stream) => {
          if (!acceptingStream)
            stream.getTracks().forEach((track) => track.stop());
          return stream;
        });
      try {
        this.stream = await withTimeout(
          requestedStream,
          "Microphone permission timed out. Allow microphone access in Firefox and Android settings, then tap Start meeting again.",
        );
      } finally {
        acceptingStream = false;
      }
      // Match the working Termux version: do not load or construct a worklet
      // until the playback engine has finished starting.
      progress("Activating microphone audio…");
      await ready;
      progress("Loading microphone audio processing…");
      if (!this.context.audioWorklet)
        throw new Error(
          "This browser requires AudioWorklet support; use current Chrome, Firefox, or Safari.",
        );
      await withTimeout(
        this.context.audioWorklet.addModule(workletUrl),
        "Microphone audio processing could not load. Reload the page and try again.",
      );
      this.node = new AudioWorkletNode(this.context, "pcm-processor");
      let receivedAudio!: () => void;
      const firstFrame = new Promise<void>((resolve) => {
        receivedAudio = resolve;
      });
      this.node.port.onmessage = (e) => {
        this.receivedBytes += e.data.pcm.byteLength;
        this.receivedChunks++;
        this.peakLevel = Math.max(this.peakLevel, e.data.level);
        receivedAudio();
        send(e.data.pcm, e.data.level);
      };
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.node);
      const mute = this.context.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(this.context.destination);
      this.stream.getAudioTracks().forEach((t) => {
        t.onended = () => onInterrupt("Microphone ended. Restart capture.");
        t.onmute = () =>
          onInterrupt("Microphone interrupted; audio may be lost.");
      });
      this.context.onstatechange = () => {
        if (this.context?.state === "suspended")
          onInterrupt("Audio capture suspended by browser. Resume capture.");
      };
      if (this.context.state !== "running")
        throw new Error("Audio is suspended. Keep this tab visible and retry.");
      progress("Waiting for microphone samples…");
      await withTimeout(
        firstFrame,
        "Microphone opened, but Firefox did not deliver audio. Keep this tab visible, stop other audio or calls, then retry. If it persists, fully close and reopen Firefox.",
      );
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  diagnostics() {
    const track = this.stream?.getAudioTracks()[0];
    return {
      contextState: this.context?.state ?? "closed",
      sampleRate: this.context?.sampleRate,
      trackState: track?.readyState,
      trackMuted: track?.muted,
      receivedBytes: this.receivedBytes,
      receivedChunks: this.receivedChunks,
      peakLevel: this.peakLevel,
    };
  }

  async pause() {
    await this.context?.suspend();
  }
  async resume() {
    await this.context?.resume();
  }
  async stop() {
    // Detach ownership before awaiting close: a delayed close from an old
    // session must never clear the resources belonging to a newer session.
    const { context, node, source, stream } = this;
    this.context = undefined;
    this.stream = undefined;
    this.node = undefined;
    this.source = undefined;
    if (context) context.onstatechange = null;
    if (node) node.port.onmessage = null;
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.onmute = null;
      track.stop();
    });
    node?.disconnect();
    source?.disconnect();
    if (context && context.state !== "closed") {
      // Some mobile audio backends never settle close(). Capture has already
      // been released, so cleanup must not hide startup errors or block retry.
      await withTimeout(
        context.close(),
        "Audio cleanup timed out.",
        2000,
      ).catch(() => {});
    }
  }
}
