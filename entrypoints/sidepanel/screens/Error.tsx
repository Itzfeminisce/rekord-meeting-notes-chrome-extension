import { useEffect, useState } from 'react';
import { Button, EmptyState, TopBar } from '../components';
import { initialRoute } from '../App';
import { useRouter } from '../router';
import { CONNECTION_LOST, connectionCopy, useConnection, type LostState } from '@/lib/connection';
import { send } from '@/lib/messages';
import { getSettings } from '@/lib/settings';

/** Connection lost after the meeting ended (route params: message = CONNECTION_LOST, meetingId). */
function ConnectionLost({ meetingId }: { meetingId?: string }) {
  const { navigate, replace } = useRouter();
  const live = useConnection();
  const [provider, setProvider] = useState<string>();
  useEffect(() => { void getSettings().then((s) => setProvider(s.transcription.provider)).catch(() => {}); }, []);
  const state: LostState = live.ok ? { ok: false, reason: 'server', pendingChunks: 0 } : live;
  const copy = connectionCopy(state, provider, Date.now());
  const toProcessing = () => (meetingId ? navigate('processing', { meetingId }) : replace('start'));
  return (
    <main className="screen conn-screen">
      <TopBar />
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
      <p className="conn-note">Your recording is saved. You can carry on to the summary now, or retry once you’re back online.</p>
      <div style={{ margin: '0 12px 12px' }}>
        <Button variant="secondary" block onClick={toProcessing}>{meetingId ? 'Continue' : 'Back to start'}</Button>
      </div>
    </main>
  );
}

export default function ErrorScreen() {
  const { route, replace } = useRouter();
  if (route.params.message === CONNECTION_LOST) return <ConnectionLost meetingId={route.params.meetingId} />;
  return (
    <main className="screen">
      <TopBar />
      <EmptyState
        title="Something went wrong"
        body={route.params.message ?? 'Rekord hit a problem. Your saved meetings are safe.'}
        action={<Button variant="secondary" onClick={async () => { const next = await initialRoute(); replace(next.screen, next.params); }}>Try again</Button>}
      />
    </main>
  );
}
