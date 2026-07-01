import { describe, it, expect } from 'vitest';
import { parseTaskLedger } from './loop-task-ledger';
import { lintTaskLedger, lintLedgerItem } from './loop-ledger-lint';
import type { LoopTaskItem } from './loop-task-ledger';

function item(text: string, state: LoopTaskItem['state'] = 'todo'): LoopTaskItem {
  return { text, state, reason: '' };
}

describe('lintLedgerItem', () => {
  it('flags open-ended "continue remaining slices" buckets', () => {
    const f = lintLedgerItem(item('Continue remaining Loop Engine slices: A0-A3, B2-B6/B8, C1-C4'));
    expect(f?.category).toBe('open-ended');
  });

  it('flags "and gated G work" open-ended phrasing', () => {
    const f = lintLedgerItem(item('Do E1/E2, F2, and gated G work per the overhaul spec'));
    expect(f?.category).toBe('open-ended');
  });

  it('flags hardware / manual-gated items', () => {
    expect(
      lintLedgerItem(item('STT Phase 6: hardware smoke evidence until a real worker/microphone test is available'))
        ?.category,
    ).toBe('external-gated');
    expect(lintLedgerItem(item('Run a manual smoke test on the device'))?.category).toBe('external-gated');
    expect(lintLedgerItem(item('Requires a human to approve the release'))?.category).toBe('external-gated');
  });

  it('does NOT flag a concrete, closable item', () => {
    expect(lintLedgerItem(item('Add LoopContextSurvivalManager scaffold and coordinator wiring'))).toBeNull();
    expect(lintLedgerItem(item('Implement PI Task 20A: UUIDv7 utility and focused tests'))).toBeNull();
  });

  it('ignores resolved items (done / deferred) even if the text matches', () => {
    expect(lintLedgerItem(item('Continue remaining slices', 'done'))).toBeNull();
    expect(lintLedgerItem(item('Until real hardware is available', 'deferred'))).toBeNull();
  });

  it('flags an in-progress ([~]) open-ended item', () => {
    expect(lintLedgerItem(item('Continue remaining work', 'doing'))?.category).toBe('open-ended');
  });
});

describe('lintTaskLedger', () => {
  it('returns the two unclosable items from the observed non-convergent ledger', () => {
    const md = [
      '# Loop Tasks',
      '- [x] Confirm plan A is completed',
      '- [ ] Implement and verify the overhaul spec.',
      '  - [x] Phase 0 slice: add scaffold',
      '  - [ ] Continue remaining Loop Engine slices: A0-A3, B2-B6/B8, C1-C4, D4-D6, E1/E2, F2, and gated G work',
      '- [ ] STT Phase 6: add setup docs, with hardware smoke evidence tracked until a real worker/microphone test is available',
      '- [x] PI Task 20A: UUIDv7 utility',
    ].join('\n');
    const findings = lintTaskLedger(parseTaskLedger(md));
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.category).sort()).toEqual(['external-gated', 'open-ended']);
  });

  it('returns an empty array for a fully closable ledger', () => {
    const md = [
      '# Loop Tasks',
      '- [ ] Implement PI Task 20A: UUIDv7 utility and tests',
      '- [ ] Wire normalizeUsage into the event bridge',
      '- [x] Add auto-disable migration',
    ].join('\n');
    expect(lintTaskLedger(parseTaskLedger(md))).toEqual([]);
  });

  it('returns an empty array for an absent/empty ledger', () => {
    expect(lintTaskLedger(parseTaskLedger(''))).toEqual([]);
  });
});
