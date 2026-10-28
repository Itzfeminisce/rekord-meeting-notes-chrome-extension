import { Button, EmptyState, TopBar } from '../components';
import { useRouter } from '../router';

export default function Permissions() {
  const { back, canGoBack } = useRouter();
  return (
    <main className="screen">
      <TopBar />
      <EmptyState
        title="Mic access"
        body="This part of Rekord is on its way."
        action={canGoBack ? <Button variant="secondary" onClick={back}>Back</Button> : undefined}
      />
    </main>
  );
}
