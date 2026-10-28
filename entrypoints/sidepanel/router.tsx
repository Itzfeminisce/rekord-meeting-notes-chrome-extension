import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type ScreenName =
  | 'welcome' | 'permissions' | 'connect' | 'start' | 'live' | 'processing'
  | 'summary' | 'speakers' | 'ask' | 'askall' | 'library' | 'transcript' | 'export' | 'settings' | 'error'
  | 'whatsnew' | 'connections' | 'googleConnect'
  // v3 setup: 'connect' is the Setup screen, 'settings' is the AI settings, 'settingsMore' is Recording, language and data
  | 'setupCustom' | 'penvConnect' | 'howItWorks' | 'settingsMore'
  | 'nosound'; // v3: desktop-app capture hears nothing

/** Route params. `meetingId` for meeting screens; `message` for the error screen. */
export interface RouteParams { meetingId?: string; message?: string; atMs?: number; section?: 'transcription' | 'assistant' }
export interface Route { screen: ScreenName; params: RouteParams }

export interface Router {
  route: Route;
  /** Go to a screen, pushing the current one onto the back stack. */
  navigate: (screen: ScreenName, params?: RouteParams) => void;
  /** Go to a screen and clear the back stack (e.g. after onboarding). */
  replace: (screen: ScreenName, params?: RouteParams) => void;
  back: () => void;
  canGoBack: boolean;
}

const RouterContext = createContext<Router | null>(null);

export function RouterProvider({ initial, children }: { initial: Route; children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([initial]);
  const navigate = useCallback((screen: ScreenName, params: RouteParams = {}) => setStack((s) => [...s, { screen, params }]), []);
  const replace = useCallback((screen: ScreenName, params: RouteParams = {}) => setStack([{ screen, params }]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const value = useMemo<Router>(
    () => ({ route: stack[stack.length - 1] ?? initial, navigate, replace, back, canGoBack: stack.length > 1 }),
    [stack, initial, navigate, replace, back],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): Router {
  const router = useContext(RouterContext);
  if (!router) throw new Error('useRouter must be used inside RouterProvider');
  return router;
}
