import { describe, expect, it } from 'vitest';
import {
  buildIterationEvidenceView,
  buildLoopIssueView,
  catalogForSignal,
  PROGRESS_SIGNAL_CATALOG,
  progressVerdictHeaderWord,
  progressVerdictView,
  progressVerdictWord,
} from './loop-issue-diagnosis.util';

describe('progressVerdictWord', () => {
  it('maps detector verdicts to operator words', () => {
    expect(progressVerdictWord('CRITICAL')).toBe('STUCK');
    expect(progressVerdictWord('WARN')).toBe('WATCH');
    expect(progressVerdictWord('OK')).toBe('OK');
    expect(progressVerdictHeaderWord('CRITICAL')).toBe('stuck');
  });
});

describe('progressVerdictView', () => {
  it('labels an in-flight run verdict as belonging to the last completed iteration', () => {
    expect(progressVerdictView('CRITICAL', true, 'Repeating the same tool calls')).toEqual({
      label: 'LAST ITER · STUCK',
      title: 'Last iteration: Repeating the same tool calls',
      value: 'CRITICAL',
    });
    expect(progressVerdictView('OK', false)).toEqual({
      label: 'OK',
      title: 'Latest progress verdict',
      value: 'OK',
    });
  });
});

describe('catalogForSignal', () => {
  it('covers every built-in detector id and falls back for unknown ids', () => {
    for (const id of ['A', 'B', 'C', 'D', 'D-prime', 'E', 'F', 'G', 'H', 'I', 'BLOCKED']) {
      expect(catalogForSignal(id).title.length).toBeGreaterThan(4);
      expect(catalogForSignal(id).nextStep.length).toBeGreaterThan(8);
    }
    expect(catalogForSignal('Z-new').title).toContain('unhealthy');
  });
});

