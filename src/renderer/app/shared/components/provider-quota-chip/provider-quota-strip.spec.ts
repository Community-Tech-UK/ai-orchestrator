import { describe, expect, it } from 'vitest';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../../shared/types/provider-quota.types';
import { quotaSummaryWindow, type QuotaAccountSection } from '../../../../../shared/utils/provider-quota-account-sections';
import { BAND_COLORS, quotaStripEntry, windowPercent } from './provider-quota-strip';

function win(id: string, used: number, limit = 100): ProviderQuotaWindow {
  return { kind: 'rolling-window', id, label: id, unit: 'messages', used, limit, remaining: limit - used, resetsAt: null };
}

function section(
  provider: ProviderId,
  overrides: Partial<ProviderQuotaSnapshot> = {},
  label: string | null = null,
): QuotaAccountSection {
  return {
    id: label ?? 'legacy',
    label,
    snapshot: { provider, takenAt: 1, source: 'cli-result', ok: true, windows: [], ...overrides },
  };
}

describe('windowPercent', () => {
  it('clamps to 0-100 and treats a zero limit as 0', () => {
    expect(windowPercent(win('a', 50))).toBe(50);
    expect(windowPercent(win('a', 500))).toBe(100);
    expect(windowPercent(win('a', -5))).toBe(0);
    expect(windowPercent(win('a', 5, 0))).toBe(0);
  });
});

describe('quotaSummaryWindow', () => {
  it('reads the weekly window for Claude even when another is higher', () => {
    const snapshot = section('claude', { windows: [win('claude.5h', 90), win('claude.weekly', 12)] }).snapshot;
    expect(quotaSummaryWindow(snapshot)?.id).toBe('claude.weekly');
  });

  it('falls back to the most used window for a provider with no preferred one', () => {
    const snapshot = section('gemini', { windows: [win('gemini.a', 10), win('gemini.b', 70)] }).snapshot;
    expect(quotaSummaryWindow(snapshot)?.id).toBe('gemini.b');
  });
});

describe('quotaStripEntry', () => {
  it('names each provider by its short name, MiMo for the OpenCode plan', () => {
    const name = (provider: 'claude' | 'codex' | 'copilot' | 'cursor') =>
      quotaStripEntry(provider, [section(provider, { windows: [win(`${provider}.weekly`, 4)] })])?.name;
    expect([name('claude'), name('codex'), name('copilot'), name('cursor')]).toEqual(['Claude', 'Codex', 'Copilot', 'Cursor']);
    const mimo = quotaStripEntry('opencode', [section('opencode', { windows: [win('opencode.plan', 43)] })]);
    expect(mimo?.name).toBe('MiMo');
    expect(mimo?.text).toBe('43%');
  });

  it('never uses a two-letter code (CU once meant Cursor here and Computer Use elsewhere)', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode'] as const) {
      const entry = quotaStripEntry(provider, [section(provider, { windows: [win(`${provider}.x`, 10)] })]);
      expect(entry?.name).toMatch(/^[A-Z][A-Za-z]{3,}$/);
    }
  });

  it('shows one figure, the worst account\'s, coloured by its band', () => {
    const entry = quotaStripEntry('claude', [
      section('claude', { windows: [win('claude.weekly', 4)] }),
      section('claude', { windows: [win('claude.weekly', 100)] }, 'Max C'),
      section('claude', { windows: [win('claude.weekly', 11)] }, 'Max B'),
    ]);
    expect(entry?.text).toBe('100%');
    expect(entry?.fg).toBe(BAND_COLORS.red.fg);
  });

  it('colours by band: neutral under 75, orange from 75, red from 90', () => {
    const colorAt = (used: number) =>
      quotaStripEntry('codex', [section('codex', { windows: [win('codex.weekly', used)] })])?.fg;
    expect(colorAt(10)).not.toBe(BAND_COLORS.orange.fg);
    expect(colorAt(74)).not.toBe(BAND_COLORS.orange.fg);
    expect(colorAt(75)).toBe(BAND_COLORS.orange.fg);
    expect(colorAt(89)).toBe(BAND_COLORS.orange.fg);
    expect(colorAt(90)).toBe(BAND_COLORS.red.fg);
  });

  it('treats a signed-out account as the worst, keeping its last-known figure and a warning', () => {
    const entry = quotaStripEntry('cursor', [
      section('cursor', { windows: [win('cursor.included', 20)] }),
      section('cursor', { needsReauth: true, windows: [win('cursor.included', 65)] }, 'Work'),
    ]);
    expect(entry?.text).toBe('65% ⚠');
    expect(entry?.fg).toBe(BAND_COLORS.red.fg);
  });

  it('says Signed out when the signed-out account has no figure to show', () => {
    expect(quotaStripEntry('cursor', [section('cursor', { ok: false, needsReauth: true })])?.text).toBe('Signed out');
    const entry = quotaStripEntry('claude', [
      section('claude', { windows: [win('claude.weekly', 30)] }),
      section('claude', { ok: false, needsReauth: true }, 'Max C'),
    ]);
    expect(entry?.text).toBe('Signed out');
    expect(entry?.fg).toBe(BAND_COLORS.red.fg);
  });

  it('skips accounts with no figure, so the figure comes from the others', () => {
    const entry = quotaStripEntry('claude', [
      section('claude', { ok: false, error: 'Usage endpoint unavailable' }),
      section('claude', { windows: [win('claude.weekly', 95)] }, 'Max C'),
      section('claude', { plan: 'max' }, 'Max B'),
    ]);
    expect(entry?.text).toBe('95%');
    expect(entry?.fg).toBe(BAND_COLORS.red.fg);
  });

  it('a provider with no figures falls back to its plan, or nothing', () => {
    expect(quotaStripEntry('claude', [
      section('claude', { ok: false, error: 'Usage endpoint unavailable' }),
      section('claude', { plan: 'max' }, 'Max C'),
    ])?.text).toBe('max');
    expect(quotaStripEntry('claude', [section('claude', { ok: false, error: 'Usage endpoint unavailable' })])).toBeNull();
  });

  it('falls back to the plan name, then "ok", when there are no windows', () => {
    expect(quotaStripEntry('copilot', [section('copilot', { plan: 'pro' })])?.text).toBe('pro');
    expect(quotaStripEntry('copilot', [section('copilot')])?.text).toBe('ok');
  });

  it('has nothing to show for an unavailable provider or no accounts', () => {
    expect(quotaStripEntry('grok', [])).toBeNull();
    expect(quotaStripEntry('grok', [section('grok', { ok: false, error: 'Unavailable' })])).toBeNull();
  });
});
