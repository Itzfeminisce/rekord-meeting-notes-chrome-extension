import { Button, EmptyState, TopBar } from '../components';
import { useRouter } from '../router';

export default function Connect() {
  const { back, canGoBack } = useRouter();
  return (
    <main className="screen">
      <TopBar />
      <EmptyState
        title="Connect AI"
        body="This part of Rekord is on its way."
        action={canGoBack ? <Button variant="secondary" onClick={back}>Back</Button> : undefined}
      />
    </main>
  );
}