describe('buildLoopIssueView', () => {
  it('returns null for a healthy iteration', () => {
    expect(buildLoopIssueView({
      verdict: 'OK',
      signals: [],
      running: true,
      paused: false,
    })).toBeNull();
  });

  it('explains a running CRITICAL with G+I the way the HUD used to hide', () => {
    const view = buildLoopIssueView({
      verdict: 'CRITICAL',
      signals: [
        { id: 'G', verdict: 'CRITICAL', message: 'Tool Read called 8× in one iteration' },
        { id: 'I', verdict: 'CRITICAL', message: 'Read-only tool Read returned the same result hash 4x without intervening edits' },
      ],
      running: true,
      paused: false,
    });
    expect(view).not.toBeNull();
    expect(view!.headline).toBe('Repeating the same tool calls and re-reading the same content');
    expect(view!.problem).toContain('Tool Read called 8×');
    expect(view!.implication).toContain('still running');
    expect(view!.implication).toContain('pause on its own');
    expect(view!.fixability).toBe('fixable');
    expect(view!.fixabilityLabel).toBe('Usually fixable');
    expect(view!.nextStep).toContain('Hint');
    expect(view!.actions.some((action) => action.kind === 'hint' && action.primary)).toBe(true);
    expect(view!.signals).toHaveLength(2);
    expect(view!.signals[0].title).toBe('Repeating the same tool calls');
    expect(view!.signals[0].message).toContain('Tool Read');
  });

  it('describes the same signal in the headline, the problem and the next step', () => {
    // The detector emits in fixed id order (A→I) regardless of verdict, so a
    // WARN routinely precedes the CRITICAL that actually set the verdict.
    const view = buildLoopIssueView({
      verdict: 'CRITICAL',
      signals: [
        { id: 'A', verdict: 'WARN', message: 'Identical work hash repeated 2x' },
        { id: 'G', verdict: 'CRITICAL', message: 'Tool Read called 8x with identical args' },
      ],
      running: true,
      paused: false,
    });
    expect(view!.headline).toBe('Repeating the same tool calls');
    expect(view!.problem).toBe('Tool Read called 8x with identical args');
    expect(view!.nextStep).toBe(PROGRESS_SIGNAL_CATALOG['G'].nextStep);
    // Worst first in the evidence list too.
    expect(view!.signals.map((signal) => signal.id)).toEqual(['G', 'A']);
  });

  it('leads with the escalated CRITICAL the detector appends after the WARNs', () => {
    // WARN escalation pushes its CRITICAL 'A' onto the END of the array.
    const view = buildLoopIssueView({
      verdict: 'CRITICAL',
      signals: [
        { id: 'H', verdict: 'WARN', message: 'output 0.94 similar to previous' },
        { id: 'A', verdict: 'CRITICAL', message: '2 WARN iterations in last 3 — escalated to CRITICAL' },
      ],
      running: true,
      paused: false,
    });
    expect(view!.headline).toBe('Repeating the same work');
    expect(view!.problem).toContain('escalated to CRITICAL');
    expect(view!.nextStep).toBe(PROGRESS_SIGNAL_CATALOG['A'].nextStep);
  });

  it('leads with the out-of-band pause signal the iteration never recorded', () => {
    // A BLOCKED / resource-governor / preflight pause never lands in
    // progressSignals, so without the pause signal the view would headline the
    // stale WARN and lose the real reason.
    const view = buildLoopIssueView({
      verdict: 'WARN',
      signals: [{ id: 'G', verdict: 'WARN', message: 'Tool Read called 8x' }],
      pauseSignal: { id: 'BLOCKED', verdict: 'CRITICAL', message: 'BLOCKED.md present: needs a DB password' },
      running: false,
      paused: true,
      blocked: true,
    });
    expect(view!.severity).toBe('CRITICAL');
    expect(view!.headline).toBe('The loop is blocked and needs you');
    expect(view!.problem).toBe('BLOCKED.md present: needs a DB password');
    expect(view!.implication).toContain('cannot continue on its own');
    expect(view!.signals.map((signal) => signal.id)).toEqual(['BLOCKED', 'G']);
  });

  it('builds a view from the pause signal alone when no iteration has completed', () => {
    const view = buildLoopIssueView({
      verdict: 'OK',
      signals: [],
      pauseSignal: { id: 'BLOCKED', verdict: 'CRITICAL', message: 'preflight verification failed' },
      running: false,
      paused: true,
      blocked: true,
    });
    expect(view).not.toBeNull();
    expect(view!.headline).toBe('The loop is blocked and needs you');
    expect(view!.problem).toBe('preflight verification failed');
  });

  it('does not show the pause signal twice when the iteration already recorded it', () => {
    // An ordinary no-progress pause re-emits one of the iteration's own
    // signals. Without dedupe the headline reads "X and x".
    const view = buildLoopIssueView({
      verdict: 'CRITICAL',
      signals: [{ id: 'A', verdict: 'CRITICAL', message: 'Identical work hash repeated 3x' }],
      pauseSignal: { id: 'A', verdict: 'CRITICAL', message: 'Identical work hash repeated 3x' },
      running: false,
      paused: true,
    });
    expect(view!.signals).toHaveLength(1);
    expect(view!.headline).toBe('Repeating the same work');
  });

  it('counts the extra signals instead of dropping them when three or more tie', () => {
    const view = buildLoopIssueView({
      verdict: 'CRITICAL',
      signals: [
        { id: 'G', verdict: 'CRITICAL', message: 'same tool, same args' },
        { id: 'I', verdict: 'CRITICAL', message: 'same file re-read' },
        { id: 'A', verdict: 'CRITICAL', message: 'same work hash' },
        { id: 'E', verdict: 'CRITICAL', message: 'same error bucket' },
      ],
      running: true,
      paused: false,
    });
    expect(view!.headline).toBe(
      'Repeating the same tool calls, re-reading the same content and 2 more',
    );
    // The headline is truncated for readability; the evidence list is not.
    expect(view!.signals).toHaveLength(4);
  });

  it('does not lead with a hint when the loop is already auto-unsticking', () => {
    const view = buildLoopIssueView({
      verdict: 'CRITICAL',
      signals: [{ id: 'G', verdict: 'CRITICAL', message: 'Tool Edit called 43× in one iteration' }],
      running: true,
      paused: false,
      autoUnstickInFlight: true,
    });
    expect(view!.implication).toContain('trying a different approach on its own');
    expect(view!.nextStep).toContain('already changing approach');
    expect(view!.actions.find((action) => action.kind === 'hint')?.primary).toBe(false);
    expect(view!.actions.find((action) => action.kind === 'inspect')?.primary).toBe(true);
  });

  it('treats a running WARN as a watch, not a stop', () => {
    const view = buildLoopIssueView({
      verdict: 'WARN',
      signals: [{ id: 'A', verdict: 'WARN', message: 'Identical work hash repeated 2× consecutively' }],
      running: true,
      paused: false,
    });
    expect(view!.headline).toBe('Repeating the same work');
    expect(view!.implication).toContain('watch, not a stop');
    expect(view!.actions.some((action) => action.kind === 'stop')).toBe(false);
  });

  it('says a paused CRITICAL will not continue until the operator acts', () => {
    const view = buildLoopIssueView({
      verdict: 'CRITICAL',
      signals: [{ id: 'A', verdict: 'CRITICAL', message: 'Identical work hash repeated' }],
      running: false,
      paused: true,
    });
    expect(view!.implication).toContain('paused');
    expect(view!.implication).toContain('will not continue');
    expect(view!.actions.some((action) => action.kind === 'resume')).toBe(true);
  });

  it('marks BLOCKED as needing a decision, not a hint-first path', () => {
    const view = buildLoopIssueView({
      verdict: 'CRITICAL',
      signals: [{ id: 'BLOCKED', verdict: 'CRITICAL', message: 'BLOCKED.md asks for login' }],
      running: false,
      paused: true,
      blocked: true,
    });
    expect(view!.fixability).toBe('not-by-hint');
    expect(view!.implication).toContain('waiting on you');
    expect(view!.nextStep).toContain('Read the reason above');
    expect(view!.actions.find((action) => action.kind === 'inspect')?.primary).toBe(true);
  });
});

