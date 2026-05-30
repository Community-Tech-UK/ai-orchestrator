/**
 * LF-4 (loopfixex.md) — LOOP_TASKS.md ledger parser/serializer.
 */

import { describe, expect, it } from 'vitest';
import { deriveLedgerFromChecklist, parseTaskLedger, serializeTaskLedger } from './loop-task-ledger';

describe('parseTaskLedger', () => {
  it('classifies markers and computes resolution', () => {
    const ledger = parseTaskLedger([
      '# Loop Tasks',
      '',
      '- [x] Implement the parser',
      '- [~] Wire the coordinator',
      '- [ ] Surface the toggle',
      '- [-] Cross-model fan-out — deferred: out of scope for v1',
      'some prose that is not a task',
    ].join('\n'));

    expect(ledger.total).toBe(4);
    expect(ledger.resolved).toBe(2); // done + deferred
    expect(ledger.complete).toBe(false);
    expect(ledger.nextTodo).toBe('Wire the coordinator'); // first doing/todo
    expect(ledger.items[0]).toEqual({ text: 'Implement the parser', state: 'done', reason: '' });
    expect(ledger.items[3]).toEqual({ text: 'Cross-model fan-out', state: 'deferred', reason: 'out of scope for v1' });
  });

  it('is complete only when every item is done or deferred', () => {
    expect(parseTaskLedger('- [x] a\n- [-] b — deferred: nope').complete).toBe(true);
    expect(parseTaskLedger('- [x] a\n- [ ] b').complete).toBe(false);
    expect(parseTaskLedger('- [x] a\n- [~] b').complete).toBe(false);
  });

  it('treats an empty / item-less ledger as not complete (never auto-stops)', () => {
    expect(parseTaskLedger('').complete).toBe(false);
    expect(parseTaskLedger('# Loop Tasks\n\njust a heading').total).toBe(0);
    expect(parseTaskLedger('# Loop Tasks').complete).toBe(false);
  });

  it('parses the `deferred:` and `(deferred: …)` reason forms', () => {
    expect(parseTaskLedger('- [-] X deferred: needs creds').items[0].reason).toBe('needs creds');
    expect(parseTaskLedger('- [-] Y (deferred: later)').items[0].reason).toBe('later');
    expect(parseTaskLedger('- [>] Z — handled elsewhere').items[0]).toEqual({ text: 'Z', state: 'deferred', reason: 'handled elsewhere' });
  });
});

describe('serializeTaskLedger', () => {
  it('round-trips item states', () => {
    const items = [
      { text: 'done one', state: 'done' as const, reason: '' },
      { text: 'todo one', state: 'todo' as const, reason: '' },
      { text: 'deferred one', state: 'deferred' as const, reason: 'why' },
    ];
    const text = serializeTaskLedger({ items });
    const reparsed = parseTaskLedger(text);
    expect(reparsed.total).toBe(3);
    expect(reparsed.items.map((i) => i.state)).toEqual(['done', 'todo', 'deferred']);
    expect(reparsed.items[2].reason).toBe('why');
  });
});

describe('deriveLedgerFromChecklist', () => {
  it('derives ledger items from a plan-file checklist (back-compat)', () => {
    const ledger = deriveLedgerFromChecklist('# Plan\n\n- [x] step 1\n- [ ] step 2\n');
    expect(ledger.total).toBe(2);
    expect(ledger.complete).toBe(false);
    expect(ledger.nextTodo).toBe('step 2');
  });
});
