import { useEffect, useState } from 'react';
import { Spinner } from '../components';
import { useRouter } from '../router';
import { checkKeys, connectErrorMessage, connectPenv, formatEnvPath, loadToken, parseEnvPath, saveKeyStatus } from '@/lib/connect';
import { serviceLabel } from '@/lib/keyDetect';
import { loadKeys } from '@/lib/keys';
import { getSettings, updateSettings } from '@/lib/settings';
import { canStart, keyUse, neededKeys, penvAppConnectEnabled, startHint } from '@/lib/setup';
import type { Settings } from '@/lib/types';
import {
  CARD, ChosenSetupRow, ExternalLink, INPUT, LABEL, LINK, MONO, PAGE, PenvCloudLink, PRESET_TITLE, SetupHead, SetupIntro, SourceToggle,
  StartFooter, StatusDot, useKeyState,
} from './setupParts';

/** Error text in the product's words: the service is "Penv Cloud", never "penv". */
function friendly(message: string): string {
  return message.replace(/\bpenv\b/gi, 'Penv Cloud');
}

function describe(name: string, s: Settings): string {
  if (name === 'DEEPGRAM_API_KEY') return 'Real-time transcription';
  if (name === 'NOTION_TOKEN') return 'Sharing meetings to Notion';
  if (name === 'GROQ_API_KEY' && s.transcription.provider === 'deepgram' && s.realtimeBackup) return 'Assistant and backup transcription';
  const use = keyUse(name, s);
  return use === 'not in use' ? 'Not in use' : use.charAt(0).toUpperCase() + use.slice(1);
}

function PvTile({ size = 40 }: { size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: 12, background: '#111114', color: '#FFFFFF', fontFamily: MONO, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>pv</span>
  );
}

