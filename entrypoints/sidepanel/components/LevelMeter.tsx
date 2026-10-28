import { levelBars } from '@/lib/live';

/** Five small bars that follow a 0..1 audio level. Decorative: the label says what it measures. */
export function LevelMeter({ level, label }: { level: number; label: string }) {
  return (
    <span className="level-meter" role="img" aria-label={label}>
      {levelBars(level).map((h, i) => (
        <span key={i} style={{ height: h }} />
      ))}
    </span>
  );
}
