import { describe, expect, it } from 'vitest';
import { buildHonestyChips, buildLoopAuditChips } from './loop-audit-chips.util';

describe('buildLoopAuditChips', () => {
  it('returns null when audit is off and no results exist', () => {
    expect(buildLoopAuditChips({})).toBeNull();
  });

  it('keeps a command-failure chip red even in record mode', () => {
    const view = buildLoopAuditChips({
      audit: { preflightMode: 'record', finalAuditMode: 'off' },
      preflight: {
        status: 'failed',
        ranAt: 1,
        commands: [{
          label: 'verify',
          command: 'npm test',
          status: 'failed',
          durationMs: 4_000,
          outputExcerpt: '3 tests failed',
          failureKind: 'command',
        }],
      },
    });

    expect(view).toMatchObject({
      preflightState: 'failed',
      preflightLabel: 'Preflight failed',
    });
  });

  it('does not paint a record-mode timeout as a blocking failure', () => {
    const view = buildLoopAuditChips({
      audit: { preflightMode: 'record', finalAuditMode: 'gate' },
      preflight: {
        status: 'failed',
        ranAt: 1,
        commands: [{
          label: 'verify',
          command: 'npm run verify',
          status: 'failed',
          durationMs: 179_999,
          outputExcerpt: '(verify timed out after 180000ms)',
          failureKind: 'timeout',
        }],
      },
    });

    expect(view).toMatchObject({
      preflightState: 'skipped',
      preflightLabel: 'Preflight baseline unknown',
      finalAuditLabel: 'Final audit pending',
    });
    expect(view?.preflightTitle).toContain('does not block');
    expect(view?.finalAuditTitle).toContain('has not run yet');
  });

  it('keeps a gating timeout red', () => {
    const view = buildLoopAuditChips({
      audit: { preflightMode: 'block', finalAuditMode: 'off' },
      preflight: {
        status: 'failed',
        ranAt: 1,
        commands: [{
          label: 'verify',
          command: 'npm run verify',
          status: 'failed',
          durationMs: 600_000,
          outputExcerpt: '(verify timed out after 600000ms)',
          failureKind: 'timeout',
        }],
      },
    });

    expect(view).toMatchObject({
      preflightState: 'failed',
      preflightLabel: 'Preflight timed out',
    });
  });

  it('labels a skipped record-mode preflight as skipped, not failed', () => {
    const view = buildLoopAuditChips({
      audit: { preflightMode: 'record', finalAuditMode: 'gate' },
      preflight: {
        status: 'skipped',
        ranAt: 1,
        commands: [{
          label: 'verify',
          command: 'npm run verify',
          status: 'skipped',
          durationMs: 0,
          outputExcerpt: '(not run: no quick-verify configured, and a `record` preflight gates nothing)',
        }],
      },
    });

    expect(view).toMatchObject({
      preflightState: 'skipped',
      preflightLabel: 'Preflight skipped',
    });
  });

  it('keeps needs-review audit wording and strips the report path to a basename', () => {
    const view = buildLoopAuditChips({
      audit: { preflightMode: 'record', finalAuditMode: 'gate' },
      preflight: { status: 'failed', ranAt: 1, commands: [] },
      latestFinalAudit: {
        status: 'needs-review',
        reportPath: '/tmp/project/.aio-loop-state/loop-1/AUDIT.md',
      },
    });

    expect(view).toMatchObject({
      preflightLabel: 'Preflight failed',
      finalAuditLabel: 'Audit gate needs review',
      reportFile: 'AUDIT.md',
    });
  });
});

describe('buildHonestyChips', () => {
  it('returns an empty list when neither auto-unstick nor wrap-up is active', () => {
    expect(buildHonestyChips({})).toEqual([]);
  });

  it('labels auto-unstick and cap wrap-up without calling either a ping-pong', () => {
    expect(buildHonestyChips({
      autoUnstick: { attempt: 1, max: 2, signalId: 'C' },
      capWrapUpIntent: { cap: 'iterations' },
    })).toEqual([
      'unstick 1/2 · C',
      'wrap-up · iterations cap',
    ]);
  });
});

/**
 * L6 — the diagnosis has to reach the operator. A banner and HUD that still say
 * "no progress" while the backend knows it is "the reviewer keeps raising the
 * same finding" is the entire bug L6 exists to fix.
 */
describe('buildHonestyChips — L6 diagnosis and parked leaves', () => {
  it('names the diagnosis rather than leaving it backend-only', () => {
    expect(buildHonestyChips({ nonConvergence: { reason: 'code_review_non_converging' } }))
      .toEqual(['review not converging']);
    expect(buildHonestyChips({ nonConvergence: { reason: 'landable_uncommitted' } }))
      .toEqual(['landable · uncommitted']);
    expect(buildHonestyChips({ nonConvergence: { reason: 'scope_expanded' } }))
      .toEqual(['scope widened']);
  });

  it('falls back to the raw reason for an unrecognised value', () => {
    expect(buildHonestyChips({ nonConvergence: { reason: 'something_new' } }))
      .toEqual(['something_new']);
  });

  it('shows that work was set aside, and how much', () => {
    expect(buildHonestyChips({ parkedLeaves: [{ id: 'a' }] })).toEqual(['1 item parked']);
    expect(buildHonestyChips({ parkedLeaves: [{ id: 'a' }, { id: 'b' }] })).toEqual(['2 items parked']);
  });

  it('shows nothing when nothing is parked and nothing was diagnosed', () => {
    expect(buildHonestyChips({ parkedLeaves: [], nonConvergence: null })).toEqual([]);
  });

  it('keeps the existing chips alongside the new ones', () => {
    expect(buildHonestyChips({
      autoUnstick: { attempt: 2, max: 2, signalId: 'G' },
      capWrapUpIntent: { cap: 'iterations' },
      nonConvergence: { reason: 'scope_expanded' },
      parkedLeaves: [{ id: 'a' }],
    })).toEqual(['unstick 2/2 · G', 'wrap-up · iterations cap', 'scope widened', '1 item parked']);
  });
});
