import { useEffect, useState } from 'react';
import { useRouter } from '../router';
import { connectionCopy, useConnection } from '@/lib/connection';
import { send } from '@/lib/messages';
import { getSettings } from '@/lib/settings';

/** Shown on Live when transcription is paused; renders nothing while the connection is ok. */
export function ConnectionBanner() {
  const state = useConnection();
  const { navigate } = useRouter();
  const [provider, setProvider] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { void getSettings().then((s) => setProvider(s.transcription.provider)).catch(() => {}); }, []);
  useEffect(() => {
    if (state.ok) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.ok]);
  if (state.ok) return null;
  const copy = connectionCopy(state, provider, now);
  return (
    <div role="alert" className="conn-banner">
      <div className="conn-head">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z" /><path d="M12 10v4M12 17h.01" /></svg>
        <div className="conn-text">
          <span className="conn-title">{copy.title}</span>
          <span className="conn-body">{copy.body}</span>
        </div>
      </div>
      <div className="conn-actions">
        <button type="button" className="conn-primary" onClick={() => void send({ type: 'transcription/catch-up' })}>Retry now</button>
        <button type="button" className="conn-secondary" onClick={() => navigate(copy.action.to)}>{copy.action.label}</button>
      </div>
    </div>
  );
}
