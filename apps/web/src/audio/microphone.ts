import workletUrl from "./pcm-worklet.js?url";
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      this.context = new AudioContext();
      if (!this.context.audioWorklet)
        throw new Error(
          "This browser requires AudioWorklet support; use current Chrome, Firefox, or Safari.",
        );
      await this.context.audioWorklet.addModule(workletUrl);
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
      await this.context.resume();
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
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.context && this.context.state !== "closed")
      await this.context.close();
    this.context = undefined;
    this.stream = undefined;
  }
}
