/** Pieces shared by the setup screens (Setup, SetupCustom, PenvConnect, SettingsAI). Styles follow the V3 frames. */
import { useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { checkKeys, loadKeyStatus, saveKeyStatus } from '@/lib/connect';
import { serviceLabel, type KeyName } from '@/lib/keyDetect';
import { hostsForKeys, requestHosts } from '@/lib/hosts';
import { loadKeys } from '@/lib/keys';
import { addKey, STATUS_WORD, type RowStatus } from '@/lib/setup';

export const PAGE: CSSProperties = {
  minHeight: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  background: '#F6F6F7',
  color: '#111114',
};
export const CARD: CSSProperties = { borderRadius: 16, background: '#FFFFFF', border: '1px solid #E8E8EB' };
export const LINK: CSSProperties = { textDecoration: 'none', fontWeight: 500 };
export const MONO = "'Geist Mono', monospace";
export const INPUT: CSSProperties = {
  height: 42,
  boxSizing: 'border-box',
  padding: '0 12px',
  border: '1px solid #DCDCE0',
  borderRadius: 10,
  background: '#F9F9FA',
  fontFamily: MONO,
  fontSize: 13,
  color: '#111114',
};
export const SELECT: CSSProperties = {
  height: 42,
  padding: '0 10px',
  border: '1px solid #DCDCE0',
  borderRadius: 10,
  background: '#FFFFFF',
  font: 'inherit',
  fontSize: 14,
  color: '#111114',
};
export const LABEL: CSSProperties = { fontSize: 12, fontWeight: 500, color: '#44464D' };

const STATUS_COLOR: Record<RowStatus, string> = { ok: '#1A6B40', checking: '#6E7079', rejected: '#B42318', unreachable: '#8A5A00' };
const DOT_COLOR: Record<RowStatus, string> = { ok: '#1A7F4B', checking: '#9A9BA3', rejected: '#B42318', unreachable: '#C98A00' };

export function ExternalLink({ href, children, style }: { href: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ ...LINK, ...style }}>
      {children}
    </a>
  );
}

/** The "Penv Cloud" name, always a link to penv.cloud. */
export function PenvCloudLink({ style }: { style?: CSSProperties }) {
  return <ExternalLink href="https://penv.cloud" style={style}>Penv Cloud</ExternalLink>;
}

/** Status with a dot ("Ready"). */
export function StatusDot({ status, label }: { status: RowStatus; label?: string }) {
  return (
    <span role="status" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: STATUS_COLOR[status] }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: DOT_COLOR[status] }} />
      {label ?? STATUS_WORD[status]}
    </span>
  );
}

export function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function SetupHead({ onBack, step }: { onBack: () => void; step: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
      <button
        type="button"
        aria-label="Back"
        onClick={onBack}
        style={{ width: 36, height: 36, marginLeft: -8, border: 'none', borderRadius: 10, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#111114', cursor: 'pointer' }}
      >
        <BackIcon />
      </button>
      {step && <span style={{ fontFamily: MONO, fontSize: 11, color: '#6E7079' }}>Step 3 of 3</span>}
    </div>
  );
}

export function SetupIntro({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ padding: '12px 24px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h1 style={{ margin: 0, fontSize: 26, lineHeight: 1.2, fontWeight: 600, letterSpacing: '-0.02em' }}>{title}</h1>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: '#5F6168' }}>{text}</p>
    </div>
  );
}

/** "Start using Rekord" with the hint line under it while it is disabled. */
export function StartFooter({ disabled, hint, busy, onStart, note }: { disabled: boolean; hint?: string; busy?: boolean; onStart: () => void; note?: string }) {
  return (
    <>
      <div style={{ flexGrow: 1 }} />
      <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={onStart}
          style={{ height: 48, border: 'none', borderRadius: 12, background: disabled ? '#DCDCE0' : '#111114', color: disabled ? '#6E7079' : '#FFFFFF', font: 'inherit', fontSize: 15, fontWeight: 600, cursor: disabled ? 'default' : 'pointer' }}
        >
          Start using Rekord
        </button>
        {disabled && hint && <span role="status" style={{ textAlign: 'center', fontSize: 12, color: '#6E7079' }}>{hint}</span>}
        {!disabled && note && <span style={{ textAlign: 'center', fontSize: 12, color: '#6E7079' }}>{note}</span>}
      </div>
    </>
  );
}

/** Two-way switch "Use Penv Cloud" / "Paste a key". Arrow keys move between the two. */
export function SourceToggle({ value, onPick }: { value: 'penv' | 'paste'; onPick: (v: 'penv' | 'paste') => void }) {
  const item = (id: 'penv' | 'paste', text: string) => (
    <button
      type="button"
      role="radio"
      id={`src-${id}`}
      aria-checked={value === id}
      tabIndex={value === id ? 0 : -1}
      onClick={() => value !== id && onPick(id)}
      style={{
        height: 32, border: 'none', borderRadius: 7, font: 'inherit', fontSize: 12, cursor: 'pointer',
        background: value === id ? '#FFFFFF' : 'transparent',
        fontWeight: value === id ? 600 : 500,
        color: value === id ? '#111114' : '#5F6168',
        boxShadow: value === id ? '0 1px 2px rgba(16,16,20,0.08)' : undefined,
      }}
    >
      {text}
    </button>
  );
  const onKey = (e: KeyboardEvent) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const next = value === 'penv' ? 'paste' : 'penv';
      onPick(next);
      requestAnimationFrame(() => document.getElementById(`src-${next}`)?.focus());
    }
  };
  return (
    <div role="radiogroup" aria-label="Where keys come from" onKeyDown={onKey} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4, padding: 4, borderRadius: 10, background: '#F1F1F3' }}>
      {item('penv', 'Use Penv Cloud')}
      {item('paste', 'Paste a key')}
    </div>
  );
}

