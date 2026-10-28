import { useEffect, useRef, type ReactNode } from 'react';
import { markWhatsNewSeen } from '@/lib/whatsNew';
import { useRouter } from '../router';

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: '#4F46E5', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

const ITEMS: { title: string; text: string; icon: ReactNode }[] = [
  {
    title: 'Works with Zoom and Teams apps',
    text: 'Record meetings in desktop apps, not just in Chrome.',
    icon: <svg {...ICON}><rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8" /></svg>,
  },
  {
    title: 'Real-time transcripts',
    text: 'Words appear as people speak, with each voice labelled.',
    icon: <svg {...ICON}><path d="M4 12h3l3-7 4 14 3-7h3" /></svg>,
  },
  {
    title: 'Ask all your meetings',
    text: 'Find decisions and open actions across everything you’ve recorded.',
    icon: <svg {...ICON}><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>,
  },
  {
    title: 'Calendar, Docs and Notion',
    text: 'Meetings name themselves, and you can share them in one tap.',
    icon: <svg {...ICON}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  },
];

export default function WhatsNew() {
  const { replace, navigate } = useRouter();
  const primary = useRef<HTMLButtonElement>(null);

  async function finish(next: () => void) {
    try {
      await markWhatsNewSeen(browser.runtime.getManifest().version);
    } catch (error) {
      console.error('Rekord: could not save that you saw what’s new', error);
    }
    next();
  }
  const connect = () => void finish(() => { replace('start'); navigate('connections'); });
  const later = () => void finish(() => replace('start'));

  useEffect(() => {
    primary.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') later(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main style={{ minHeight: '100vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: '#6B6C73', color: '#111114' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="wn-title" style={{ padding: '10px 16px 20px', borderRadius: '24px 24px 0 0', background: '#FFFFFF', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <span aria-hidden="true" style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, background: '#DCDCE0' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, color: '#6E7079' }}>Updated just now</span>
          <h1 id="wn-title" style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>What’s new in Rekord</h1>
        </div>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ITEMS.map((item) => (
            <li key={item.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, background: '#EEF0FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{item.icon}</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{item.title}</span>
                <span style={{ fontSize: 13, lineHeight: 1.45, color: '#5F6168' }}>{item.text}</span>
              </span>
            </li>
          ))}
        </ul>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button ref={primary} type="button" onClick={connect} style={{ height: 48, border: 0, borderRadius: 12, background: '#111114', color: '#FFFFFF', font: 'inherit', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
            Connect your calendar
          </button>
          <button type="button" onClick={later} style={{ height: 44, border: 0, borderRadius: 12, background: 'transparent', color: '#44464D', font: 'inherit', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
            Maybe later
          </button>
        </div>
      </div>
    </main>
  );
}
