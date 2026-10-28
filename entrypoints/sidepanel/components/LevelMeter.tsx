import { levelBars } from '@/lib/live';

/** Five small bars that follow a 0..1 audio level. Decorative: the label says what it measures. */
export function LevelMeter({ level, label }: { level: number; label: string }) {
  return (
    <span className="level-meter" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, Math.max(0, level))} aria-label={label}>
      {levelBars(level).map((h, i) => (
        <span key={i} style={{ height: h }} />
      ))}
    </span>
  );
}
