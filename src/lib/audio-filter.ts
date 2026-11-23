/**
 * NoiseFilter: cheap environmental-noise filtering for the organizer audio
 * a TranslationBridge sends to Gemini.
 *
 * Two stages, each a handful of float ops per sample, so it is safe to run on
 * every 50ms frame inside the Node process:
 *
 * 1. A 1st-order high-pass (~100 Hz) strips HVAC/projector-fan rumble, desk
 *    thumps and DC offset — energy below the speech band that otherwise keeps
 *    Gemini's VAD from ever hearing "silence".
 * 2. An adaptive noise gate tracks the room's noise floor and mutes frames
 *    that don't rise clearly above it. Hysteresis + a hold time keep soft word
 *    endings (Thai final tones, trailing English consonants) from being
 *    clipped mid-utterance.
 *
 * Muted frames are still emitted (as silence), never dropped: Gemini's VAD has
 * to *hear* silence to end a turn, and a gap in the stream reads as a stall.
 *
 * Why this matters beyond cleaner input: background noise passed straight to
 * the Live API is the main trigger for hallucinated/looping transcription
 * (see LOOP_BREAK_REPEATS in translation-bridge.ts).
 */

export interface NoiseFilterOptions {
  /** High-pass cutoff in Hz. */
  highPassHz?: number;
  /** Gate opens when frame RMS exceeds noiseFloor × this ratio (~+8 dB). */
  openRatio?: number;
  /** Keep the gate open this long after speech drops below threshold. */
  holdMs?: number;
  /**
   * Track speech (gateOpen) but return the input unmodified — for when
   * filtering is disabled but the bridge still needs speech detection to
   * pause the Gemini stream during silence.
   */
  passthrough?: boolean;
}

// Linear RMS on a [-1, 1] scale.
const MIN_OPEN_RMS = 0.004; // ≈ -48 dBFS: never gate quieter rooms harder than this
const MAX_OPEN_RMS = 0.025; // ≈ -32 dBFS: normal speech always opens the gate, even in a loud room
const INITIAL_NOISE_FLOOR = 0.002;
const CLOSE_RATIO = 0.6; // hysteresis: close threshold relative to open threshold
const ATTACK_MS = 5;

export class NoiseFilter {
  private readonly sampleRate: number;
  private readonly hpAlpha: number;
  private readonly openRatio: number;
  private readonly holdMs: number;
  private readonly passthrough: boolean;

  private prevIn = 0;
  private prevOut = 0;
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private gain = 0;
  private open = false;
  private holdRemainingMs = 0;

  constructor(sampleRate: number, options: NoiseFilterOptions = {}) {
    this.sampleRate = sampleRate;
    const rc = 1 / (2 * Math.PI * (options.highPassHz ?? 100));
    const dt = 1 / sampleRate;
    this.hpAlpha = rc / (rc + dt);
    this.openRatio = options.openRatio ?? 2.5;
    this.holdMs = options.holdMs ?? 350;
    this.passthrough = options.passthrough ?? false;
  }

  /** Whether the last processed frame was (or is held as) speech. */
  get gateOpen(): boolean {
    return this.open;
  }

  /** Filter one mono Int16 frame. Returns a new buffer; `input` is untouched. */
  process(input: Int16Array): Int16Array {
    const n = input.length;
    if (n === 0) return input;

    // Stage 1: high-pass, keeping state continuous across frames
    const filtered = new Float32Array(n);
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = input[i] / 32768;
      const y = this.hpAlpha * (this.prevOut + x - this.prevIn);
      this.prevIn = x;
      this.prevOut = y;
      filtered[i] = y;
      sumSq += y * y;
    }
    const rms = Math.sqrt(sumSq / n);
    const frameMs = (n / this.sampleRate) * 1000;

    // Stage 2: adaptive gate
    const openThreshold = Math.min(
      MAX_OPEN_RMS,
      Math.max(MIN_OPEN_RMS, this.noiseFloor * this.openRatio),
    );
    const closeThreshold = openThreshold * CLOSE_RATIO;
    const wasOpen = this.open;

    if (rms >= openThreshold || (this.open && rms >= closeThreshold)) {
      this.open = true;
      this.holdRemainingMs = this.holdMs;
    } else if (this.open) {
      this.holdRemainingMs -= frameMs;
      if (this.holdRemainingMs <= 0) this.open = false;
    }

    // Learn the noise floor only while the gate is closed so speech is never
    // mistaken for noise: fall fast toward quieter frames, rise slowly so a
    // brief noise burst doesn't raise the threshold.
    if (!this.open) {
      const rate = rms < this.noiseFloor ? 0.3 : 0.02;
      this.noiseFloor += (rms - this.noiseFloor) * rate;
    }

    if (this.passthrough) return input;

    // Ramp gain to avoid clicks: fast attack so speech onsets survive,
    // release spread over the whole frame.
    const targetGain = this.open ? 1 : 0;
    const rampSamples =
      this.open && !wasOpen
        ? Math.min(n, Math.round((ATTACK_MS / 1000) * this.sampleRate))
        : n;
    const startGain = this.gain;
    const output = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const g =
        i < rampSamples
          ? startGain + (targetGain - startGain) * ((i + 1) / rampSamples)
          : targetGain;
      const s = filtered[i] * g * 32768;
      output[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
    }
    this.gain = targetGain;
    return output;
  }
}
