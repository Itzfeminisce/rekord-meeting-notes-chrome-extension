import { Button, EmptyState, TopBar } from '../components';
import { ConnectionAlert } from '../components/ConnectionBanner';
import { initialRoute } from '../App';
import { useRouter } from '../router';
import { CONNECTION_LOST, useConnection } from '@/lib/connection';

/** Connection lost after the meeting ended (route params: message = CONNECTION_LOST, meetingId). */
function ConnectionLost({ meetingId }: { meetingId?: string }) {
  const { navigate, replace } = useRouter();
  const live = useConnection();
  const toProcessing = () => (meetingId ? navigate('processing', { meetingId }) : replace('start'));
  return (
    <main className="screen conn-screen">
      <TopBar />
      {live.ok ? (
        <p className="conn-note" role="status">Back online. Rekord is catching up.</p>
      ) : (
        <>
          <ConnectionAlert state={live} />
          <p className="conn-note">Your recording is saved. You can carry on to the summary now, or retry once you’re back online.</p>
        </>
      )}
      <div style={{ margin: '0 12px 12px' }}>
        <Button variant={live.ok ? 'primary' : 'secondary'} block onClick={toProcessing}>{meetingId ? 'Continue' : 'Back to start'}</Button>
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
