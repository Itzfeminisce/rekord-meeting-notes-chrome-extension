import { useEffect, useState, type ComponentType } from 'react';
import { getSettings } from '@/lib/settings';
import { Spinner } from './components';
import { RouterProvider, useRouter, type Route, type ScreenName } from './router';
import Welcome from './screens/Welcome';
import Permissions from './screens/Permissions';
import Setup from './screens/Setup';
import SetupCustom from './screens/SetupCustom';
import PenvConnect from './screens/PenvConnect';
import HowItWorks from './screens/HowItWorks';
import SettingsAI from './screens/SettingsAI';
import Start from './screens/Start';
import Live from './screens/Live';
import Processing from './screens/Processing';
import Speakers from './screens/Speakers';
import Summary from './screens/Summary';
import Ask from './screens/Ask';
import AskAll from './screens/AskAll';
import Library from './screens/Library';
import Transcript from './screens/Transcript';
import Export from './screens/Export';
import Settings from './screens/Settings';
import ErrorScreen from './screens/Error';
import WhatsNew from './screens/WhatsNew';
import Connections from './screens/Connections';
import GoogleConnect from './screens/GoogleConnect';
import { shouldShowWhatsNew } from '@/lib/whatsNew';

export const SCREENS: Record<ScreenName, ComponentType> = {
  welcome: Welcome,
  permissions: Permissions,
  connect: Setup,
  setupCustom: SetupCustom,
  penvConnect: PenvConnect,
  howItWorks: HowItWorks,
  start: Start,
  live: Live,
  processing: Processing,
  summary: Summary,
  speakers: Speakers,
  ask: Ask,
  askall: AskAll,
  library: Library,
  transcript: Transcript,
  export: Export,
  settings: SettingsAI,
  settingsMore: Settings,
  error: ErrorScreen,
  whatsnew: WhatsNew,
  connections: Connections,
  googleConnect: GoogleConnect,
};

/** First screen: onboarding until the user has finished it, then Start. */
export async function initialRoute(): Promise<Route> {
  try {
    const settings = await getSettings();
    if (settings.onboarded && (await shouldShowWhatsNew(browser.runtime.getManifest().version))) {
      return { screen: 'whatsnew', params: {} };
    }
    return { screen: settings.onboarded ? 'start' : 'welcome', params: {} };
  } catch {
    return { screen: 'error', params: { message: 'Rekord couldn’t load your settings. Try reopening the side panel.' } };
  }
}

function CurrentScreen() {
  const { route } = useRouter();
  const Screen = SCREENS[route.screen];
  return <Screen key={`${route.screen}:${route.params.meetingId ?? ''}`} />;
}

export default function App() {
  const [initial, setInitial] = useState<Route | null>(null);
  useEffect(() => {
    void initialRoute().then(setInitial);
  }, []);

  if (!initial) {
    return (
      <main className="screen screen-center">
        <Spinner label="Opening Rekord" />
      </main>
    );
  }
  return (
    <RouterProvider initial={initial}>
      <CurrentScreen />
    </RouterProvider>
  );
}
