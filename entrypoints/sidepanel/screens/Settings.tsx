import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '../components';
import { useRouter } from '../router';
import { deleteMeeting, listMeetings } from '@/lib/db';
import { loadKeys } from '@/lib/keys';
import { onMessage, send } from '@/lib/messages';
import { getSettings, updateSettings } from '@/lib/settings';
import type { RecordingState, Settings as SettingsT } from '@/lib/types';

export default function Settings() {
  const { back, replace, canGoBack } = useRouter();
  const [s, setS] = useState<SettingsT | null>(null);
  const [dgKey, setDgKey] = useState(false);
  const [meetings, setMeetings] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<'' | 'delete'>('');
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [recording, setRecording] = useState(false);

  const refreshKeyState = useCallback(async () => {
    const keys = await loadKeys();
    setDgKey(!!keys.DEEPGRAM_API_KEY?.trim());
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
      <button type="button" className="perm-back" aria-label="Back to Settings" onClick={() => (canGoBack ? back() : replace('settings'))}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <h1>Recording, language and data</h1>
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

  const dgName = s.diarization.keyName;
  const hasDeepgram = dgKey;
  const setFeature = (k: keyof SettingsT['features'], on: boolean) => save({ features: { ...s.features, [k]: on } });
  const toggles: { id: string; title: string; sub: string; on: boolean; disabled?: boolean; set: (on: boolean) => void; hint?: string }[] = [
    { id: 'ask', title: 'Ask about the meeting', sub: 'Ask questions during or after a meeting', on: s.features.ask, set: (on) => setFeature('ask', on) },
    { id: 'suggest', title: 'Suggest action items live', sub: 'Flags likely tasks as people talk', on: s.features.liveSuggestions, set: (on) => setFeature('liveSuggestions', on) },
    {
      id: 'names', title: 'Speaker names', sub: 'Tells other voices apart and suggests names', on: s.features.speakerNames && hasDeepgram,
      disabled: !hasDeepgram, set: (on) => setFeature('speakerNames', on),
      hint: hasDeepgram ? undefined : 'Add a Deepgram key in Settings to turn this on.',
    },
    { id: 'keep', title: 'Keep audio files', sub: 'Off: audio is discarded once transcribed', on: s.keepAudio, set: (on) => save({ keepAudio: on }) },
  ];

  return (
    <main className="screen">
      {header}
      <div className="set-body">
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
