import { useEffect, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Spinner } from '../components';
import { useRouter } from '../router';
import { loadToken, transcriptionKeyName } from '@/lib/connect';
import { serviceLabel, type KeyName } from '@/lib/keyDetect';
import { getSettings, updateSettings } from '@/lib/settings';
import { applyPreset, canStart, classifyPaste, KEY_PAGE, neededKeys, rowDetail, SERVICE_CHOICES, startHint } from '@/lib/setup';
import { hostsForSettings, requestHosts } from '@/lib/hosts';
import type { SetupPreset, Settings } from '@/lib/types';
import {
  CARD, ExternalLink, INPUT, LABEL, LINK, PAGE, PenvCloudLink, SetupHead, SetupIntro, SourceToggle, StartFooter, StatusDot, useKeyState,
} from './setupParts';

const ICON = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: '#4F46E5', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const GROQ_KEYS = KEY_PAGE.GROQ_API_KEY;

const PRESETS: { id: SetupPreset; title: string; text: string; badge?: string }[] = [
  { id: 'free', title: 'Free to start', badge: 'Recommended', text: 'One free Groq key does everything. Your transcript appears a few seconds after people speak.' },
  { id: 'realtime', title: 'Real time', text: 'Words appear as people speak, and Rekord tells voices apart. Needs a Deepgram key and a Groq key. Deepgram is a paid service.' },
  { id: 'custom', title: 'Choose my own', text: 'Pick the service for transcription and for the assistant.' },
];

function IconBox({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ width: 28, height: 28, borderRadius: 9, background: '#EEF0FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{children}</span>
  );
}

