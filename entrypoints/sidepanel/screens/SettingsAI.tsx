import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Spinner } from '../components';
import { useRouter } from '../router';
import { connectErrorMessage, forgetAll, formatEnvPath, loadToken, reconnect, transcriptionKeyName } from '@/lib/connect';
import { hostsForSettings, PENV_HOSTS, requestHosts } from '@/lib/hosts';
import { serviceLabel } from '@/lib/keyDetect';
import { getSettings, PROVIDERS, updateSettings } from '@/lib/settings';
import { disconnectPenvApp, loadPenvAppKeys, PenvAppError, wasDisconnected } from '@/lib/penvApp';
import { keyUse, STATUS_WORD, type RowStatus } from '@/lib/setup';
import type { ProviderId, Settings, TranscriptionProvider } from '@/lib/types';
import { DisconnectedPanel } from './PenvConnect';
import { BackIcon, CARD, LINK, MONO, PenvCloudLink, StatusDot, useKeyState } from './setupParts';

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: '#4F46E5', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

const PROVIDER_NAME: Record<ProviderId, string> = { groq: 'Groq', openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic', ollama: 'Ollama' };
const TRANSCRIPTION_LINE: Record<TranscriptionProvider, string> = {
  deepgram: 'Deepgram · real time, tells voices apart',
  groq: 'Groq · a few seconds behind',
  openai: 'OpenAI · a few seconds behind',
};

function modelLabel(model: string): string {
  if (model.startsWith('llama-3.3')) return 'Llama 3.3';
  if (model === 'openai/gpt-oss-120b') return 'GPT-OSS 120B';
  if (model === 'openai/gpt-oss-20b') return 'GPT-OSS 20B';
  return model;
}

function friendly(message: string): string {
  return message.replace(/\bpenv\b/gi, 'Penv Cloud');
}

const SECTION_TITLE = { margin: 0, padding: '0 8px', fontSize: 12, fontWeight: 600, color: '#6E7079' } as const;
const SMALL_BTN = { height: 34, padding: '0 12px', borderRadius: 9, font: 'inherit', fontSize: 12, fontWeight: 600, textDecoration: 'none', display: 'flex', alignItems: 'center', cursor: 'pointer' } as const;

function IconTile({ children }: { children: ReactNode }) {
  return <span style={{ width: 34, height: 34, borderRadius: 10, background: '#EEF0FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{children}</span>;
}

export default function SettingsAI() {
  const { navigate, replace } = useRouter();
  const [s, setS] = useState<Settings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const keys = useKeyState();

  useEffect(() => {
    Promise.all([getSettings(), loadToken(), wasDisconnected().catch(() => false)])
      .then(([settings, token, gone]) => {
        setS(settings);
        setHasToken(!!token);
        setDisconnected(gone && settings.keySource === 'penv-app');
      })
      .catch(() => setLoadFailed(true));
  }, []);

  const refreshToken = useCallback(async () => setHasToken(!!(await loadToken())), []);

  const header = (
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 0' }}>
      <button
        type="button"
        aria-label="Back to home"
        onClick={() => replace('start')}
        style={{ width: 36, height: 36, border: 'none', borderRadius: 10, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#111114', cursor: 'pointer' }}
      >
        <BackIcon />
      </button>
      <h1 style={{ margin: 0, flexGrow: 1, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>Settings</h1>
    </header>
  );

  if (loadFailed) {
    return (
      <main className="screen">
        {header}
        <div className="perm-error" role="alert" style={{ margin: 16 }}>Rekord couldn’t load your settings. Try reopening the side panel.</div>
      </main>
    );
  }
  if (!s) {
    return (
      <main className="screen">
        {header}
        <div className="set-loading"><Spinner label="Loading settings" /></div>
      </main>
    );
  }

  const penvSource = s.keySource !== 'paste';
  const tKey = transcriptionKeyName(s.transcription.provider);
  const aKey = PROVIDERS[s.summary.provider].keyName;
  const rowStatus = (key?: string): { status: RowStatus; label?: string } => {
    if (!key) return { status: 'ok' }; // Ollama needs no key
    if (!keys.loaded.includes(key)) return { status: 'unreachable', label: 'Needs a key' };
    return { status: keys.status[key] ?? 'checking' };
  };
  const t = rowStatus(tKey);
  const a = rowStatus(aKey);
  const path = s.keySource === 'penv-app' && s.penvApp ? `${s.penvApp.org}/${s.penvApp.project}/${s.penvApp.env}` : formatEnvPath(s.penv);
  const canDisconnect = keys.loaded.length > 0 || hasToken || (s.keySource === 'penv-app' && !!s.penvApp);

  async function refresh() {
    setMessage(null);
    const app = s?.keySource === 'penv-app' ? s.penvApp : undefined;
    if (!app && !hasToken) return navigate('penvConnect');
    setBusy(true);
    if (!(await requestHosts([...PENV_HOSTS, ...hostsForSettings(s!, keys.loaded)]))) {
      setBusy(false);
      return setMessage({ kind: 'error', text: 'Rekord needs your permission to reach your AI service. Try again and choose Allow.' });
    }
    try {
      const names = app ? await loadPenvAppKeys(app) : await reconnect();
      if (!names) return navigate('penvConnect');
      setMessage({ kind: 'ok', text: `Keys refreshed: ${names.map(serviceLabel).join(', ')}.` });
    } catch (err) {
      if (err instanceof PenvAppError && err.code === 'disconnected') setDisconnected(true);
      else setMessage({ kind: 'error', text: friendly(connectErrorMessage(err)) });
    } finally {
      await Promise.all([keys.reload(), refreshToken()]);
      setBusy(false);
    }
  }

  async function disconnect() {
    setMessage(null);
    setConfirm(false);
    if (s?.keySource === 'penv-app') {
      // Revoke the grant on Penv Cloud, clear keys, back to Setup.
      try {
        await disconnectPenvApp();
        await forgetAll();
        await updateSettings({ keySource: 'penv', penvApp: undefined });
        return replace('connect');
      } catch {
        setMessage({ kind: 'error', text: 'Couldn’t disconnect. Try again.' });
        return;
      }
    }
    try {
      await forgetAll();
      setMessage({ kind: 'ok', text: 'Disconnected. Rekord cleared its keys from memory.' });
    } catch {
      setMessage({ kind: 'error', text: 'Couldn’t disconnect. Try again.' });
    }
    await Promise.all([keys.reload(), refreshToken()]);
  }

  async function setBackup(on: boolean) {
    try {
      setS(await updateSettings({ realtimeBackup: on }));
    } catch {
      setMessage({ kind: 'error', text: 'Couldn’t save that change. Try again.' });
    }
  }

  const rowButton = (section: 'transcription' | 'assistant', title: string, line: string, st: { status: RowStatus; label?: string }, icon: ReactNode, first: boolean) => (
    <button
      type="button"
      onClick={() => navigate('setupCustom', { section })}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, border: 'none', borderBottom: '1px solid #F0F0F2', borderRadius: first ? '16px 16px 0 0' : 0, background: 'transparent', font: 'inherit', color: '#111114', textAlign: 'left', cursor: 'pointer' }}
    >
      <IconTile>{icon}</IconTile>
      <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 12, color: '#5F6168' }}>{line}</span>
      </span>
      <StatusDot status={st.status} label={st.label} />
    </button>
  );

  return (
    <main className="screen" style={{ background: '#F6F6F7', color: '#111114' }}>
      {header}
      <div style={{ flexGrow: 1, padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section aria-labelledby="h-ai" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0 8px' }}>
            <h2 id="h-ai" style={{ margin: 0, fontSize: 12, fontWeight: 600, color: '#6E7079' }}>AI</h2>
            <button type="button" onClick={() => navigate('howItWorks')} style={{ ...LINK, padding: 0, border: 'none', background: 'transparent', font: 'inherit', fontSize: 12, color: '#4F46E5', cursor: 'pointer' }}>
              How Rekord handles your meetings
            </button>
          </div>
          <div style={{ ...CARD, display: 'flex', flexDirection: 'column' }}>
            {rowButton('transcription', 'Transcription', TRANSCRIPTION_LINE[s.transcription.provider], t, <svg {...ICON}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></svg>, true)}
            {rowButton('assistant', 'Assistant', `${PROVIDER_NAME[s.summary.provider]} · ${modelLabel(s.summary.model)}`, a, <svg {...ICON}><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>, false)}
            {s.transcription.provider === 'deepgram' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>Keep transcribing if Deepgram stops</span>
                  <span style={{ fontSize: 12, color: '#5F6168' }}>Switches to Groq. Text appears a few seconds later.</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={s.realtimeBackup}
                  onChange={(e) => void setBackup(e.target.checked)}
                  aria-label="Keep transcribing if Deepgram stops"
                  style={{ width: 18, height: 18, margin: 0, accentColor: '#4F46E5' }}
                />
              </label>
            )}
          </div>
        </section>

        <section aria-labelledby="h-keys" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 id="h-keys" style={SECTION_TITLE}>Your keys</h2>
          <div style={{ ...CARD, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 9, background: '#111114', color: '#FFFFFF', fontFamily: MONO, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{penvSource ? 'pv' : 'key'}</span>
              <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {penvSource ? (
                  <>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Loaded from <PenvCloudLink /></span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: '#6E7079' }}>{path}</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Pasted in this browser</span>
                    <span style={{ fontSize: 12, color: '#6E7079' }}>Kept in memory only</span>
                  </>
                )}
              </span>
              {penvSource && (
                <button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={busy}
                  style={{ height: 30, padding: '0 10px', border: '1px solid #E8E8EB', borderRadius: 8, background: '#FFFFFF', font: 'inherit', fontSize: 12, fontWeight: 600, color: '#111114', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  {busy && <Spinner label="Refreshing keys" size={12} />}
                  {busy ? 'Refreshing…' : 'Refresh'}
                </button>
              )}
            </div>

            {disconnected && <DisconnectedPanel onConnect={() => navigate('penvConnect')} />}

            {keys.loaded.length > 0 ? (
              <ul aria-label="Your keys" style={{ listStyle: 'none', margin: 0, padding: '10px 12px', borderRadius: 10, background: '#F6F6F7', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {keys.loaded.map((n) => {
                  const use = keyUse(n, s);
                  const idle = use === 'not in use';
                  const st = keys.status[n] ?? 'checking';
                  return (
                    <li key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ flexGrow: 1 }}>
                        <span style={{ fontWeight: 600 }}>{serviceLabel(n)}</span> <span style={{ color: '#6E7079' }}>· {use}</span>
                      </span>
                      <span style={{ fontWeight: idle ? 500 : 600, color: idle ? '#6E7079' : st === 'ok' ? '#1A6B40' : st === 'rejected' ? '#B42318' : '#6E7079' }}>
                        {idle ? 'Saved for later' : STATUS_WORD[st]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p style={{ margin: 0, padding: '10px 12px', borderRadius: 10, background: '#F6F6F7', fontSize: 12, color: '#5F6168' }}>No keys are loaded right now.</p>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => navigate('connect')} style={{ ...SMALL_BTN, border: 'none', background: '#111114', color: '#FFFFFF' }}>
                Change how Rekord works
              </button>
              {penvSource && (
                <a href="https://penv.cloud" target="_blank" rel="noreferrer" style={{ ...SMALL_BTN, background: '#FFFFFF', border: '1px solid #E8E8EB', color: '#111114' }}>
                  Manage on Penv Cloud
                </a>
              )}
              {canDisconnect && !confirm && (
                <button type="button" onClick={() => setConfirm(true)} style={{ ...SMALL_BTN, border: '1px solid #F2C9C7', background: '#FFFFFF', color: '#B42318' }}>
                  Disconnect
                </button>
              )}
            </div>

            {confirm && (
              <div role="alertdialog" aria-label="Disconnect" style={{ padding: 12, borderRadius: 12, background: '#FDECEC', border: '1px solid #F2C9C7', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.45, color: '#8A1C14' }}>
                <span>
                  {penvSource
                    ? 'Disconnect from Penv Cloud? Rekord forgets the token and clears its keys from memory.'
                    : 'Clear the keys you pasted? Rekord forgets them and you will need to paste them again.'}
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setConfirm(false)} style={{ ...SMALL_BTN, border: '1px solid #E8E8EB', background: '#FFFFFF', color: '#111114' }}>Cancel</button>
                  <button type="button" onClick={() => void disconnect()} autoFocus style={{ ...SMALL_BTN, border: '1px solid #F2C9C7', background: '#FFFFFF', color: '#B42318' }}>Disconnect</button>
                </span>
              </div>
            )}
          </div>
        </section>

        {message && (
          <div className={message.kind === 'error' ? 'perm-error' : 'set-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>
            {message.text}
          </div>
        )}

        <section aria-labelledby="h-more" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 id="h-more" style={SECTION_TITLE}>More</h2>
          <div style={{ ...CARD, display: 'flex', flexDirection: 'column' }}>
            <button
              type="button"
              onClick={() => navigate('connections')}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, border: 'none', borderBottom: '1px solid #F0F0F2', background: 'transparent', font: 'inherit', textAlign: 'left', color: '#111114', cursor: 'pointer' }}
            >
              <span style={{ flexGrow: 1, fontSize: 14, fontWeight: 500 }}>Connected apps</span>
              <span style={{ fontSize: 12, color: '#6E7079' }}>Calendar, Docs, Notion</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('settingsMore')}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, border: 'none', background: 'transparent', font: 'inherit', textAlign: 'left', color: '#111114', cursor: 'pointer' }}
            >
              <span style={{ flexGrow: 1, fontSize: 14, fontWeight: 500 }}>Recording, language and data</span>
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
