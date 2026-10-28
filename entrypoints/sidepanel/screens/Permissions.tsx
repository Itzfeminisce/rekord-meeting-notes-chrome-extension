import { useEffect, useState } from 'react';
import { Button } from '../components';
import { useRouter } from '../router';
import { openPermissionTab, watchMic, type MicState } from '@/lib/mic';

const ICON = { fill: 'none', stroke: '#4F46E5', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export default function Permissions() {
  const { navigate, replace, back, canGoBack } = useRouter();
  const [mic, setMic] = useState<MicState>('unknown');
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => watchMic(setMic), []);
  useEffect(() => {
    if (mic === 'granted') replace('connect');
  }, [mic, replace]);

  async function allow() {
    setOpening(true);
    setFailed(false);
    try {
      await openPermissionTab();
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  }

  return (
    <main className="screen">
      <div className="perm-head">
        <button
          type="button"
          className="perm-back"
          aria-label="Back"
          onClick={() => (canGoBack ? back() : replace('welcome'))}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <span className="step">Step 2 of 3</span>
      </div>
      <div className="perm-progress" role="progressbar" aria-label="Setup progress" aria-valuenow={2} aria-valuemin={1} aria-valuemax={3}>
        <span className="on" />
        <span className="on" />
        <span />
      </div>

      <section className="perm-intro">
        <h1>Let Rekord hear the meeting</h1>
        <p>Two sources make a full transcript. You can turn either off before any meeting.</p>
      </section>

      <ul className="perm-sources">
        <li className="perm-card">
          <span className="perm-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" {...ICON} aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
            </svg>
          </span>
          <div className="perm-text">
            <span className="perm-title">Your microphone</span>
            <span className="perm-desc">Labels what you say as “You”.</span>
          </div>
          <span className="perm-pill perm-pill-needed">Needed</span>
        </li>
        <li className="perm-card">
          <span className="perm-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" {...ICON} aria-hidden="true">
              <rect x="2" y="4" width="20" height="14" rx="2" />
              <path d="M8 21h8" />
            </svg>
          </span>
          <div className="perm-text">
            <span className="perm-title">Meeting tab audio</span>
            <span className="perm-desc">Labels everyone else as “Others”. Asked each time you start, only for that tab.</span>
          </div>
          <span className="perm-pill">Per call</span>
        </li>
      </ul>

      <div className="perm-note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5F6168" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M11 12h1v5h1" />
        </svg>
        <span>Audio goes only to the transcription service you pick next. Rekord never keeps recordings unless you turn that on.</span>
      </div>

      {mic === 'denied' && (
        <div className="perm-error" role="alert">
          Microphone is blocked. Open Chrome’s site settings for Rekord (chrome://settings/content/microphone), allow the microphone, then come back.
        </div>
      )}
      {failed && (
        <div className="perm-error" role="alert">
          Couldn’t open the permission page. Try again.
        </div>
      )}

      <footer className="footer">
        <Button block onClick={allow} disabled={opening}>
          Allow microphone
        </Button>
        <Button variant="ghost" onClick={() => navigate('connect')}>
          Use tab audio only
        </Button>
      </footer>
    </main>
  );
}