export function ChosenSetupRow({ title, onChange }: { title: string; onChange: () => void }) {
  return (
    <div style={{ ...CARD, margin: '18px 24px 0', padding: '12px 14px', borderRadius: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12, color: '#6E7079' }}>How should Rekord work?</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      </span>
      <button type="button" onClick={onChange} style={{ border: 'none', background: 'transparent', font: 'inherit', fontSize: 13, color: '#4F46E5', fontWeight: 500, cursor: 'pointer' }}>
        Change
      </button>
    </div>
  );
}

export const PRESET_TITLE = { free: 'Free to start', realtime: 'Real time', custom: 'Choose my own' } as const;

export interface KeyState {
  /** Names of the keys held in memory. */
  loaded: string[];
  /** Last check per key name; 'checking' while a check runs. */
  status: Record<string, RowStatus | undefined>;
  ready: boolean;
  reload: () => Promise<void>;
  /** Saves a key for a service, checks it, and updates the status. */
  add: (name: KeyName, value: string) => Promise<RowStatus>;
}

/** Keys in memory and their last check. Checks any key that has not been checked yet. Never holds a value. */
export function useKeyState(): KeyState {
  const [loaded, setLoaded] = useState<string[]>([]);
  const [status, setStatus] = useState<Record<string, RowStatus | undefined>>({});
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    try {
      const keys = await loadKeys();
      const names = Object.keys(keys);
      const saved = await loadKeyStatus();
      setLoaded(names);
      const unchecked = names.filter((n) => !saved[n]);
      setStatus({ ...saved, ...Object.fromEntries(unchecked.map((n) => [n, 'checking' as const])) });
      setReady(true);
      if (unchecked.length > 0) {
        const result = await checkKeys(Object.fromEntries(unchecked.map((n) => [n, keys[n] ?? ''])));
        const merged = { ...saved, ...result };
        await saveKeyStatus(merged);
        setStatus((prev) => ({ ...prev, ...Object.fromEntries(unchecked.map((n) => [n, merged[n] ?? 'ok'])) }));
      }
    } catch {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(async (name: KeyName, value: string): Promise<RowStatus> => {
    setLoaded((l) => (l.includes(name) ? l : [...l, name]));
    setStatus((s) => ({ ...s, [name]: 'checking' }));
    let result: RowStatus;
    try {
      // Pasting or pressing Enter is the gesture Chrome wants; ask before any other await.
      await requestHosts(hostsForKeys([name]));
      result = await addKey(name, value);
    } catch {
      result = 'unreachable';
    }
    setStatus((s) => ({ ...s, [name]: result }));
    return result;
  }, []);

  return { loaded, status, ready, reload, add };
}

export { serviceLabel };
