/** Which audio sources to record for a meeting: 'you' = microphone, 'others' = the meeting tab. */
export interface Sources { mic: boolean; tab: boolean }

export const DEFAULT_SOURCES: Sources = { mic: true, tab: true };

/** Normalise a (possibly missing) choice: absent fields default to on, and at least one source stays on. */
export function resolveSources(s?: Partial<Sources>): Sources {
  const mic = s?.mic ?? true;
  const tab = s?.tab ?? true;
  return mic || tab ? { mic, tab } : { ...DEFAULT_SOURCES };
}

/** Flip one source, refusing to untick the last one that is on. */
export function toggleSource(s: Sources, key: keyof Sources): Sources {
  const next = { ...s, [key]: !s[key] };
  return next.mic || next.tab ? next : s;
}

/** True when this checkbox must be disabled because it is the only source left on. */
export function isLastSource(s: Sources, key: keyof Sources): boolean {
  return s[key] && !(key === 'mic' ? s.tab : s.mic);
}
