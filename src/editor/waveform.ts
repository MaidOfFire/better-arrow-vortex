// Peak data for drawing the music waveform next to the notes.

export type WaveFilter = 'none' | 'lowpass' | 'highpass';

/** Absolute peak per bin at a few resolutions, for each channel (at most two). */
export class WaveformData {
  /** levels[l][ch] holds one peak per (BIN << (LEVEL_STEP * l)) samples. */
  private levels: Float32Array[][] = [];
  readonly sampleRate: number;
  readonly duration: number;
  static readonly BIN = 32;
  private static readonly LEVEL_STEP = 3; // each level is 8x coarser

  constructor(buffer: AudioBuffer, filter: WaveFilter = 'none', cutoff = 200) {
    this.sampleRate = buffer.sampleRate;
    this.duration = buffer.duration;
    const channels = Math.min(2, buffer.numberOfChannels);
    const base: Float32Array[] = [];
    for (let ch = 0; ch < channels; ++ch) {
      let data: Float32Array = buffer.getChannelData(ch);
      if (filter !== 'none') data = applyFilter(data, buffer.sampleRate, filter, cutoff);
      const bins = Math.ceil(data.length / WaveformData.BIN);
      const peaks = new Float32Array(bins);
      for (let b = 0; b < bins; ++b) {
        let max = 0;
        const end = Math.min(data.length, (b + 1) * WaveformData.BIN);
        for (let i = b * WaveformData.BIN; i < end; ++i) {
          const v = Math.abs(data[i]);
          if (v > max) max = v;
        }
        peaks[b] = max;
      }
      base.push(peaks);
    }
    if (channels === 1) base.push(base[0]);
    this.levels.push(base);
    const factor = 1 << WaveformData.LEVEL_STEP;
    while (this.levels[this.levels.length - 1][0].length > 2048) {
      const prev = this.levels[this.levels.length - 1];
      this.levels.push(
        prev.map((p) => {
          const out = new Float32Array(Math.ceil(p.length / factor));
          for (let i = 0; i < out.length; ++i) {
            let max = 0;
            for (let j = i * factor; j < Math.min(p.length, (i + 1) * factor); ++j) max = Math.max(max, p[j]);
            out[i] = max;
          }
          return out;
        }),
      );
    }
  }

  /** Peak (0..1) of channel `ch` between two song times. */
  peak(ch: number, t0: number, t1: number): number {
    if (t1 < t0) [t0, t1] = [t1, t0];
    const samples = (t1 - t0) * this.sampleRate;
    let level = 0;
    while (
      level + 1 < this.levels.length &&
      samples > WaveformData.BIN * (1 << (WaveformData.LEVEL_STEP * (level + 1))) * 4
    ) {
      ++level;
    }
    const binSamples = WaveformData.BIN * (1 << (WaveformData.LEVEL_STEP * level));
    const peaks = this.levels[level][ch];
    const b0 = Math.max(0, Math.floor((t0 * this.sampleRate) / binSamples));
    const b1 = Math.min(peaks.length - 1, Math.floor((t1 * this.sampleRate) / binSamples));
    let max = 0;
    for (let b = b0; b <= b1; ++b) if (peaks[b] > max) max = peaks[b];
    return max;
  }
}

/** One-pole filter run forward and backward (zero phase). */
function applyFilter(data: Float32Array, rate: number, type: WaveFilter, cutoff: number): Float32Array {
  const out = new Float32Array(data.length);
  const a = Math.exp((-2 * Math.PI * cutoff) / rate);
  let y = 0;
  for (let i = 0; i < data.length; ++i) {
    y = (1 - a) * data[i] + a * y;
    out[i] = y;
  }
  y = 0;
  for (let i = data.length - 1; i >= 0; --i) {
    y = (1 - a) * out[i] + a * y;
    out[i] = y;
  }
  if (type === 'highpass') for (let i = 0; i < data.length; ++i) out[i] = data[i] - out[i];
  return out;
}
