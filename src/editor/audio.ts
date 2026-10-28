// Music playback on the Web Audio clock, plus beat and note tick sounds.

import { gameLeadIn, readMp3Header } from './mp3Lead';

/** Seconds from asking the music to start to its first sample being rendered. */
const START_DELAY = 0.02;
/** While scrolling during playback, how often the music may restart (ms). */
const RESTART_EVERY = 50;

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private tickGain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private beatTickBuf: AudioBuffer | null = null;
  private noteTickBuf: AudioBuffer | null = null;
  private scheduled: AudioBufferSourceNode[] = [];

  buffer: AudioBuffer | null = null;
  playing = false;
  volume = 1;
  muted = false;
  speed = 1;

  /** Song time and context time when playback last (re)started. */
  private startSongTime = 0;
  private startCtxTime = 0;
  /** Song time up to which ticks have been scheduled. */
  private tickHorizon = 0;
  private pausedTime = 0;
  /** When the music was last (re)started (performance.now()), and a pending restart. */
  private lastRestart = -Infinity;
  private restartTimer = 0;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.tickGain = this.ctx.createGain();
      this.tickGain.gain.value = 0.6;
      this.tickGain.connect(this.ctx.destination);
      this.beatTickBuf = makeBeep(this.ctx, 1760, 0.03);
      this.noteTickBuf = makeClap(this.ctx);
      this.applyVolume();
    }
    return this.ctx;
  }

  async load(data: ArrayBuffer): Promise<void> {
    const ctx = this.ensureContext();
    this.stop();
    // Read before decoding: decodeAudioData takes the data away.
    const mp3 = readMp3Header(data);
    const decoded = await ctx.decodeAudioData(data);
    // MP3s: put back the silence the games play before the browser's first sample (see mp3Lead).
    const lead = mp3 ? Math.round(gameLeadIn(mp3, decoded.duration) * decoded.sampleRate) : 0;
    if (lead <= 0) {
      this.buffer = decoded;
      return;
    }
    const padded = ctx.createBuffer(decoded.numberOfChannels, decoded.length + lead, decoded.sampleRate);
    for (let c = 0; c < decoded.numberOfChannels; ++c) padded.copyToChannel(decoded.getChannelData(c), c, lead);
    this.buffer = padded;
  }

  unload(): void {
    this.stop();
    this.buffer = null;
  }

  get duration(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  get sampleRate(): number {
    return this.buffer ? this.buffer.sampleRate : 44100;
  }

  /** Current song time in seconds: the music coming out of the speakers now. */
  get time(): number {
    if (!this.playing || !this.ctx) return this.pausedTime;
    // Just after play the time waits for the music to be heard rather than jumping back.
    return this.startSongTime + Math.max(0, this.heardNow() - this.startCtxTime) * this.speed;
  }

  /**
   * The context time of the sound leaving the speakers now. currentTime moves in steps of an
   * audio callback (6-11 ms), which makes scrolling uneven at 60 frames a second; the output
   * timestamp plus the time since it was taken moves smoothly.
   */
  private heardNow(): number {
    const ctx = this.ctx!;
    const ts = ctx.state === 'running' && ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts?.contextTime && ts.performanceTime) return Math.min(ctx.currentTime, ts.contextTime + (performance.now() - ts.performanceTime) / 1000);
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  play(fromTime: number): void {
    const ctx = this.ensureContext();
    void ctx.resume();
    this.playing = true;
    this.startSongTime = fromTime;
    this.startCtxTime = ctx.currentTime + START_DELAY;
    this.tickHorizon = fromTime;
    this.restart();
  }

  /** (Re)starts the music at the song time it will be when its first sample is heard. */
  private restart(): void {
    const ctx = this.ctx!;
    clearTimeout(this.restartTimer);
    this.restartTimer = 0;
    this.stopSources();
    this.lastRestart = performance.now();
    const when = ctx.currentTime + START_DELAY;
    const from = this.startSongTime + (when - this.startCtxTime) * this.speed;
    if (this.buffer && from < this.buffer.duration) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this.speed;
      src.connect(this.gain!);
      if (from >= 0) src.start(when, from);
      else src.start(when - from / this.speed, 0);
      this.source = src;
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedTime = this.time;
    this.stop();
  }

  /** Stops playback, keeping the paused position. */
  stop(): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = 0;
    this.stopSources();
    this.playing = false;
  }

  seek(time: number): void {
    if (!this.playing) {
      this.pausedTime = time;
      return;
    }
    // Scrolling while playing: the song goes on from the new place at once and the music follows,
    // restarted at most every RESTART_EVERY ms so a stream of wheel steps does not stutter.
    this.startSongTime = time;
    this.startCtxTime = this.heardNow();
    this.stopTicks();
    this.tickHorizon = time;
    if (this.restartTimer) return;
    const wait = this.lastRestart + RESTART_EVERY - performance.now();
    if (wait <= 0) return this.restart();
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = 0;
      if (this.playing) this.restart();
    }, wait);
  }

  setSpeed(speed: number): void {
    const t = this.time;
    this.speed = Math.min(4, Math.max(0.1, speed));
    if (this.playing) this.play(t);
  }

  setVolume(volume: number): void {
    this.volume = Math.min(2, Math.max(0, volume));
    this.applyVolume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  private stopSources(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.disconnect();
      this.source = null;
    }
    this.stopTicks();
  }

  private stopTicks(): void {
    for (const s of this.scheduled) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
      s.disconnect();
    }
    this.scheduled = [];
  }

  /**
   * Schedules tick sounds ahead of the playhead. `beatTimes` and `noteTimes` return the song
   * times of beats / note rows in [t0, t1).
   */
  scheduleTicks(
    beatTick: boolean,
    noteTick: boolean,
    beatTimes: (t0: number, t1: number) => number[],
    noteTimes: (t0: number, t1: number) => number[],
  ): void {
    if (!this.playing || !this.ctx || (!beatTick && !noteTick)) {
      if (this.playing) this.tickHorizon = this.time + 0.15 * this.speed;
      return;
    }
    const now = this.time;
    const t0 = Math.max(this.tickHorizon, now);
    const t1 = now + 0.15 * this.speed;
    if (t1 <= t0) return;
    this.tickHorizon = t1;
    const fire = (buf: AudioBuffer, songTime: number) => {
      const when = this.startCtxTime + (songTime - this.startSongTime) / this.speed;
      if (when < this.ctx!.currentTime) return;
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
      src.connect(this.tickGain!);
      src.start(when);
      src.onended = () => {
        src.disconnect();
        const i = this.scheduled.indexOf(src);
        if (i >= 0) this.scheduled.splice(i, 1);
      };
      this.scheduled.push(src);
    };
    if (beatTick) for (const t of beatTimes(t0, t1)) fire(this.beatTickBuf!, t);
    if (noteTick) for (const t of noteTimes(t0, t1)) fire(this.noteTickBuf!, t);
  }
}

function makeBeep(ctx: AudioContext, freq: number, length: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * length);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; ++i) {
    const t = i / ctx.sampleRate;
    d[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 120) * 0.8;
  }
  return buf;
}

function makeClap(ctx: AudioContext): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let lp = 0;
  for (let i = 0; i < n; ++i) {
    const t = i / ctx.sampleRate;
    const noise = rand();
    lp += (noise - lp) * 0.5;
    d[i] = (noise - lp) * Math.exp(-t * 90) * 0.9;
  }
  return buf;
}
