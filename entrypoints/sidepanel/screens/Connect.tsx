import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button, Spinner } from '../components';
import { useRouter } from '../router';
import {
  connectErrorMessage,
  connectPaste,
  connectPenv,
  formatEnvPath,
  optionalKeyNames,
  parseEnvPath,
  requiredKeyNames,
  verifyOrForget,
} from '@/lib/connect';
import { getSettings, updateSettings } from '@/lib/settings';
import type { Settings } from '@/lib/types';

type Source = Settings['keySource'];

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

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
        setSource(s.keySource);
        setEnvPath(formatEnvPath(s.penv));
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
  if (!settings) {
    return (
      <main className="screen screen-center">
        <Spinner label="Loading" />
      </main>
    );
  }

  const needed = requiredKeyNames(settings);
  const optional = optionalKeyNames(settings);
  const onboarding = !settings.onboarded;

  function pick(next: Source) {
    setSource(next);
    setError('');
    setFound([]);
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
    if (!settings) return;
    setError('');
    setFound([]);
    const target = parseEnvPath(envPath);
    if (source === 'penv') {
      if (!target) return setError('Enter the environment as org/project/environment.');
      if (!token.trim()) return setError('Enter your read-only machine token.');
    } else if (needed.some((n) => !pasted[n]?.trim())) {
      return setError('Paste a key for each service, then try again.');
    }

    setBusy(true);
    try {
      const names =
        source === 'penv' && target
          ? await connectPenv(token.trim(), target)
          : await connectPaste(Object.fromEntries([...needed, ...optional].map((n) => [n, pasted[n] ?? ''])));
      setFound(names);
      if (source === 'penv' && target) await updateSettings({ penv: target });
      await verifyOrForget(settings);
      await updateSettings({ keySource: source, onboarded: true });
      setToken('');
      replace('start');
    } catch (err) {
      setError(connectErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

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
                <input id="env" type="text" placeholder="org/project/environment" value={envPath} onChange={(e) => setEnvPath(e.target.value)} autoComplete="off" spellCheck={false} />
              </div>
              <div className="conn-field">
                <label htmlFor="tok">Read-only machine token</label>
                <input id="tok" type="password" placeholder="pck_…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
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
          {source === 'paste' &&
            [...needed, ...optional].map((name) => (
              <div className="conn-field" key={name}>
                <label htmlFor={`key-${name}`}>{PROVIDER_LABEL[name] ?? name}</label>
                <input
                  id={`key-${name}`}
                  type="password"
                  value={pasted[name] ?? ''}
                  onChange={(e) => setPasted((p) => ({ ...p, [name]: e.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ))}
        </div>
      </div>

      {found.length > 0 && !error && (
        <p className="conn-found" role="status">Found {found.join(', ')}. Checking…</p>
      )}
      {error && (
        <div className="perm-error" role="alert">
          {error}
          {found.length > 0 && <span className="conn-found-inline"> Keys found: {found.join(', ')}.</span>}
        </div>
      )}

      <footer className="footer">
        <Button block onClick={connect} disabled={busy}>
          {busy ? <Spinner label="Connecting" size={16} /> : null}
          Connect and finish
        </Button>
      </footer>
    </main>
  );
}
