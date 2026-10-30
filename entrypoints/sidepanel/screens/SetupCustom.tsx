import { useEffect, useState, type ClipboardEvent, type ReactNode } from 'react';
import { Spinner } from '../components';
import { useRouter } from '../router';
import { summaryFor, transcriptionFor, transcriptionKeyName } from '@/lib/connect';
import { hostsForSettings, requestHosts } from '@/lib/hosts';
import { serviceLabel, type KeyName } from '@/lib/keyDetect';
import { getSettings, PROVIDERS, updateSettings } from '@/lib/settings';
import { canStart, neededKeys, startHint } from '@/lib/setup';
import type { ProviderId, Settings, TranscriptionProvider } from '@/lib/types';
import { CARD, INPUT, LABEL, PAGE, SELECT, SetupHead, SetupIntro, StartFooter, StatusDot, useKeyState, type KeyState } from './setupParts';

const ICON = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: '#4F46E5', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

const TRANSCRIPTION: { id: TranscriptionProvider; name: string; text: string }[] = [
  { id: 'groq', name: 'Groq', text: 'Free to start. Your transcript appears a few seconds after people speak.' },
  { id: 'openai', name: 'OpenAI', text: 'Your transcript appears a few seconds after people speak.' },
  { id: 'deepgram', name: 'Deepgram', text: 'Words appear as people speak, and voices are told apart. Deepgram is a paid service.' },
];

