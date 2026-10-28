import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button, Spinner } from '../components';
import { useRouter } from '../router';
import {
  checkKeys,
  connectErrorMessage,
  connectPaste,
  connectPenv,
  formatEnvPath,
  optionalKeyNames,
  parseEnvPath,
  pickProviders,
  providerWorks,
  requiredKeyNames,
  saveKeyStatus,
  summaryFor,
  transcriptionFor,
  SUMMARY_ORDER,
  TRANSCRIPTION_ORDER,
  type KeyResults,
  type KeyStatus,
} from '@/lib/connect';
import { loadKeys } from '@/lib/keys';
import { getSettings, updateSettings } from '@/lib/settings';
import type { ProviderId, Settings } from '@/lib/types';

type Source = Settings['keySource'];
type TranscriptionId = Settings['transcription']['provider'];
type Choice = Pick<Settings, 'transcription' | 'summary' | 'features'>;

const PROVIDER_NAME: Record<ProviderId, string> = {
  groq: 'Groq',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
};
const ASSISTANT_IDS: ProviderId[] = [...SUMMARY_ORDER, 'ollama'];
const STATUS_TEXT: Record<KeyStatus, string> = { ok: 'Works', rejected: 'Rejected', unreachable: 'Couldn’t check' };

const PROVIDER_LABEL: Record<string, string> = {
  GROQ_API_KEY: 'Groq API key',
  OPENAI_API_KEY: 'OpenAI API key',
  DEEPGRAM_API_KEY: 'Deepgram API key (optional, for speaker names)',
  OPENROUTER_API_KEY: 'OpenRouter API key',
  ANTHROPIC_API_KEY: 'Anthropic API key',
};

