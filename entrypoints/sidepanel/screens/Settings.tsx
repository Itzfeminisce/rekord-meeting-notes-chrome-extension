import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '../components';
import { useRouter } from '../router';
import { connectErrorMessage, forgetAll, formatEnvPath, loadToken, reconnect, transcriptionKeyName } from '@/lib/connect';
import { deleteMeeting, listMeetings } from '@/lib/db';
import { loadKeys } from '@/lib/keys';
import { onMessage, send } from '@/lib/messages';
import { getSettings, PROVIDERS, updateSettings } from '@/lib/settings';
import type { ProviderId, RecordingState, Settings as SettingsT } from '@/lib/types';

const NAMES: Record<ProviderId, string> = {
  groq: 'Groq',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

type TranscriptionId = SettingsT['transcription']['provider'];
const TRANSCRIPTION_MODELS: Record<TranscriptionId, { value: string; label: string }[]> = {
  groq: [
    { value: 'whisper-large-v3', label: 'whisper-large-v3' },
    { value: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo' },
  ],
  openai: [{ value: 'whisper-1', label: 'whisper-1' }],
  deepgram: [{ value: 'nova-3', label: 'nova-3' }],
};
const TRANSCRIPTION_NAMES: Record<TranscriptionId, string> = { groq: NAMES.groq, openai: NAMES.openai, deepgram: 'Deepgram' };
const SUMMARY_MODELS: Partial<Record<ProviderId, { value: string; label: string }[]>> = {
  groq: [
    { value: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b' },
    { value: 'openai/gpt-oss-120b', label: 'gpt-oss-120b' },
  ],
};
const SUMMARY_DEFAULT: Record<ProviderId, string> = {
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openai/gpt-oss-120b',
  ollama: 'llama3.2',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
};

function keyLine(id: ProviderId): string {
  const name = PROVIDERS[id].keyName;
  return name ? `${NAMES[id]} · ${name}` : `${NAMES[id]} · no key needed`;
}

function transcriptionKeyLine(id: TranscriptionId): string {
  const name = transcriptionKeyName(id);
  return name ? `${TRANSCRIPTION_NAMES[id]} · ${name}` : `${TRANSCRIPTION_NAMES[id]} · no key needed`;
}

export default function Settings() {
  const { navigate, replace } = useRouter();
  const [s, setS] = useState<SettingsT | null>(null);
  const [keyCount, setKeyCount] = useState(0);
  const [dgKey, setDgKey] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [meetings, setMeetings] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<'' | 'refresh' | 'delete'>('');
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [recording, setRecording] = useState(false);

  const refreshKeyState = useCallback(async () => {
    const keys = await loadKeys();
    setKeyCount(Object.keys(keys).length);
    setDgKey(!!keys.DEEPGRAM_API_KEY?.trim());
    setHasToken(!!(await loadToken()));
  }, []);

  useEffect(() => {
    Promise.all([getSettings(), refreshKeyState()])
      .then(([settings]) => setS(settings))
      .catch(() => setLoadFailed(true));
    listMeetings()
      .then((m) => setMeetings(m.length))
      .catch(() => setMeetings(null));
  }, [refreshKeyState]);

  useEffect(() => {
    const apply = (state?: RecordingState) => setRecording(!!state && state.status !== 'idle');
    send<RecordingState>({ type: 'recording/get-state' })
      .then(apply)
      .catch(() => setRecording(false));
    return onMessage((msg) => {
      if (msg.type === 'recording/state') apply(msg.state);
    });
  }, []);

  async function save(partial: Partial<SettingsT>) {
    try {
      setS(await updateSettings(partial));
    } catch {
      setMessage({ kind: 'error', text: 'Couldn’t save that change. Try again.' });
    }
  }

  async function refresh() {
    setMessage(null);
    if (!hasToken) return navigate('connect');
    setBusy('refresh');
    try {
      const names = await reconnect();
      if (!names) return navigate('connect');
      setMessage({ kind: 'ok', text: `Keys refreshed: ${names.join(', ')}.` });
    } catch (err) {
      setMessage({ kind: 'error', text: connectErrorMessage(err) });
    } finally {
      await refreshKeyState();
      setBusy('');
    }
  }

  async function clear() {
    setMessage(null);
    try {
      await forgetAll();
      await refreshKeyState();
      setMessage({ kind: 'ok', text: 'Keys cleared from memory.' });
    } catch {
      setMessage({ kind: 'error', text: 'Couldn’t clear the keys. Try again.' });
    }
  }

  async function deleteAll() {
    setBusy('delete');
    setMessage(null);
    try {
      const state = await send<RecordingState>({ type: 'recording/get-state' });
      if (state && state.status !== 'idle') {
        setRecording(true);
        setConfirmDelete(false);
        return;
      }
      for (const m of await listMeetings()) await deleteMeeting(m.id);
      setMeetings(0);
      setConfirmDelete(false);
      setMessage({ kind: 'ok', text: 'All meetings deleted.' });
    } catch {
      setMessage({ kind: 'error', text: 'Couldn’t delete every meeting. Try again.' });
    } finally {
      setBusy('');
    }
  }

  const header = (
    <header className="set-head">
      <button type="button" className="perm-back" aria-label="Back to home" onClick={() => replace('start')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <h1>Settings</h1>
    </header>
  );

  if (loadFailed) {
    return (
      <main className="screen">
        {header}
        <div className="perm-error" role="alert">Rekord couldn’t load your settings. Try reopening the side panel.</div>
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

  const connected = keyCount > 0;
  const dgName = s.diarization.keyName;
  const hasDeepgram = dgKey;
  const setFeature = (k: keyof SettingsT['features'], on: boolean) => save({ features: { ...s.features, [k]: on } });
  const toggles: { id: string; title: string; sub: string; on: boolean; disabled?: boolean; set: (on: boolean) => void; hint?: string }[] = [
    { id: 'ask', title: 'Ask about the meeting', sub: 'Ask questions during or after a meeting', on: s.features.ask, set: (on) => setFeature('ask', on) },
    { id: 'suggest', title: 'Suggest action items live', sub: 'Flags likely tasks as people talk', on: s.features.liveSuggestions, set: (on) => setFeature('liveSuggestions', on) },
    {
      id: 'names', title: 'Speaker names', sub: 'Tells other voices apart and suggests names', on: s.features.speakerNames && hasDeepgram,
      disabled: !hasDeepgram, set: (on) => setFeature('speakerNames', on),
      hint: hasDeepgram ? undefined : `Add ${dgName} in Connect AI to turn this on.`,
    },
    { id: 'keep', title: 'Keep audio files', sub: 'Off: audio is discarded once transcribed', on: s.keepAudio, set: (on) => save({ keepAudio: on }) },
  ];
  const summaryOptions = SUMMARY_MODELS[s.summary.provider];

  return (
    <main className="screen">
      {header}
      <div className="set-body">
        <section className="set-section" aria-labelledby="h-keys">
          <h2 id="h-keys">API keys</h2>
          <div className="set-card set-pad">
            <div className="set-src">
              <span className="set-src-icon" aria-hidden="true">{s.keySource === 'penv' ? 'pv' : 'key'}</span>
              <span className="set-text">
                <span className="set-title">{s.keySource === 'penv' ? 'penv cloud' : 'Paste keys here'}</span>
                {s.keySource === 'penv' && <span className="set-mono">{formatEnvPath(s.penv)}</span>}
              </span>
              <span className={`set-status${connected ? ' on' : ''}`}>
                <span aria-hidden="true" />
                {connected ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <div className="set-keys">
              <span>{keyCount === 1 ? '1 key in memory' : `${keyCount} keys in memory`}</span>
              {s.keySource === 'penv' && (
                <button type="button" className="set-mini" onClick={refresh} disabled={busy === 'refresh'}>
                  {busy === 'refresh' ? 'Refreshing…' : hasToken ? 'Refresh' : 'Reconnect'}
                </button>
              )}
            </div>
            <div className="set-links">
              <button type="button" className="set-link" onClick={() => navigate('connect')}>Change key source</button>
              <button type="button" className="set-link set-link-danger" onClick={clear} disabled={!connected && !hasToken}>Clear keys</button>
            </div>
          </div>
        </section>

        <section className="set-section" aria-labelledby="h-models">
          <h2 id="h-models">Models</h2>
          <div className="set-card">
            <div className="set-row">
              <span className="set-text">
                <span className="set-label">Transcription</span>
                <span className="set-sub">{transcriptionKeyLine(s.transcription.provider)}</span>
              </span>
              <span className="set-controls">
                <select
                  aria-label="Transcription service"
                  value={s.transcription.provider}
                  onChange={(e) => {
                    const provider = e.target.value as TranscriptionId;
                    save({ transcription: { provider, model: TRANSCRIPTION_MODELS[provider][0]?.value ?? '' } });
                  }}
                >
                  {(Object.keys(TRANSCRIPTION_MODELS) as TranscriptionId[]).map((id) => (
                    <option key={id} value={id}>{TRANSCRIPTION_NAMES[id]}</option>
                  ))}
                </select>
                <select
                  aria-label="Transcription model"
                  value={s.transcription.model}
                  onChange={(e) => save({ transcription: { ...s.transcription, model: e.target.value } })}
                >
                  {TRANSCRIPTION_MODELS[s.transcription.provider].map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </span>
            </div>
            <div className="set-row">
              <span className="set-text">
                <span className="set-label">Assistant</span>
                <span className="set-sub">{keyLine(s.summary.provider)}</span>
              </span>
              <span className="set-controls">
                <select
                  aria-label="Assistant service"
                  value={s.summary.provider}
                  onChange={(e) => {
                    const provider = e.target.value as ProviderId;
                    save({ summary: { provider, model: SUMMARY_DEFAULT[provider] } });
                  }}
                >
                  {(Object.keys(NAMES) as ProviderId[]).map((id) => (
                    <option key={id} value={id}>{NAMES[id]}</option>
                  ))}
                </select>
                {summaryOptions ? (
                  <select
                    aria-label="Assistant model"
                    value={s.summary.model}
                    onChange={(e) => save({ summary: { ...s.summary, model: e.target.value } })}
                  >
                    {summaryOptions.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="Assistant model"
                    type="text"
                    defaultValue={s.summary.model}
                    key={s.summary.provider}
                    spellCheck={false}
                    onBlur={(e) => {
                      const model = e.target.value.trim();
                      if (model && model !== s.summary.model) save({ summary: { ...s.summary, model } });
                    }}
                  />
                )}
              </span>
            </div>
            {s.summary.provider === 'ollama' && (
              <div className="set-row">
                <label className="set-text" htmlFor="ollama-url">
                  <span className="set-label">Ollama address</span>
                  <span className="set-sub">Where Ollama runs on this computer</span>
                </label>
                <input
                  id="ollama-url"
                  type="url"
                  className="set-wide"
                  defaultValue={s.summary.baseUrl ?? PROVIDERS.ollama.baseUrl}
                  spellCheck={false}
                  onBlur={(e) => {
                    const baseUrl = e.target.value.trim().replace(/\/+$/, '');
                    save({ summary: { ...s.summary, baseUrl: baseUrl || undefined } });
                  }}
                />
              </div>
            )}
          </div>
        </section>

        <section className="set-section" aria-labelledby="h-rec">
          <h2 id="h-rec">Recording</h2>
          <div className="set-card">
            {toggles.map((t) => (
              <label key={t.id} className="set-row" htmlFor={`sw-${t.id}`}>
                <span className="set-text">
                  <span className="set-label">{t.title}</span>
                  <span className="set-sub">{t.sub}</span>
                  {t.hint && <span className="set-sub" id={`hint-${t.id}`}>{t.hint}</span>}
                </span>
                <input
                  id={`sw-${t.id}`}
                  type="checkbox"
                  role="switch"
                  checked={t.on}
                  disabled={t.disabled}
                  aria-describedby={t.hint ? `hint-${t.id}` : undefined}
                  onChange={(e) => t.set(e.target.checked)}
                  style={{ width: 18, height: 18, margin: 0, accentColor: '#4F46E5' }}
                />
              </label>
            ))}
            <div className="set-row">
              <span className="set-text">
                <span className="set-label">Speaker name key</span>
                <span className="set-sub" role="status">{hasDeepgram ? `${dgName} is loaded` : `${dgName} is not loaded`}</span>
              </span>
            </div>
          </div>
        </section>

        <section className="set-section" aria-labelledby="h-lang">
          <h2 id="h-lang">Language</h2>
          <div className="set-card">
            <div className="set-row">
              <label className="set-text" htmlFor="lang">
                <span className="set-label">Meeting language</span>
              </label>
              <select id="lang" value={s.language} onChange={(e) => save({ language: e.target.value as SettingsT['language'] })}>
                <option value="en">English</option>
                <option value="auto">Auto-detect</option>
              </select>
            </div>
          </div>
        </section>

        <section className="set-section" aria-labelledby="h-data">
          <h2 id="h-data">Your data</h2>
          <div className="set-card set-pad">
            <div className="set-src">
              <span className="set-text">
                <span className="set-label">
                  {meetings === null
                    ? 'Meetings on this computer'
                    : meetings === 1
                      ? '1 meeting on this computer'
                      : `${meetings} meetings on this computer`}
                </span>
              </span>
              {!confirmDelete && (
                <button type="button" className="set-danger" onClick={() => setConfirmDelete(true)} disabled={meetings === 0 || recording}>
                  Delete all
                </button>
              )}
            </div>
            {recording && <span className="set-sub" role="status">Stop recording first.</span>}
            {confirmDelete && !recording && (
              <div className="set-confirm" role="alertdialog" aria-label="Delete all meetings">
                <span>Delete every meeting, transcript and note? This can’t be undone.</span>
                <span className="set-confirm-actions">
                  <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={busy === 'delete'}>Cancel</Button>
                  <button type="button" className="set-danger" onClick={deleteAll} disabled={busy === 'delete'} autoFocus>
                    {busy === 'delete' ? 'Deleting…' : 'Delete all'}
                  </button>
                </span>
              </div>
            )}
          </div>
        </section>

        {message && (
          <div className={message.kind === 'error' ? 'perm-error set-msg' : 'set-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>
            {message.text}
          </div>
        )}
      </div>
    </main>
  );
}
