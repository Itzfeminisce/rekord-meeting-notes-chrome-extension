import { useEffect, useState } from 'react';
import { useRouter } from '../router';
import { connectionCopy, useConnection, useNow, useRetryGuard, type LostState } from '@/lib/connection';
import { send } from '@/lib/messages';
import { getSettings } from '@/lib/settings';

const catchUp = () => { void send({ type: 'transcription/catch-up' }); };

/** The paused-transcription alert (shared by Live's banner and the connection-lost Error screen). */
export function ConnectionAlert({ state }: { state: LostState }) {
  const { navigate } = useRouter();
  const [provider, setProvider] = useState<string>();
  const now = useNow(true);
  const { busy, retry } = useRetryGuard(state, catchUp);
  useEffect(() => { void getSettings().then((s) => setProvider(s.transcription.provider)).catch(() => {}); }, []);
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
        <button type="button" className="conn-primary" disabled={busy} onClick={retry}>Retry now</button>
        <button type="button" className="conn-secondary" onClick={() => navigate(copy.action.to)}>{copy.action.label}</button>
      </div>
    </div>
  );
}

/** Shown on Live when transcription is paused; renders nothing while the connection is ok. */
export function ConnectionBanner() {
  const state = useConnection();
  return state.ok ? null : <ConnectionAlert state={state} />;
}
