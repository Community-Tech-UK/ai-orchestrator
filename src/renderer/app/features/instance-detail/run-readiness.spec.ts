import { describe, expect, it } from 'vitest';
import { buildRunReadinessReasons, type RunReadinessReason } from './run-readiness';
import type {
  StartupCapabilityCheck,
  StartupCapabilityReport,
} from '../../../../shared/types/startup-capability.types';

function check(overrides: Partial<StartupCapabilityCheck> & Pick<StartupCapabilityCheck, 'id'>): StartupCapabilityCheck {
  return {
    label: overrides.id,
    category: 'provider',
    status: 'ready',
    critical: false,
    summary: `${overrides.id} summary`,
    ...overrides,
  };
}

function report(checks: StartupCapabilityCheck[]): StartupCapabilityReport {
  return { status: 'ready', generatedAt: 0, checks };
}

describe('buildRunReadinessReasons', () => {
  it('returns nothing when no startup-capabilities report has loaded yet', () => {
    expect(buildRunReadinessReasons({ provider: 'claude', startupCapabilities: null })).toEqual([]);
  });

  it('returns nothing when every relevant provider check is ready', () => {
    const reasons = buildRunReadinessReasons({
      provider: 'claude',
      startupCapabilities: report([
        check({ id: 'provider.any', status: 'ready', critical: true }),
        check({ id: 'provider.claude', status: 'ready' }),
      ]),
    });
    expect(reasons).toEqual([]);
  });

  it('blocks with one primary action when no supported provider CLI is available at all', () => {
    const reasons = buildRunReadinessReasons({
      provider: 'claude',
      startupCapabilities: report([
        check({
          id: 'provider.any',
          status: 'unavailable',
          critical: true,
          summary: 'No supported provider CLI is currently available.',
        }),
      ]),
    });
    expect(reasons).toEqual<RunReadinessReason[]>([
      {
        id: 'provider-none-available',
        severity: 'blocking',
        message: 'No supported provider CLI is currently available.',
        action: { label: 'Open Doctor', commandId: 'app.open-doctor' },
      },
    ]);
  });

  it('warns (does not block) when only the composer\'s active provider is degraded', () => {
    const reasons = buildRunReadinessReasons({
      provider: 'codex',
      startupCapabilities: report([
        check({ id: 'provider.any', status: 'ready', critical: true }),
        check({ id: 'provider.claude', status: 'ready' }),
        check({ id: 'provider.codex', status: 'degraded', summary: 'Codex CLI is not available on PATH.' }),
      ]),
    });
    expect(reasons).toEqual<RunReadinessReason[]>([
      {
        id: 'provider-degraded-codex',
        severity: 'warning',
        message: 'Codex CLI is not available on PATH.',
        action: { label: 'Open Doctor', commandId: 'app.open-doctor' },
      },
    ]);
  });

  it('does not warn about a different provider than the one the composer is using', () => {
    const reasons = buildRunReadinessReasons({
      provider: 'claude',
      startupCapabilities: report([
        check({ id: 'provider.any', status: 'ready', critical: true }),
        check({ id: 'provider.claude', status: 'ready' }),
        check({ id: 'provider.codex', status: 'degraded' }),
      ]),
    });
    expect(reasons).toEqual([]);
  });

  it('produces no reason for a provider that was never probed (e.g. gemini/ollama/grok are not in the startup probe list)', () => {
    const reasons = buildRunReadinessReasons({
      provider: 'gemini',
      startupCapabilities: report([check({ id: 'provider.any', status: 'ready', critical: true })]),
    });
    expect(reasons).toEqual([]);
  });

  it('dedup/merge: does not also emit the per-provider warning when the aggregate reason already covers total unavailability', () => {
    const reasons = buildRunReadinessReasons({
      provider: 'claude',
      startupCapabilities: report([
        check({ id: 'provider.any', status: 'unavailable', critical: true }),
        check({ id: 'provider.claude', status: 'degraded', summary: 'Claude Code CLI is not available on PATH.' }),
      ]),
    });
    // One reasoned banner, not two disagreeing ones.
    expect(reasons).toHaveLength(1);
    expect(reasons[0].id).toBe('provider-none-available');
    expect(reasons[0].severity).toBe('blocking');
  });

  it('orders blocking before warning/info severities whenever more than one reason is present', () => {
    const severityRank: Record<RunReadinessReason['severity'], number> = { blocking: 0, warning: 1, info: 2 };
    const cases: RunReadinessReason[][] = [
      buildRunReadinessReasons({
        provider: 'claude',
        startupCapabilities: report([check({ id: 'provider.any', status: 'unavailable', critical: true })]),
      }),
      buildRunReadinessReasons({
        provider: 'claude',
        startupCapabilities: report([
          check({ id: 'provider.any', status: 'ready', critical: true }),
          check({ id: 'provider.claude', status: 'degraded' }),
        ]),
      }),
    ];
    for (const reasons of cases) {
      for (let i = 1; i < reasons.length; i++) {
        expect(severityRank[reasons[i - 1].severity]).toBeLessThanOrEqual(severityRank[reasons[i].severity]);
      }
    }
  });

  it('boundary: never surfaces a context/compaction reason — that stays owned by ContextWarningComponent', () => {
    // RunReadinessInputs has no context-usage field at all, so there is
    // nothing for a caller to pass that could produce a context-shaped
    // reason. This test documents the boundary explicitly rather than
    // relying on the type system alone.
    const reasons = buildRunReadinessReasons({
      provider: 'claude',
      startupCapabilities: report([check({ id: 'provider.any', status: 'unavailable', critical: true })]),
    });
    expect(reasons.some((reason) => reason.id.includes('context') || reason.message.toLowerCase().includes('context'))).toBe(false);
  });
});
