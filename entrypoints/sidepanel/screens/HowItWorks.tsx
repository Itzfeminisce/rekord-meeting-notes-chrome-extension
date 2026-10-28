import { useEffect, useRef } from 'react';
import { useRouter } from '../router';

const ROWS: { name: string; note?: { text: string; green?: boolean }; transcription: string; assistant: string }[] = [
  { name: 'Groq', note: { text: 'free to start', green: true }, transcription: 'Yes', assistant: 'Yes' },
  { name: 'OpenAI', transcription: 'Yes', assistant: 'Yes' },
  { name: 'Deepgram', transcription: 'Yes, in real time', assistant: 'No' },
  { name: 'Anthropic', transcription: 'No', assistant: 'Yes' },
  { name: 'OpenRouter', transcription: 'No', assistant: 'Yes' },
  { name: 'Ollama', note: { text: 'no key needed' }, transcription: 'No', assistant: 'Yes, runs on your computer' },
];

const STEP: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', padding: '10px 12px', borderRadius: 12, background: '#F6F6F7' };
const NUM: React.CSSProperties = { width: 24, height: 24, borderRadius: '50%', background: '#111114', color: '#FFFFFF', fontFamily: "'Geist Mono', monospace", fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };

/** Sheet opened from Setup and Settings. Close (or Escape) goes back. */
export default function HowItWorks() {
  const { back, replace, canGoBack } = useRouter();
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => (canGoBack ? back() : replace('connect'));

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="screen" style={{ minHeight: '100%', boxSizing: 'border-box', justifyContent: 'flex-end', background: '#6B6C73', color: '#111114' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="hw-title" style={{ padding: '10px 16px 20px', borderRadius: '24px 24px 0 0', background: '#FFFFFF', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <span aria-hidden="true" style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, background: '#DCDCE0' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 id="hw-title" style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em' }}>How Rekord handles your meetings</h1>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={close}
            style={{ width: 36, height: 36, border: 'none', borderRadius: '50%', background: '#F1F1F3', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#111114', cursor: 'pointer', flexShrink: 0 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <ol aria-label="What happens in a meeting" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li style={STEP}>
            <span style={NUM}>1</span>
            <span style={{ fontSize: 13, lineHeight: 1.4 }}>While you talk, the meeting’s audio goes to your <span style={{ fontWeight: 600 }}>transcription</span> service and comes back as text.</span>
          </li>
          <li style={STEP}>
            <span style={NUM}>2</span>
            <span style={{ fontSize: 13, lineHeight: 1.4 }}>Your transcript and notes are saved in this browser, on this computer.</span>
          </li>
          <li style={STEP}>
            <span style={NUM}>3</span>
            <span style={{ fontSize: 13, lineHeight: 1.4 }}>When Rekord writes your summary or answers a question, it sends the transcript to your <span style={{ fontWeight: 600 }}>assistant</span> service.</span>
          </li>
        </ol>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: '#6E7079' }}>What each service can do</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6E7079', fontSize: 11 }}>
                <th scope="col" style={{ padding: '6px 0', fontWeight: 500 }}>Service</th>
                <th scope="col" style={{ padding: '6px 0', fontWeight: 500 }}>Transcription</th>
                <th scope="col" style={{ padding: '6px 0', fontWeight: 500 }}>Assistant</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.name} style={{ borderTop: '1px solid #F0F0F2' }}>
                  <th scope="row" style={{ padding: '8px 0', textAlign: 'left', fontWeight: 600 }}>
                    {r.name}
                    {r.note && <> <span style={{ fontWeight: 400, color: r.note.green ? '#1A6B40' : '#6E7079', fontSize: 11 }}>{r.note.text}</span></>}
                  </th>
                  <td style={{ padding: '8px 0', color: r.transcription === 'No' ? '#6E7079' : undefined }}>{r.transcription}</td>
                  <td style={{ padding: '8px 0', color: r.assistant === 'No' ? '#6E7079' : undefined }}>{r.assistant}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p style={{ margin: 0, padding: 12, borderRadius: 12, background: '#EEF0FF', fontSize: 13, lineHeight: 1.45, color: '#2E2A8A' }}>
          Each key is only ever sent to its own service. Your audio and notes go nowhere else unless you share a meeting.
        </p>
      </div>
    </main>
  );
}