const ASSISTANTS: { id: ProviderId; label: string }[] = [
  { id: 'groq', label: 'Groq (free to start)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'ollama', label: 'Ollama on this computer' },
];

const GROQ_MODELS = [
  { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (recommended)' },
  { value: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
];

function Section({ id, title, icon, children }: { id: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} style={{ ...CARD, margin: '12px 24px 0', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, background: '#EEF0FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
        <h2 id={id} style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** A key field for one service: label with status, and a box to paste or replace the key. */
function KeyField({ id, name, keys, onChange }: { id: string; name: KeyName; keys: KeyState; onChange?: () => void }) {
  const [value, setValue] = useState('');
  const has = keys.loaded.includes(name);
  const status = keys.status[name];

  async function take(raw: string, ask = true) {
    const v = raw.trim();
    if (!v) return;
    setValue('');
    // The field belongs to one service, so the key is checked as that service even if its prefix is different.
    await keys.add(name, v, ask);
    onChange?.();
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!text.trim()) return;
    e.preventDefault();
    void take(text);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={id} style={{ ...LABEL, display: 'flex', justifyContent: 'space-between' }}>
        {serviceLabel(name)} key
        {has && status && <StatusDot status={status} />}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        placeholder={has ? '••••••••••••••••' : undefined}
        onChange={(e) => setValue(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void take(value))}
        onBlur={() => value.trim() && void take(value, false)}
        autoComplete="off"
        spellCheck={false}
        style={INPUT}
      />
    </div>
  );
}

export default function SetupCustom() {
  const { route, replace, back, canGoBack } = useRouter();
  const [s, setS] = useState<Settings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keys = useKeyState();

  useEffect(() => {
    getSettings().then(setS).catch(() => setLoadFailed(true));
  }, []);

  useEffect(() => {
    if (s && route.params.section) document.getElementById(route.params.section === 'assistant' ? 'a-h' : 't-h')?.scrollIntoView?.({ block: 'start' });
  }, [s, route.params.section]);

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

  async function save(partial: Partial<Settings>) {
    setError('');
    try {
      setS(await updateSettings({ setup: 'custom', ...partial }));
    } catch {
      setError('Rekord couldn’t save that change. Try again.');
    }
  }

  const tKey = transcriptionKeyName(s.transcription.provider) as KeyName | undefined;
  const aKey = PROVIDERS[s.summary.provider].keyName as KeyName | undefined;
  const sameKey = !!aKey && aKey === tKey;
  const backupCovered = s.transcription.provider === 'deepgram' && s.realtimeBackup && s.summary.provider === 'groq';
  const needed = neededKeys(s);
  const ready = canStart(needed, keys.loaded, keys.status);
  const onboarding = !s.onboarded;
  const groqModels = s.summary.provider === 'groq';

  async function start() {
    const hosts = requestHosts(hostsForSettings(s!, keys.loaded));
    setBusy(true);
    setError('');
    await hosts;
    try {
      await updateSettings({ onboarded: true });
      replace('start');
    } catch {
      setError('Rekord couldn’t save your choices. Try again.');
      setBusy(false);
    }
  }

  return (
    <main className="screen" style={PAGE}>
      <SetupHead step={onboarding} onBack={() => (canGoBack ? back() : replace('connect'))} />
      <SetupIntro title="Choose your services" text="Pick who writes down the meeting and who helps you with it. If one service does both, you only need its key once." />

      <Section id="t-h" title="Transcription" icon={<svg {...ICON}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></svg>}>
        <div role="radiogroup" aria-labelledby="t-h" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4, padding: 4, borderRadius: 10, background: '#F1F1F3' }}>
          {TRANSCRIPTION.map((t) => {
            const on = s.transcription.provider === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  if (on) return;
                  const transcription = transcriptionFor(t.id, s.transcription);
                  // Choosing a provider is the click Chrome's host prompt needs; selects and blurs wait for Start.
                  void requestHosts(hostsForSettings({ ...s, transcription }, keys.loaded));
                  void save({ transcription });
                }}
                style={{ height: 34, border: 'none', borderRadius: 7, font: 'inherit', fontSize: 12, cursor: 'pointer', background: on ? '#FFFFFF' : 'transparent', fontWeight: on ? 600 : 500, color: on ? '#111114' : '#5F6168', boxShadow: on ? '0 1px 2px rgba(16,16,20,0.08)' : undefined }}
              >
                {t.name}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 12, lineHeight: 1.45, color: '#5F6168' }}>{TRANSCRIPTION.find((t) => t.id === s.transcription.provider)?.text}</span>
        {tKey && <KeyField id="tk" name={tKey} keys={keys} />}
        {s.transcription.provider === 'deepgram' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={s.realtimeBackup}
              onChange={(e) => void save({ realtimeBackup: e.target.checked })}
              style={{ width: 18, height: 18, margin: 0, accentColor: '#4F46E5' }}
            />
            Switch to Groq if Deepgram stops working
          </label>
        )}
      </Section>

      <Section id="a-h" title="Assistant" icon={<svg {...ICON}><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="as" style={LABEL}>Service</label>
          <select
            id="as"
            value={s.summary.provider}
            onChange={(e) => void save({ summary: summaryFor(e.target.value as ProviderId, s.summary) })}
            style={SELECT}
          >
            {ASSISTANTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
        {aKey && sameKey && (
          <span style={{ fontSize: 12, color: '#5F6168' }}>This key also covers the assistant.</span>
        )}
        {aKey && !sameKey && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <KeyField id="gk" name={aKey} keys={keys} />
            {backupCovered && <span style={{ fontSize: 12, color: '#5F6168' }}>This key also covers the switch-over above.</span>}
          </div>
        )}
        <details style={{ fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 500, color: '#4F46E5' }}>Model</summary>
          {groqModels ? (
            <select
              aria-label="Assistant model"
              value={s.summary.model}
              onChange={(e) => void save({ summary: { ...s.summary, model: e.target.value } })}
              style={{ ...SELECT, marginTop: 8, width: '100%', height: 38, fontSize: 13 }}
            >
              {GROQ_MODELS.some((m) => m.value === s.summary.model) ? null : <option value={s.summary.model}>{s.summary.model}</option>}
              {GROQ_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          ) : (
            <input
              aria-label="Assistant model"
              type="text"
              key={s.summary.provider}
              defaultValue={s.summary.model}
              spellCheck={false}
              onBlur={(e) => {
                const model = e.target.value.trim();
                if (model && model !== s.summary.model) void save({ summary: { ...s.summary, model } });
              }}
              style={{ ...INPUT, marginTop: 8, width: '100%', height: 38 }}
            />
          )}
          {s.summary.provider === 'ollama' && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="ollama-url" style={LABEL}>Ollama address</label>
              <input
                id="ollama-url"
                type="url"
                defaultValue={s.summary.baseUrl ?? PROVIDERS.ollama.baseUrl}
                spellCheck={false}
                onBlur={(e) => {
                  const baseUrl = e.target.value.trim().replace(/\/+$/, '');
                  void save({ summary: { ...s.summary, baseUrl: baseUrl || undefined } });
                }}
                style={{ ...INPUT, width: '100%' }}
              />
            </div>
          )}
        </details>
      </Section>

      {error && <div className="perm-error" role="alert" style={{ margin: '12px 24px 0' }}>{error}</div>}

      <StartFooter disabled={!ready} busy={busy} hint={startHint(needed, keys.loaded, keys.status)} onStart={() => void start()} note="Your keys stay in this browser session and are never saved." />
    </main>
  );
}
