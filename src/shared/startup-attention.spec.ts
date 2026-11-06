import { describe, expect, it } from 'vitest';
import type { StartupCapabilityCheck } from './types/startup-capability.types';
import {
  startupAttentionChecks,
  startupCheckFixAction,
  startupChipLabel,
  startupStatusHeadline,
} from './startup-attention';

function check(
  overrides: Partial<StartupCapabilityCheck> & Pick<StartupCapabilityCheck, 'id'>,
): StartupCapabilityCheck {
  return {
    label: overrides.id,
    category: 'subsystem',
    status: 'degraded',
    critical: false,
    summary: 'Something needs a look.',
    ...overrides,
  };
}

describe('startupAttentionChecks', () => {
  it('leaves out checks that are ready or deliberately switched off', () => {
    const report = {
      status: 'degraded' as const,
      generatedAt: 1,
      checks: [
        check({ id: 'native.sqlite', status: 'ready' }),
        check({ id: 'provider.cursor', status: 'disabled' }),
        check({ id: 'subsystem.browser-automation', status: 'degraded' }),
      ],
    };

    expect(startupAttentionChecks(report).map((item) => item.id)).toEqual([
      'subsystem.browser-automation',
    ]);
  });

  it('puts the worst problems first and keeps report order inside a tier', () => {
    const report = {
      status: 'failed' as const,
      generatedAt: 1,
      checks: [
        check({ id: 'provider.codex', status: 'degraded' }),
        check({ id: 'subsystem.remote-nodes', status: 'degraded', critical: true }),
        check({ id: 'provider.any', status: 'unavailable', critical: true }),
        check({ id: 'provider.copilot', status: 'degraded' }),
      ],
    };

    expect(startupAttentionChecks(report).map((item) => item.id)).toEqual([
      'provider.any',
      'subsystem.remote-nodes',
      'provider.codex',
      'provider.copilot',
    ]);
  });

  it('can be limited without losing the worst problem', () => {
    const report = {
      status: 'failed' as const,
      generatedAt: 1,
      checks: [
        check({ id: 'provider.codex', status: 'degraded' }),
        check({ id: 'native.sqlite', status: 'unavailable', critical: true }),
      ],
    };

    expect(startupAttentionChecks(report, 1).map((item) => item.id)).toEqual(['native.sqlite']);
  });
});

describe('startupCheckFixAction', () => {
  it('uses the fix the check itself names', () => {
    expect(startupCheckFixAction(check({
      id: 'provider.cursor',
      category: 'provider',
      details: { fix: 'setup' },
    }))).toEqual({ fix: 'setup', label: 'Setup' });
  });

  it('opens the right accounts page for a sign-in problem', () => {
    expect(startupCheckFixAction(check({
      id: 'provider.copilot',
      category: 'provider',
      details: { fix: 'accounts' },
    }))).toEqual({ fix: 'accounts', label: 'Accounts', provider: 'copilot' });
  });

  it('keeps the old single "Accounts" behaviour for a provider check that names no fix', () => {
    expect(startupCheckFixAction(check({ id: 'provider.codex', category: 'provider' }))).toEqual({
      fix: 'accounts',
      label: 'Accounts',
      provider: 'codex',
    });
  });

  it.each([
    ['subsystem.remote-nodes', 'remote-computers', 'Remote computers'],
    ['subsystem.browser-automation', 'browser', 'Browser'],
    ['subsystem.sandbox', 'setup', 'Setup'],
    ['native.sqlite', 'setup', 'Setup'],
    ['provider.any', 'setup', 'Setup'],
  ] as const)('sends %s to %s', (id, fix, label) => {
    expect(startupCheckFixAction(check({ id }))).toEqual({ fix, label });
  });

  it('ignores a fix name it does not know instead of sending the user nowhere', () => {
    expect(startupCheckFixAction(check({
      id: 'subsystem.remote-nodes',
      details: { fix: 'reboot-the-universe' },
    }))).toEqual({ fix: 'remote-computers', label: 'Remote computers' });
  });
});

describe('startup wording', () => {
  it('describes each overall status in plain words', () => {
    expect(startupStatusHeadline('degraded')).toBe('A few things need attention');
    expect(startupStatusHeadline('failed')).toBe('Setup needs your attention');
    expect(startupStatusHeadline('ready')).toBe('Everything is ready');
  });

  it('gives the title-bar chip a plain label, and none when everything is ready', () => {
    expect(startupChipLabel('degraded')).toBe('Startup needs attention');
    expect(startupChipLabel('failed')).toBe('Startup failed');
    expect(startupChipLabel('ready')).toBe('');
  });
});
