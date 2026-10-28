import { Button, EmptyState, TopBar } from '../components';
import { initialRoute } from '../App';
import { useRouter } from '../router';

export default function ErrorScreen() {
  const { route, replace } = useRouter();
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
