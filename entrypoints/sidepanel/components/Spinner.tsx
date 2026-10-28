/** Spinner with an accessible label; pass `label` for what is loading. */
export function Spinner({ label = 'Loading', size = 20 }: { label?: string; size?: number }) {
  return (
    <span className="spinner" role="status" aria-label={label} style={{ width: size, height: size }} />
  );
}
