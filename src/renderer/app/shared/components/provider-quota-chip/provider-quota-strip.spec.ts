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
  const texts = (entry: ReturnType<typeof quotaStripEntry>) => entry?.parts.map((part) => part.text);

  it('uses the two-letter provider code, OC for the MiMo plan', () => {
    expect(quotaStripEntry('claude', [section('claude', { windows: [win('claude.weekly', 4)] })])?.code).toBe('CC');
    const mimo = quotaStripEntry('opencode', [section('opencode', { windows: [win('opencode.plan', 43)] })]);
    expect(mimo?.code).toBe('OC');
    expect(texts(mimo)).toEqual(['43%']);
  });

  it('shows every account in the order given, each coloured by its own figure, the code by the worst', () => {
    const entry = quotaStripEntry('claude', [
      section('claude', { windows: [win('claude.weekly', 4)] }),
      section('claude', { windows: [win('claude.weekly', 100)] }, 'Max C'),
      section('claude', { windows: [win('claude.weekly', 11)] }, 'Max B'),
    ]);
    expect(texts(entry)).toEqual(['4%', '100%', '11%']);
    expect(entry?.parts[0].fg).not.toBe(BAND_COLORS.red.fg);
    expect(entry?.parts[1].fg).toBe(BAND_COLORS.red.fg);
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

  it('marks only the signed-out account with a warning, keeping its last-known figure', () => {
    const entry = quotaStripEntry('cursor', [
      section('cursor', { windows: [win('cursor.included', 20)] }),
      section('cursor', { needsReauth: true, windows: [win('cursor.included', 65)] }, 'Work'),
    ]);
    expect(texts(entry)).toEqual(['20%', '65% ⚠']);
    expect(entry?.parts[1].fg).toBe(BAND_COLORS.red.fg);
    expect(entry?.fg).toBe(BAND_COLORS.red.fg);
  });

  it('says Signed out for an account with no figure to show, beside the others', () => {
    expect(texts(quotaStripEntry('cursor', [section('cursor', { ok: false, needsReauth: true })]))).toEqual(['Signed out']);
    const entry = quotaStripEntry('claude', [
      section('claude', { windows: [win('claude.weekly', 30)] }),
      section('claude', { ok: false, needsReauth: true }, 'Max C'),
    ]);
    expect(texts(entry)).toEqual(['30%', 'Signed out']);
    expect(entry?.fg).toBe(BAND_COLORS.red.fg);
  });

  it('leaves out an account that is neither measured nor signed out', () => {
    const entry = quotaStripEntry('claude', [
      section('claude', { windows: [win('claude.weekly', 30)] }),
      section('claude', { ok: false, error: 'Usage endpoint unavailable' }, 'Max C'),
    ]);
    expect(texts(entry)).toEqual(['30%']);
  });

  it('falls back to the plan name, then "ok", when there are no windows', () => {
    expect(texts(quotaStripEntry('copilot', [section('copilot', { plan: 'pro' })]))).toEqual(['pro']);
    expect(texts(quotaStripEntry('copilot', [section('copilot')]))).toEqual(['ok']);
  });

  it('has nothing to show for an unavailable provider or no accounts', () => {
    expect(quotaStripEntry('grok', [])).toBeNull();
    expect(quotaStripEntry('grok', [section('grok', { ok: false, error: 'Unavailable' })])).toBeNull();
  });
});
