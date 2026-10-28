const WAVE: [height: number, color: string][] = [
  [14, '#3A3A44'], [26, '#4A4A56'], [40, '#6D67F0'], [22, '#6D67F0'], [46, '#8F8AF5'], [30, '#6D67F0'],
  [18, '#4A4A56'], [34, '#6D67F0'], [12, '#3A3A44'], [24, '#4A4A56'], [38, '#6D67F0'], [16, '#3A3A44'],
];

export default function Welcome({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <main className="screen">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 9v6M9 6v12M13 9v6M17 11v2" />
            </svg>
          </span>
          Rekord
        </div>
        <span className="step">Step 1 of 3</span>
      </header>

      <div className="hero" aria-hidden="true">
        <div className="wave">
          {WAVE.map(([height, color], i) => (
            <span key={i} style={{ height, background: color }} />
          ))}
        </div>
        <div className="moment">
          <span className="moment-meta">12:04 · Others</span>
          <span className="moment-text">Let’s lock the launch for the 14th.</span>
          <span className="tag">Decision</span>
        </div>
      </div>

      <section className="intro">
        <h1>Every meeting, written down as it happens.</h1>
        <p>
          Rekord transcribes your calls live, keeps your notes beside the conversation, and answers
          questions about what was said.
        </p>
      </section>

      <ul className="points">
        <li>
          <span className="point-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </span>
          Notes and transcripts stay on this computer
        </li>
        <li>
          <span className="point-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" />
            </svg>
          </span>
          Works with the AI model you choose
        </li>
      </ul>

      <footer className="footer">
        <button type="button" className="button-primary" onClick={onGetStarted}>
          Get started
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
        <span className="hint">Takes about a minute</span>
      </footer>
    </main>
  );
}