describe('buildIterationEvidenceView', () => {
  it('replaces id:verdict shorthand with titles, messages, and verify/completion English', () => {
    const view = buildIterationEvidenceView({
      progressSignals: [
        { id: 'G', verdict: 'CRITICAL', message: 'Same tool-call set repeated in last 3 iterations' },
      ],
      completionSignalsFired: [
        { id: 'ledger-complete', sufficient: true },
      ],
      verifyStatus: 'not-run',
      testPassCount: null,
      testFailCount: null,
      filesChanged: [{ path: 'ai-orchestrator/grok.md', additions: 0, deletions: 0 }],
    });
    expect(view.signals[0].title).toBe('Repeating the same tool calls');
    expect(view.signals[0].message).toContain('Same tool-call set');
    expect(view.signals[0].meaning).toContain('same arguments');
    expect(view.completionText).toContain('Task ledger');
    expect(view.completionText).toContain('enough to stop');
    expect(view.verifyText).toContain('has not run yet');
    expect(view.testsText).toBe('Tests: not reported');
    expect(view.filesText).toContain('grok.md');
    expect(view.signals[0].title).not.toContain('G:');
  });

  it('distinguishes a verify timeout from a failed command', () => {
    const view = buildIterationEvidenceView({
      progressSignals: [],
      completionSignalsFired: [],
      verifyStatus: 'failed',
      verifyFailureKind: 'timeout',
      testPassCount: 0,
      testFailCount: 0,
      filesChanged: [],
    });
    expect(view.verifyText).toContain('timed out');
    expect(view.verifyText).toContain('not a test failure');
  });
});
