import { describe, expect, it } from 'vitest';
import { detectKey, jobsFor, serviceLabel } from './keyDetect';

describe('detectKey', () => {
  it('recognises each prefix', () => {
    expect(detectKey('gsk_test')).toBe('GROQ_API_KEY');
    expect(detectKey('sk-ant-test')).toBe('ANTHROPIC_API_KEY');
    expect(detectKey('sk-or-v1-test')).toBe('OPENROUTER_API_KEY');
    expect(detectKey('sk-test')).toBe('OPENAI_API_KEY');
    expect(detectKey('sk-proj-test')).toBe('OPENAI_API_KEY');
    expect(detectKey('ntn_test')).toBe('NOTION_TOKEN');
    expect(detectKey('secret_test')).toBe('NOTION_TOKEN');
    expect(detectKey('0123456789abcdef0123456789abcdef01234567')).toBe('DEEPGRAM_API_KEY');
  });

  it('returns null for unknown values', () => {
    expect(detectKey('dg_test')).toBeNull();
    expect(detectKey('hello')).toBeNull();
    expect(detectKey('')).toBeNull();
    expect(detectKey('0123456789abcdef')).toBeNull();
    expect(detectKey('0123456789abcdef0123456789abcdef012345678')).toBeNull(); // 41 chars
  });

  it('ignores surrounding whitespace', () => {
    expect(detectKey('  gsk_test\n')).toBe('GROQ_API_KEY');
    expect(detectKey('\tntn_test ')).toBe('NOTION_TOKEN');
    expect(detectKey('   ')).toBeNull();
  });
});

describe('jobsFor', () => {
  it('lists what each key does', () => {
    expect(jobsFor('GROQ_API_KEY')).toEqual(['transcription', 'assistant']);
    expect(jobsFor('OPENAI_API_KEY')).toEqual(['transcription', 'assistant']);
    expect(jobsFor('DEEPGRAM_API_KEY')).toEqual(['transcription']);
    expect(jobsFor('ANTHROPIC_API_KEY')).toEqual(['assistant']);
    expect(jobsFor('OPENROUTER_API_KEY')).toEqual(['assistant']);
    expect(jobsFor('NOTION_TOKEN')).toEqual([]);
  });
});

describe('serviceLabel', () => {
  it('names each service', () => {
    expect(serviceLabel('GROQ_API_KEY')).toBe('Groq');
    expect(serviceLabel('OPENAI_API_KEY')).toBe('OpenAI');
    expect(serviceLabel('DEEPGRAM_API_KEY')).toBe('Deepgram');
    expect(serviceLabel('ANTHROPIC_API_KEY')).toBe('Anthropic');
    expect(serviceLabel('OPENROUTER_API_KEY')).toBe('OpenRouter');
    expect(serviceLabel('NOTION_TOKEN')).toBe('Notion');
  });
});
