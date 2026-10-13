/* Streaming box-filter resampler: accumulates weighted input intervals across render quanta. */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.weight = 0;
    this.samples = [];
    this.ratio = sampleRate / 16000;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const energy = input.reduce((sum, value) => sum + value * value, 0);
    for (const value of input) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const part = Math.min(remaining, this.ratio - this.weight);
        this.sum += value * part;
        this.weight += part;
        remaining -= part;
        if (this.weight >= this.ratio - 1e-8) {
          const v = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.samples.push(Math.round(v * (v < 0 ? 32768 : 32767)));
          this.sum = 0;
          this.weight = 0;
          if (this.samples.length === 1600) {
            const pcm = new ArrayBuffer(3200);
            const view = new DataView(pcm);
            this.samples.forEach((s, i) => view.setInt16(i * 2, s, true));
            this.port.postMessage(
              { pcm, level: Math.sqrt(energy / input.length) },
              [pcm],
            );
            this.samples = [];
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);