export default function Setup() {
  const { navigate, replace, back, canGoBack } = useRouter();
  const [s, setS] = useState<Settings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [source, setSource] = useState<'penv' | 'paste'>('paste');
  const [value, setValue] = useState('');
  const [unknown, setUnknown] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keys = useKeyState();

  useEffect(() => {
    Promise.all([getSettings(), loadToken()])
      .then(([settings, token]) => {
        setS(settings);
        setSource(settings.keySource !== 'paste' && (settings.onboarded || !!token || settings.keySource === 'penv-app') ? 'penv' : 'paste');
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
  if (!s) {
    return (
      <main className="screen screen-center">
        <Spinner label="Loading" />
      </main>
    );
  }

  const onboarding = !s.onboarded;
  const needed = neededKeys(s);
  const missing = needed.filter((n) => !keys.loaded.includes(n));
  const roleOf = (n: string) => (n === transcriptionKeyName(s.transcription.provider) ? (n === needed[1] || needed.length === 1 ? 'transcription and the assistant' : 'transcription') : 'the assistant');

  async function pickPreset(preset: SetupPreset) {
    if (!s) return;
    setError('');
    try {
      const next = await updateSettings(applyPreset(preset, s));
      setS(next);
    } catch {
      return setError('Rekord couldn’t save your choice. Try again.');
    }
    if (preset === 'custom') navigate('setupCustom');
  }

  async function pickSource(next: 'penv' | 'paste') {
    setError('');
    setSource(next);
    if (next === 'penv') {
      try {
        await updateSettings({ keySource: s?.keySource === 'penv-app' ? 'penv-app' : 'penv' });
      } catch {
        return setError('Rekord couldn’t save your choice. Try again.');
      }
      navigate('penvConnect');
    }
  }

  async function take(raw: string, ask = true) {
    setError('');
    const c = classifyPaste(raw);
    if (c.kind === 'empty') return;
    setValue('');
    if (c.kind === 'unknown') return setUnknown(raw.trim());
    setUnknown('');
    await keys.add(c.name, raw, ask);
  }

  async function takeAs(name: KeyName) {
    const raw = unknown;
    setUnknown('');
    await keys.add(name, raw);
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!text.trim()) return;
    e.preventDefault();
    void take(text);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void take(value);
    }
  }

  async function start() {
    if (!s) return;
    // First call keeps the click's gesture: hosts for the chosen providers, also covering keys added on blur.
    const hosts = requestHosts(hostsForSettings(s, keys.loaded));
    setBusy(true);
    setError('');
    await hosts;
    try {
      await updateSettings({ keySource: source === 'paste' ? 'paste' : s.keySource === 'penv-app' ? 'penv-app' : 'penv', onboarded: true });
      replace('start');
    } catch {
      setError('Rekord couldn’t save your choices. Try again.');
      setBusy(false);
    }
  }

  const rejected = keys.loaded.filter((n) => keys.status[n] === 'rejected') as KeyName[];
  const ready = canStart(needed, keys.loaded, keys.status);

  return (
    <main className="screen" style={PAGE}>
      <SetupHead step={onboarding} onBack={() => (canGoBack ? back() : replace(onboarding ? 'permissions' : 'start'))} />
      <SetupIntro title="Set up your AI" text="Rekord needs an AI service to turn your meetings into notes. Choose how you’d like it to work, then add your key." />

      <div aria-label="How it fits together" style={{ margin: '16px 24px 0', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <div style={{ ...CARD, padding: 12, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <IconBox><svg {...ICON}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></svg></IconBox>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Transcription</span>
          <span style={{ fontSize: 12, lineHeight: 1.4, color: '#5F6168' }}>Writes down what everyone says.</span>
        </div>
        <div style={{ ...CARD, padding: 12, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <IconBox><svg {...ICON}><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg></IconBox>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Assistant</span>
          <span style={{ fontSize: 12, lineHeight: 1.4, color: '#5F6168' }}>Summarizes, spots action items and answers your questions.</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate('howItWorks')}
        style={{ ...LINK, margin: '8px 24px 0', padding: 0, border: 'none', background: 'transparent', font: 'inherit', fontSize: 13, color: '#4F46E5', textAlign: 'left', alignSelf: 'flex-start', cursor: 'pointer' }}
      >
        How Rekord handles your meetings
      </button>

      <fieldset style={{ margin: '18px 24px 0', padding: 0, border: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <legend style={{ padding: '0 0 8px', fontSize: 12, fontWeight: 600, color: '#44464D' }}>How should Rekord work?</legend>
        {PRESETS.map((p) => (
          <label key={p.id} style={{ ...CARD, display: 'flex', gap: 12, alignItems: 'flex-start', padding: 14, borderRadius: 14, border: s.setup === p.id ? '2px solid #4F46E5' : '1px solid #E8E8EB', cursor: 'pointer' }}>
            <input
              type="radio"
              name="preset"
              checked={s.setup === p.id}
              onChange={() => void pickPreset(p.id)}
              onClick={() => p.id === 'custom' && s.setup === 'custom' && navigate('setupCustom')}
              style={{ width: 18, height: 18, margin: '1px 0 0', accentColor: '#4F46E5' }}
            />
            <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
                {p.title}
                {p.badge && <span style={{ padding: '2px 7px', borderRadius: 999, background: '#EEF0FF', color: '#3730A3', fontSize: 11, fontWeight: 600 }}>{p.badge}</span>}
              </span>
              <span style={{ fontSize: 12, lineHeight: 1.4, color: '#5F6168' }}>{p.text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div style={{ ...CARD, margin: '18px 24px 0', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SourceToggle value={source} onPick={(v) => void pickSource(v)} />
        <span style={{ fontSize: 12, lineHeight: 1.45, color: '#6E7079' }}>
          Keep your keys in one safe place and change them any time with <PenvCloudLink />.
        </span>

        {source === 'penv' ? null : (
          <>
            <label htmlFor="anykey" style={LABEL}>Paste your API key</label>
            <input
              id="anykey"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onPaste={onPaste}
              onKeyDown={onKey}
              onBlur={() => value.trim() && void take(value, false)}
              autoComplete="off"
              spellCheck={false}
              style={INPUT}
            />

            {unknown && (
              <div style={{ ...CARD, padding: 14, borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Which service is this key from?</span>
                <span style={{ fontSize: 13, lineHeight: 1.45, color: '#5F6168' }}>Rekord didn’t recognize it. Pick the service and Rekord will check the key.</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {SERVICE_CHOICES.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => void takeAs(n)}
                      style={{ height: 32, padding: '0 12px', border: '1px solid #DCDCE0', borderRadius: 999, background: '#FFFFFF', font: 'inherit', fontSize: 12, fontWeight: 500, color: '#111114', cursor: 'pointer' }}
                    >
                      {serviceLabel(n)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <ul aria-label="Recognized keys" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {keys.loaded.map((n) => {
                const st = keys.status[n] ?? 'checking';
                return (
                  <li key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: '#F6F6F7' }}>
                    <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>This is a {serviceLabel(n)} key</span>
                      <span style={{ fontSize: 12, color: '#5F6168' }}>{rowDetail(n as KeyName, st)}</span>
                    </span>
                    <StatusDot status={st} />
                  </li>
                );
              })}
              {keys.ready && missing.map((n) => (
                <li key={`need-${n}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: '#F6F6F7' }}>
                  <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>Add your {serviceLabel(n)} key</span>
                    <span style={{ fontSize: 12, color: '#5F6168' }}>Needed for {roleOf(n)}</span>
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#6E7079' }}>Needed</span>
                </li>
              ))}
            </ul>

            {rejected.map((n) => (
              <div key={`rej-${n}`} role="alert" style={{ padding: '12px 14px', borderRadius: 14, background: '#FDECEC', border: '1px solid #F2C9C7', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#8A1C14' }}>{serviceLabel(n)} didn’t accept this key</span>
                <span style={{ fontSize: 13, lineHeight: 1.45, color: '#8A1C14' }}>
                  Make sure you copied all of it, or <ExternalLink href={KEY_PAGE[n]} style={{ color: '#8A1C14', fontWeight: 600 }}>create a new key</ExternalLink>.
                </span>
              </div>
            ))}

            <span style={{ fontSize: 12, lineHeight: 1.45, color: '#6E7079' }}>
              Your key stays in this browser session and is never saved. Don’t have one? <ExternalLink href={GROQ_KEYS}>Get a free Groq key</ExternalLink>
            </span>
          </>
        )}
      </div>

      {error && <div className="perm-error" role="alert" style={{ margin: '12px 24px 0' }}>{error}</div>}

      <StartFooter disabled={!ready} busy={busy} hint={startHint(needed, keys.loaded, keys.status)} onStart={() => void start()} />
    </main>
  );
}
