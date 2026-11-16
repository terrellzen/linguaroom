import workletUrl from "./pcm-worklet.js?url";
// Browser permission and audio activation promises can remain pending indefinitely.
async function withTimeout<T>(
  promise: Promise<T>,
  message: string | Error,
  timeoutMs = 30000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(typeof message === "string" ? new Error(message) : message),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class AudioActivationTimeout extends Error {}

export class Microphone {
  private context?: AudioContext;
  private module?: Promise<void>;
  private starting = false;
  private stopping?: Promise<void>;
  private mute?: GainNode;
  private contextCount = 0;
  private startCount = 0;
  private activationResets = 0;
  private activationTaps = 0;
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
    requestActivation?: (resume: () => Promise<void>) => Promise<void>,
  ) {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext)
      throw new Error(
        "Microphone needs localhost or trusted HTTPS. Check certificate trust and browser permissions.",
      );
    if (this.starting || this.stream || this.node || this.stopping)
      throw new Error("Microphone is already starting, active, or stopping.");
    this.starting = true;
    this.startCount++;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.startCapture(
            deviceId,
            send,
            onInterrupt,
            progress,
            attempt === 0 ? 3000 : 20000,
            attempt === 0 ? undefined : requestActivation,
          );
          return;
        } catch (error) {
          await this.stop();
          if (!(error instanceof AudioActivationTimeout) || attempt !== 0)
            throw error;
          this.activationResets++;
          progress("Resetting stalled microphone audio…");
          // A suspended engine with an unresolved resume is unhealthy. Retire it
          // instead of carrying pending native operations into another attempt.
          await this.dispose();
        }
      }
    } finally {
      this.starting = false;
    }
  }

  private async startCapture(
    deviceId: string,
    send: (pcm: ArrayBuffer, level: number) => void,
    onInterrupt: (message: string) => void,
    progress: (message: string) => void,
    activationTimeoutMs: number,
    requestActivation?: (resume: () => Promise<void>) => Promise<void>,
  ) {
    // Activate audio synchronously during the Start button gesture, before
    // permission prompts or worklet loading can consume user activation.
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
      this.module = undefined;
      this.contextCount++;
    }
    this.receivedBytes = 0;
    this.receivedChunks = 0;
    this.peakLevel = 0;
    // Preserve the Start gesture, but do not wait on this pre-permission
    // request: Firefox can leave it pending until resume is called again.
    void this.context.resume().catch(() => {});
    progress("Waiting for microphone permission…");
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
    progress("Loading microphone audio processing…");
    if (!this.context.audioWorklet)
      throw new Error(
        "This browser requires AudioWorklet support; use current Chrome, Firefox, or Safari.",
      );
    if (!this.module) {
      const loading = this.context.audioWorklet.addModule(workletUrl);
      this.module = loading;
      void loading.catch(() => {
        if (this.module === loading) this.module = undefined;
      });
    }
    await withTimeout(
      this.module,
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
    this.mute = mute;
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
    // Connect the complete input-to-destination graph before waiting for the
    // engine. Waiting on resume first leaves startup with no capture graph.
    progress("Activating microphone audio…");
    try {
      await withTimeout(
        this.context.resume(),
        new AudioActivationTimeout(
          "Audio activation timed out. Keep this tab visible and retry.",
        ),
        activationTimeoutMs,
      );
    } catch (error) {
      if (!(error instanceof AudioActivationTimeout) || !requestActivation)
        throw error;
      // Keep the granted input open so a new, explicit user gesture can unlock
      // playback. An automatic retry cannot supply browser user activation.
      progress("Tap Activate audio to finish connecting your microphone.");
      const context = this.context;
      await withTimeout(
        requestActivation(() => {
          this.activationTaps++;
          return context.resume();
        }),
        "Audio activation did not complete. Tap Start meeting to try again.",
        60000,
      );
    }
    if (this.context.state !== "running")
      throw new Error("Audio is suspended. Keep this tab visible and retry.");
    progress("Waiting for microphone samples…");
    await withTimeout(
      firstFrame,
      "Microphone opened, but Firefox did not deliver audio. Keep this tab visible, stop other audio or calls, then retry. If it persists, fully close and reopen Firefox.",
    );
  }
  diagnostics() {
    const track = this.stream?.getAudioTracks()[0];
    return {
      contextState: this.context?.state ?? "closed",
      contextCount: this.contextCount,
      startCount: this.startCount,
      activationResets: this.activationResets,
      activationTaps: this.activationTaps,
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
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = this.release();
    this.stopping = stopping;
    const cleared = () => {
      if (this.stopping === stopping) this.stopping = undefined;
    };
    void stopping.then(cleared, cleared);
    return stopping;
  }

  private async release() {
    const { context, node, source, stream, mute } = this;
    this.stream = undefined;
    this.node = undefined;
    this.source = undefined;
    this.mute = undefined;
    if (context) context.onstatechange = null;
    if (node) {
      node.port.onmessage = null;
      node.port.postMessage({ type: "stop" });
      node.port.close();
    }
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.onmute = null;
      track.stop();
    });
    node?.disconnect();
    source?.disconnect();
    mute?.disconnect();
    // Keep one engine and its registered module for the page lifetime. Repeated
    // close/create cycles needlessly reinitialize the mobile audio backend.
    if (context && context.state !== "closed" && context.state !== "suspended")
      await withTimeout(
        context.suspend(),
        "Audio suspension timed out.",
        2000,
      ).catch(() => {});
  }

  async dispose() {
    const stopped = this.stop();
    const context = this.context;
    this.context = undefined;
    this.module = undefined;
    await stopped;
    if (context && context.state !== "closed")
      await withTimeout(
        context.close(),
        "Audio cleanup timed out.",
        2000,
      ).catch(() => {});
  }
}
