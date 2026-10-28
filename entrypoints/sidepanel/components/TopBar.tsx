import type { ReactNode } from 'react';

export function BrandMark() {
  return (
    <span className="brand-mark">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="M5 9v6M9 6v12M13 9v6M17 11v2" />
      </svg>
    </span>
  );
}

/** Brand on the left, anything (step count, actions) on the right. */
export function TopBar({ right }: { right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        Rekord
      </div>
      {right && <div className="topbar-right">{right}</div>}
    </header>
  );
}
