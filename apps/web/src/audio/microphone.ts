import workletUrl from "./pcm-worklet.js?url";
// Browser permission and audio activation promises can remain pending indefinitely.
async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 30000);
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
  async start(
    deviceId: string,
    send: (pcm: ArrayBuffer, level: number) => void,
    onInterrupt: (message: string) => void,
  ) {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext)
      throw new Error(
        "Microphone needs localhost or trusted HTTPS. Check certificate trust and browser permissions.",
      );
    try {
      // Activate audio synchronously during the Start button gesture, before
      // permission prompts or worklet loading can consume user activation.
      this.context = new AudioContext();
      const activated = withTimeout(
        this.context.resume(),
        "Audio could not start. Allow audio playback in Firefox and tap Start meeting again.",
      );
      // Observe rejection while the permission prompt is still pending.
      void activated.catch(() => {});
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
      if (!this.context.audioWorklet)
        throw new Error(
          "This browser requires AudioWorklet support; use current Chrome, Firefox, or Safari.",
        );
      await withTimeout(
        this.context.audioWorklet.addModule(workletUrl),
        "Microphone audio processing could not load. Reload the page and try again.",
      );
      this.node = new AudioWorkletNode(this.context, "pcm-processor");
      this.node.port.onmessage = (e) => send(e.data.pcm, e.data.level);
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
      await activated;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async pause() {
    await this.context?.suspend();
  }
  async resume() {
    await this.context?.resume();
  }
  async stop() {
    if (this.context) this.context.onstatechange = null;
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.context && this.context.state !== "closed")
      await this.context.close();
    this.context = undefined;
    this.stream = undefined;
    this.node = undefined;
    this.source = undefined;
  }
}
