/** Root-mean-square of time-domain samples in -1..1. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** RMS at or above this counts as sound (about -40 dBFS). Below it for a whole chunk = silent. */
export const SILENCE_RMS = 0.01;

/** Maps an RMS value to a 0..1 meter level (speech sits around 0.3–0.8). */
export function toLevel(value: number): number {
  if (!(value > 0)) return 0;
  return Math.min(1, value / 0.25);
}
