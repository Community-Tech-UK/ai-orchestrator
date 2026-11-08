import { describe, expect, it } from 'vitest';
import { PlanQueueParkReasonSchema } from '@contracts/schemas/plan-queue';
import { PARK_REASON_HELP, planQueueDisplayParkReason } from './plan-queue-park-reason-help';

describe('set-aside finding text', () => {
  it.each(PlanQueueParkReasonSchema.options)('explains the persisted reason %s and offers supported actions', reason => {
    const help = PARK_REASON_HELP[reason];
    const display = planQueueDisplayParkReason({ parkReason: reason });
    expect(help.label.trim().length).toBeGreaterThan(0);
    expect(help.meaning.trim().length).toBeGreaterThan(0);
    expect(help.next.trim().length).toBeGreaterThan(0);
    expect(help.actions.length).toBeGreaterThan(0);
    expect(new Set(help.actions).size).toBe(help.actions.length);
    expect(display).toMatchObject(help);
    for (const action of help.actions) {
      expect(['see-findings', 'choose-checker', 'resume', 'retry-landing', 'merge-without-checks', 'discard']).toContain(action);
    }
  });
  it('says plainly that a Codex round passed its token limit, that Resume would likely spend the same again, and where the limit is', () => {
    const help = PARK_REASON_HELP['stopped-by-harness'];
    expect(help.meaning).toContain('Codex round passed its token limit');
    expect(help.next).toContain('Resume would likely spend the same again');
    expect(help.next).toContain('Settings, Advanced');
    expect(help.next).toContain('Stop point for Harness work');
  });
  it.each(['needs-setup', 'needs-james'] as const)('shows what is missing under %s, and offers Resume', reason => {
    const display = planQueueDisplayParkReason({ parkReason: reason, detail: 'Missing setup on this computer:\n- Node 22 on the PATH' });
    expect(display?.extra).toContain('Node 22 on the PATH');
    expect(display?.actions).toContain('resume');
  });
  it('explains a refused restore without claiming that setting up a fresh copy will fix it', () => {
    const display = planQueueDisplayParkReason({ parkReason: 'worktree-error', detail: 'Paused. Could not restore the saved work.' });
    expect(display?.label).toBe('The saved work could not be restored');
    expect(display?.next).toBe('Review the work folder before choosing Resume.');
  });
  it('does not describe a current source inspection error as an old classification failure', () => {
    expect(planQueueDisplayParkReason({ parkReason: 'worker-error', detail: 'Could not inspect source document: permission denied' })?.label)
      .not.toContain('old classification');
  });
  it.each(['/Users/fixture-person/private-project/src/task.ts', 'C:\\Users\\fixture-person\\project\\task.ts'])(
    'removes absolute folders from the visible last finding: %s', file => {
      const summary = `Broken ${file}`;
      const item = { parkReason: 'round-limit' as const, round: 3,
        verdict: { verdict: 'FAIL' as const, documentComplete: false, gatesRun: [], needJames: [], notChecked: [],
          findings: [{ summary, severity: 'high' as const, confidence: 100 }] } };
      const display = planQueueDisplayParkReason(item, { maxRounds: 3 });
      expect(display?.extra).toBe('Last finding: Broken …/task.ts');
      expect(item.verdict.findings[0].summary).toBe(summary);
    },
  );

  it('leaves only the deliberate choices once a newer attempt has merged', () => {
    const display = planQueueDisplayParkReason({ parkReason: 'land-blocked' }, { mergedSince: true });
    expect(display?.label).toBe('A newer attempt already merged');
    expect(display?.actions).toEqual(['merge-without-checks', 'discard']);
  });
});
