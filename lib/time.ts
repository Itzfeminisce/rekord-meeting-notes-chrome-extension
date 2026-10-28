const pad = (n: number) => String(n).padStart(2, '0');

/** Clock offset: 724000 → "12:04", 3723000 → "1:02:03". */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms)) ms = 0;
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Human duration rounded to minutes: "42 min", "1 h 5 min", "2 h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) ms = 0;
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