export default function Connect() {
  const { replace, back, canGoBack } = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [source, setSource] = useState<Source>('penv');
  const [envPath, setEnvPath] = useState('');
  const [token, setToken] = useState('');
  const [pasted, setPasted] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<string[]>([]);
  const [draft, setDraft] = useState<Pick<Settings, 'transcription' | 'summary'> | null>(null);
  const [results, setResults] = useState<KeyResults | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
        setSource(s.keySource);
        setEnvPath(formatEnvPath(s.penv));
        setDraft({ transcription: s.transcription, summary: s.summary });
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
  if (!settings || !draft) {
    return (
      <main className="screen screen-center">
        <Spinner label="Loading" />
      </main>
    );
  }

  const needed = requiredKeyNames(draft);
  const optional = optionalKeyNames(settings);
  const onboarding = !settings.onboarded;

  function resetCheck() {
    setError('');
    setFound([]);
    setResults(null);
    setChoice(null);
  }

  function pick(next: Source) {
    setSource(next);
    resetCheck();
  }

  function onRadioKey(e: KeyboardEvent) {
    const onRadio = (e.target as HTMLElement).getAttribute('role') === 'radio';
    if (onRadio && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const next = source === 'penv' ? 'paste' : 'penv';
      pick(next);
      requestAnimationFrame(() => document.getElementById(`src-${next}`)?.focus());
    }
  }

  async function connect() {
    if (!settings || !draft) return;
    resetCheck();
    const target = parseEnvPath(envPath);
    if (source === 'penv') {
      if (!target) return setError('Enter the environment as org/project/environment.');
      if (!token.trim()) return setError('Enter your read-only machine token.');
    } else if (![...needed, ...optional].some((n) => pasted[n]?.trim())) {
      return setError('Paste at least one key, then try again.');
    }

    setBusy(true);
    try {
      const names =
        source === 'penv' && target
          ? await connectPenv(token.trim(), target)
          : await connectPaste(Object.fromEntries([...needed, ...optional].map((n) => [n, pasted[n] ?? ''])));
      setFound(names);
      if (source === 'penv' && target) await updateSettings({ penv: target });
      setToken('');
      await check();
    } catch (err) {
      setError(connectErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Checks the keys now in memory and picks providers whose keys work. Keys are never dropped. */
  async function check() {
    if (!settings || !draft) return;
    const checked = await checkKeys(await loadKeys());
    await saveKeyStatus(checked);
    setResults(checked);
    const picked = pickProviders(checked, { ...settings, ...draft });
    const allowed = ASSISTANT_IDS.filter((id) => providerWorks(id, checked));
    if (allowed[0] && !allowed.includes(picked.summary.provider)) {
      picked.summary = summaryFor(allowed[0], { ...settings, ...draft }.summary);
    }
    setChoice(picked);
  }

  async function checkAgain() {
    setBusy(true);
    setError('');
    try {
      await check();
    } catch (err) {
      setError(connectErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!choice) return;
    setBusy(true);
    setError('');
    try {
      await updateSettings({ ...choice, keySource: source, onboarded: true });
      replace('start');
    } catch {
      setError('Rekord couldn’t save your choices. Try again.');
      setBusy(false);
    }
  }

  const transcriptionOk = TRANSCRIPTION_ORDER.filter((id) => results && providerWorks(id, results));
  const assistantOk = ASSISTANT_IDS.filter((id) => results && providerWorks(id, results));
  const rows = results ? Object.entries(results).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <main className="screen">
      <div className="perm-head">
        <button
          type="button"
          className="perm-back"
          aria-label="Back"
          onClick={() => (canGoBack ? back() : replace(onboarding ? 'permissions' : 'settings'))}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        {onboarding && <span className="step">Step 3 of 3</span>}
      </div>
      {onboarding && (
        <div className="perm-progress" role="progressbar" aria-label="Setup progress" aria-valuenow={3} aria-valuemin={1} aria-valuemax={3}>
          <span className="on" />
          <span className="on" />
          <span className="on" />
        </div>
      )}

      <section className="perm-intro">
        <h1>Connect your AI</h1>
        <p>Choose where Rekord gets its API keys. You can change this any time in Settings.</p>
      </section>

      <div className="conn-sources" role="radiogroup" aria-label="Key source" onKeyDown={onRadioKey}>
        <div
          id="src-penv"
          className={`conn-card${source === 'penv' ? ' on' : ''}`}
          role="radio"
          aria-checked={source === 'penv'}
          tabIndex={source === 'penv' ? 0 : -1}
          onClick={() => source !== 'penv' && pick('penv')}
          onKeyDown={(e) => e.target === e.currentTarget && e.key === ' ' && (e.preventDefault(), pick('penv'))}
        >
          <div className="conn-row">
            <span className="conn-dot" aria-hidden="true" />
            <span className="conn-title">penv cloud</span>
            <span className="conn-badge">Recommended</span>
          </div>
          <span className="conn-desc">Keys live in penv. Rotate them there and Rekord picks them up. Nothing is saved to disk.</span>
          {source === 'penv' && (
            <>
              <div className="conn-field">
                <label htmlFor="env">Environment</label>
                <input id="env" type="text" placeholder="org/project/environment" value={envPath} onChange={(e) => { setEnvPath(e.target.value); if (results) resetCheck(); }} autoComplete="off" spellCheck={false} />
              </div>
              <div className="conn-field">
                <label htmlFor="tok">Read-only machine token</label>
                <input id="tok" type="password" placeholder="pck_…" value={token} onChange={(e) => { setToken(e.target.value); if (results) resetCheck(); }} autoComplete="off" spellCheck={false} />
              </div>
            </>
          )}
        </div>

        <div
          id="src-paste"
          className={`conn-card${source === 'paste' ? ' on' : ''}`}
          role="radio"
          aria-checked={source === 'paste'}
          tabIndex={source === 'paste' ? 0 : -1}
          onClick={() => source !== 'paste' && pick('paste')}
          onKeyDown={(e) => e.target === e.currentTarget && e.key === ' ' && (e.preventDefault(), pick('paste'))}
        >
          <div className="conn-row">
            <span className="conn-dot" aria-hidden="true" />
            <span className="conn-title">Paste keys here</span>
          </div>
          <span className="conn-desc">Groq, OpenAI, OpenRouter or Anthropic. Kept in memory only. Nothing is saved to disk.</span>
          {source === 'paste' && (
            <>
              <div className="conn-field">
                <label htmlFor="pick-tr">Transcription</label>
                <select
                  id="pick-tr"
                  value={draft.transcription.provider}
                  onChange={(e) => {
                    setDraft({ ...draft, transcription: transcriptionFor(e.target.value as TranscriptionId, settings.transcription) });
                    resetCheck();
                  }}
                >
                  {TRANSCRIPTION_ORDER.map((id) => <option key={id} value={id}>{PROVIDER_NAME[id]}</option>)}
                </select>
              </div>
              <div className="conn-field">
                <label htmlFor="pick-as">Assistant</label>
                <select
                  id="pick-as"
                  value={draft.summary.provider}
                  onChange={(e) => {
                    setDraft({ ...draft, summary: summaryFor(e.target.value as ProviderId, settings.summary) });
                    resetCheck();
                  }}
                >
                  {ASSISTANT_IDS.map((id) => <option key={id} value={id}>{PROVIDER_NAME[id]}</option>)}
                </select>
              </div>
            </>
          )}
          {source === 'paste' &&
            [...needed, ...optional].map((name) => (
              <div className="conn-field" key={name}>
                <label htmlFor={`key-${name}`}>{PROVIDER_LABEL[name] ?? name}</label>
                <input
                  id={`key-${name}`}
                  type="password"
                  value={pasted[name] ?? ''}
                  onChange={(e) => {
                    setPasted((p) => ({ ...p, [name]: e.target.value }));
                    if (results) resetCheck();
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ))}
        </div>
      </div>

      {busy && !results && found.length > 0 && !error && (
        <p className="conn-found" role="status">Found {found.join(', ')}. Checking…</p>
      )}
      {results && choice && (
        <section className="conn-results" aria-label="Your keys">
          {rows.length === 0 ? (
            <p className="conn-desc conn-empty">Rekord didn’t find any keys it can use.</p>
          ) : (
            <ul className="conn-keys" role="status" aria-live="polite">
              {rows.map(([name, status]) => (
                <li key={name} className="conn-key">
                  <span className="conn-key-name">{name}</span>
                  <span className={`conn-status conn-status-${status}`}>{STATUS_TEXT[status]}</span>
                </li>
              ))}
            </ul>
          )}
          {transcriptionOk.length > 0 && (
            <div className="conn-field">
              <label htmlFor="use-tr">Transcription</label>
              <select
                id="use-tr"
                value={choice.transcription.provider}
                onChange={(e) => setChoice({ ...choice, transcription: transcriptionFor(e.target.value as TranscriptionId, settings.transcription) })}
              >
                {transcriptionOk.map((id) => <option key={id} value={id}>{PROVIDER_NAME[id]}</option>)}
              </select>
            </div>
          )}
          <div className="conn-field">
            <label htmlFor="use-as">Assistant</label>
            <select
              id="use-as"
              value={choice.summary.provider}
              onChange={(e) => setChoice({ ...choice, summary: summaryFor(e.target.value as ProviderId, settings.summary) })}
            >
              {assistantOk.map((id) => <option key={id} value={id}>{PROVIDER_NAME[id]}</option>)}
            </select>
          </div>
          {transcriptionOk.length === 0 && (
            <p className="conn-desc conn-empty" role="status">Rekord will record, and transcribe once a working key is added.</p>
          )}
        </section>
      )}
      {error && (
        <div className="perm-error" role="alert">
          {error}
          {found.length > 0 && <span className="conn-found-inline"> Keys found: {found.join(', ')}.</span>}
        </div>
      )}

      <footer className="footer">
        {results && choice && transcriptionOk.length > 0 ? (
          <Button block onClick={finish} disabled={busy}>
            {busy ? <Spinner label="Saving" size={16} /> : null}
            Continue
          </Button>
        ) : (
          <>
            <Button block onClick={results ? checkAgain : connect} disabled={busy}>
              {busy ? <Spinner label="Connecting" size={16} /> : null}
              {results ? 'Check again' : 'Connect'}
            </Button>
            {results && choice && (
              <Button block variant="secondary" onClick={finish} disabled={busy}>Continue anyway</Button>
            )}
          </>
        )}
      </footer>
    </main>
  );
}