export default function PenvConnect() {
  const { replace, back, canGoBack } = useRouter();
  const flag = penvAppConnectEnabled();
  const [s, setS] = useState<Settings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [envPath, setEnvPath] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [noUsable, setNoUsable] = useState(false);
  const keys = useKeyState();

  useEffect(() => {
    Promise.all([getSettings(), loadToken()])
      .then(([settings, tok]) => {
        setS(settings);
        setHasToken(!!tok);
        setEnvPath(formatEnvPath(settings.penv));
      })
      .catch(() => setLoadFailed(true));
  }, []);

  if (loadFailed) {
    return (
      <main className="screen">
        <div className="perm-error" role="alert">Rekord couldn’t load your settings. Try reopening the side panel.</div>
      </main>
    );
  }
  if (!s || !keys.ready) {
    return (
      <main className="screen screen-center">
        <Spinner label="Loading" />
      </main>
    );
  }

  const onboarding = !s.onboarded;
  const goSetup = () => (canGoBack ? back() : replace('connect'));
  const needed = neededKeys(s);
  const connected = !editing && s.keySource !== 'paste' && (hasToken || s.keySource === 'penv-app') && keys.loaded.length > 0;
  const missing = needed.filter((n) => !keys.loaded.includes(n));
  const ready = connected && canStart(needed, keys.loaded, keys.status);
  const path = s.keySource === 'penv-app' && s.penvApp ? `${s.penvApp.org} / ${s.penvApp.project} / ${s.penvApp.env}` : formatEnvPath(s.penv).split('/').join(' / ');

  async function pickPaste() {
    try {
      await updateSettings({ keySource: 'paste' });
    } catch {
      return setError('Rekord couldn’t save your choice. Try again.');
    }
    goSetup();
  }

  async function connectToken() {
    if (!s) return;
    setError('');
    setNoUsable(false);
    const target = parseEnvPath(envPath);
    if (!target) return setError('Enter the environment as org/project/environment.');
    if (!token.trim()) return setError('Enter your read-only machine token.');
    setBusy(true);
    try {
      await connectPenv(token.trim(), target);
      const next = await updateSettings({ penv: target, keySource: 'penv' });
      setS(next);
      setToken('');
      setHasToken(true);
      const loaded = await loadKeys();
      await saveKeyStatus(await checkKeys(loaded));
      await keys.reload();
      if (Object.keys(loaded).length === 0) setNoUsable(true);
      setEditing(false);
    } catch (err) {
      setError(friendly(connectErrorMessage(err)));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!s) return;
    setBusy(true);
    try {
      await updateSettings({ keySource: s.keySource === 'penv-app' ? 'penv-app' : 'penv', onboarded: true });
      replace('start');
    } catch {
      setError('Rekord couldn’t save your choices. Try again.');
      setBusy(false);
    }
  }

  function noKeysPanel(names: string[]) {
    return (
      <div role="alert" style={{ padding: '12px 14px', borderRadius: 14, background: '#FFF8EC', border: '1px solid #F5DDB0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ fontSize: 13, lineHeight: 1.45, color: '#5C3200' }}>
          Connected, but Rekord can’t read a {names.map(serviceLabel).join(' or ')} key yet. Add one to this environment on <PenvCloudLink />, or choose it when you connect.
        </span>
        <button
          type="button"
          onClick={() => { setNoUsable(false); setEditing(true); setShowToken(true); }}
          style={{ alignSelf: 'flex-start', height: 32, padding: '0 12px', borderRadius: 9, background: '#FFFFFF', border: '1px solid #F5DDB0', color: '#5C3200', font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
        >
          Change which keys
        </button>
      </div>
    );
  }

  const tokenFields = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="env" style={LABEL}>Environment</label>
        <input id="env" type="text" placeholder="org/project/environment" value={envPath} onChange={(e) => setEnvPath(e.target.value)} autoComplete="off" spellCheck={false} style={INPUT} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="tok" style={LABEL}>Read-only machine token</label>
        <input id="tok" type="password" placeholder="pck_…" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void connectToken()} autoComplete="off" spellCheck={false} style={INPUT} />
      </div>
      <button
        type="button"
        onClick={() => void connectToken()}
        disabled={busy}
        style={{ height: 42, border: 'none', borderRadius: 10, background: '#111114', color: '#FFFFFF', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
      >
        {busy && <Spinner label="Connecting" size={16} />}
        Connect
      </button>
    </div>
  );

  return (
    <main className="screen" style={PAGE}>
      <SetupHead step={onboarding} onBack={goSetup} />
      <SetupIntro title="Set up your AI" text="Rekord needs an AI service to turn your meetings into notes. Choose how you’d like it to work, then add your key." />
      <ChosenSetupRow title={PRESET_TITLE[s.setup]} onChange={goSetup} />

      {connected ? (
        <div style={{ ...CARD, margin: '12px 24px 0', padding: 16, border: '1px solid #BFE3CD', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <PvTile />
            <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Connected to <PenvCloudLink /></span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: '#6E7079' }}>{path}</span>
            </span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1A7F4B" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
          </div>

          {missing.length > 0 && noKeysPanel(missing)}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#44464D' }}>Keys Rekord can read</span>
            <ul aria-label="Keys Rekord can read" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {keys.loaded.map((n) => (
                <li key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: '#F6F6F7' }}>
                  <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{serviceLabel(n)}</span>
                    <span style={{ fontSize: 12, color: '#5F6168' }}>{describe(n, s)}</span>
                  </span>
                  <StatusDot status={keys.status[n] ?? 'checking'} />
                </li>
              ))}
            </ul>
          </div>
          <span style={{ fontSize: 12, lineHeight: 1.45, color: '#6E7079' }}>
            Rekord asks Penv Cloud for these keys each time it starts and never saves them.{' '}
            <button type="button" onClick={() => setEditing(true)} style={{ ...LINK, padding: 0, border: 'none', background: 'transparent', font: 'inherit', fontSize: 12, color: '#4F46E5', cursor: 'pointer' }}>Change which keys</button>
          </span>
        </div>
      ) : (
        <div style={{ ...CARD, margin: '12px 24px 0', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SourceToggle value="penv" onPick={(v) => v === 'paste' && void pickPaste()} />
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <PvTile />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Your keys, in one safe place</span>
              <span style={{ fontSize: 13, lineHeight: 1.45, color: '#5F6168' }}>
                <PenvCloudLink /> stores your API keys. Connect once and Rekord loads the ones you choose, every time you open it.
              </span>
            </span>
          </div>

          {flag && (
            <>
              <button
                type="button"
                onClick={() => setError('Connecting with one click isn’t ready yet. Use a token instead.')}
                style={{ height: 48, border: 'none', borderRadius: 12, background: '#111114', color: '#FFFFFF', font: 'inherit', fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' }}
              >
                Connect Penv Cloud
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
              </button>
              <ul style={{ listStyle: 'none', margin: 0, padding: 12, borderRadius: 12, background: '#F6F6F7', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, lineHeight: 1.45, color: '#44464D' }}>
                <li>Penv Cloud opens in a new window. Sign in and choose which keys Rekord can read.</li>
                <li>Rekord can only read the keys you choose. It can’t change anything.</li>
                <li>Disconnect any time, here or on <ExternalLink href="https://penv.cloud">penv.cloud</ExternalLink>.</li>
              </ul>
            </>
          )}

          {(flag ? showToken : true) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {!flag && <span style={{ fontSize: 13, fontWeight: 600 }}>Use a token instead</span>}
              {tokenFields}
            </div>
          )}

          <span style={{ fontSize: 12, color: '#6E7079' }}>
            New to Penv Cloud? <ExternalLink href="https://penv.cloud">See how it works</ExternalLink>
            {flag && !showToken && (
              <>
                {' · '}
                <button type="button" onClick={() => setShowToken(true)} style={{ ...LINK, padding: 0, border: 'none', background: 'transparent', font: 'inherit', fontSize: 12, color: '#4F46E5', cursor: 'pointer' }}>Use a token instead</button>
              </>
            )}
          </span>
          {noUsable && !error && noKeysPanel(needed)}
          {error && <div className="perm-error" role="alert">{error}</div>}
        </div>
      )}

      <StartFooter
        disabled={!ready}
        busy={busy}
        hint={keys.loaded.length === 0 || !connected ? (flag ? 'Connect Penv Cloud or paste a key to continue.' : 'Add your token or paste a key to continue.') : startHint(needed, keys.loaded, keys.status)}
        onStart={() => void start()}
      />
    </main>
  );
}
