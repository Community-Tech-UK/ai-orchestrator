/**
 * LF-4 (loopfixex.md) — LOOP_TASKS.md ledger parser/serializer.
 * WS2 (loop-convergence plan) — stable leaf identities: nesting, leaf-only
 * totals, explicit `loop-task-id` comments, legacy fingerprints, duplicate /
 * malformed id surfacing, and id-preserving serialization.
 */

import { describe, expect, it } from 'vitest';
import { deriveLedgerFromChecklist, parseTaskLedger, serializeTaskLedger } from './loop-task-ledger';
import { LOOP_TASKS_TEMPLATE } from './loop-stage-files';

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
    expect(ledger.items[0]).toMatchObject({ text: 'Implement the parser', state: 'done', reason: '' });
    expect(ledger.items[3]).toMatchObject({ text: 'Cross-model fan-out', state: 'deferred', reason: 'out of scope for v1' });
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
    expect(parseTaskLedger('- [>] Z — handled elsewhere').items[0]).toMatchObject({ text: 'Z', state: 'deferred', reason: 'handled elsewhere' });
  });

  it('still ignores commented-out template examples', () => {
    const ledger = parseTaskLedger('# Loop Tasks\n\n<!-- Example:\n- [ ] example item\n-->\n- [ ] real item\n');
    expect(ledger.total).toBe(1);
    expect(ledger.items[0].text).toBe('real item');
  });

  it('ignores commented-out examples even when they carry id comments (bootstrap template)', () => {
    // The id-comment pass runs before comment stripping, so the inner
    // `<!-- loop-task-id:… -->` terminators cannot split the outer block.
    const ledger = parseTaskLedger(LOOP_TASKS_TEMPLATE);
    expect(ledger.total).toBe(0);
    expect(ledger.malformedIds).toEqual([]);
    expect(parseTaskLedger(`${LOOP_TASKS_TEMPLATE}\n- [ ] real <!-- loop-task-id:real.1 -->\n`).items)
      .toHaveLength(1);
  });
});

describe('parseTaskLedger — nesting and leaves (WS2)', () => {
  const NESTED = [
    '- [ ] Implement persistence guard <!-- loop-task-id:ws4.persistence-guard -->',
    '  - [x] Add schema migration <!-- loop-task-id:ws4.schema -->',
    '  - [~] Wire runtime call site <!-- loop-task-id:ws4.runtime -->',
    '- [x] Standalone top-level task <!-- loop-task-id:solo -->',
  ].join('\n');

  it('parses depth, parentId, and leaf from indentation', () => {
    const ledger = parseTaskLedger(NESTED);
    expect(ledger.items.map((i) => [i.id, i.depth, i.parentId, i.leaf])).toEqual([
      ['ws4.persistence-guard', 0, null, false],
      ['ws4.schema', 1, 'ws4.persistence-guard', true],
      ['ws4.runtime', 1, 'ws4.persistence-guard', true],
      ['solo', 0, null, true],
    ]);
  });

  it('derives totals, resolved, complete, and nextTodo from LEAVES only', () => {
    const ledger = parseTaskLedger(NESTED);
    // Parent (open) is structural — it does not count or block.
    expect(ledger.total).toBe(3);
    expect(ledger.resolved).toBe(2); // ws4.schema (done) + solo (done)
    expect(ledger.complete).toBe(false);
    expect(ledger.nextTodo).toBe('Wire runtime call site');
  });

  it('an open parent with fully resolved children does not block completion', () => {
    const ledger = parseTaskLedger([
      '- [ ] Structural parent <!-- loop-task-id:p -->',
      '  - [x] child one <!-- loop-task-id:c1 -->',
      '  - [-] child two — deferred: not needed <!-- loop-task-id:c2 -->',
    ].join('\n'));
    expect(ledger.total).toBe(2);
    expect(ledger.complete).toBe(true);
  });

  it('supports deeper nesting with fingerprinted intermediate rows', () => {
    const ledger = parseTaskLedger([
      '- [ ] grand parent',
      '  - [ ] parent',
      '    - [x] leaf',
    ].join('\n'));
    expect(ledger.items.map((i) => i.leaf)).toEqual([false, false, true]);
    expect(ledger.items[2].depth).toBe(2);
    expect(ledger.items[2].parentId).toBe(ledger.items[1].id);
    expect(ledger.complete).toBe(true);
  });
});

describe('parseTaskLedger — identities (WS2)', () => {
  it('reads explicit `loop-task-id` comments and strips them from the text', () => {
    const ledger = parseTaskLedger('- [ ] Do the thing <!-- loop-task-id:ws1.thing -->');
    expect(ledger.items[0]).toMatchObject({ id: 'ws1.thing', idSource: 'explicit', text: 'Do the thing' });
  });

  it('reads the identity comment on deferred items before the reason suffix', () => {
    const ledger = parseTaskLedger('- [-] Skip it — deferred: later <!-- loop-task-id:skip.1 -->');
    expect(ledger.items[0]).toMatchObject({ id: 'skip.1', text: 'Skip it', reason: 'later' });
  });

  it('generates deterministic legacy fingerprints from ancestry + text', () => {
    const a = parseTaskLedger('- [ ] parent\n  - [ ] child');
    const b = parseTaskLedger('- [x] parent\n  - [~] child');
    // State changes do not move identity.
    expect(a.items[1].idSource).toBe('legacy-fingerprint');
    expect(a.items[1].id).toBe(b.items[1].id);
    expect(a.items[0].id).toBe(b.items[0].id);
    // Same text under a different parent is a different task.
    const c = parseTaskLedger('- [ ] other parent\n  - [ ] child');
    expect(c.items[1].id).not.toBe(a.items[1].id);
  });

  it('keeps explicit ids stable across reordering', () => {
    const before = parseTaskLedger('- [ ] one <!-- loop-task-id:a -->\n- [ ] two <!-- loop-task-id:b -->');
    const after = parseTaskLedger('- [ ] two <!-- loop-task-id:b -->\n- [x] one <!-- loop-task-id:a -->');
    expect(before.items.map((i) => i.id).sort()).toEqual(after.items.map((i) => i.id).sort());
  });

  it('surfaces duplicate explicit ids instead of silently collapsing them', () => {
    const ledger = parseTaskLedger('- [ ] one <!-- loop-task-id:dup -->\n- [ ] two <!-- loop-task-id:dup -->');
    expect(ledger.duplicateIds).toEqual(['dup']);
    expect(ledger.items).toHaveLength(2);
    expect(ledger.items.map((i) => i.id)).toEqual(['dup', 'dup']);
  });

  it('falls back to a fingerprint for malformed ids and records them', () => {
    const ledger = parseTaskLedger('- [ ] bad one <!-- loop-task-id:has spaces -->\n- [ ] bad two <!-- loop-task-id: -->');
    expect(ledger.items[0].idSource).toBe('legacy-fingerprint');
    expect(ledger.items[1].idSource).toBe('legacy-fingerprint');
    expect(ledger.malformedIds).toEqual(['has spaces', '']);
    expect(ledger.items[0].text).toBe('bad one');
  });
});

describe('serializeTaskLedger', () => {
  it('round-trips item states, nesting, and ids', () => {
    const parsed = parseTaskLedger([
      '- [ ] parent <!-- loop-task-id:p -->',
      '  - [x] done child <!-- loop-task-id:c1 -->',
      '  - [-] deferred child — deferred: why <!-- loop-task-id:c2 -->',
      '- [ ] todo one',
    ].join('\n'));
    const text = serializeTaskLedger(parsed);
    const reparsed = parseTaskLedger(text);
    expect(reparsed.items.map((i) => [i.id, i.state, i.depth, i.parentId, i.leaf]))
      .toEqual(parsed.items.map((i) => [i.id, i.state, i.depth, i.parentId, i.leaf]));
    expect(reparsed.items[2].reason).toBe('why');
    // The serializer always emits explicit ids — the fingerprinted item is now stable.
    expect(reparsed.items[3].idSource).toBe('explicit');
    expect(reparsed.items[3].id).toBe(parsed.items[3].id);
  });
});

describe('deriveLedgerFromChecklist', () => {
  it('derives ledger items from a plan-file checklist (back-compat)', () => {
    const ledger = deriveLedgerFromChecklist('# Plan\n\n- [x] step 1\n- [ ] step 2\n');
    expect(ledger.total).toBe(2);
    expect(ledger.complete).toBe(false);
    expect(ledger.nextTodo).toBe('step 2');
    expect(ledger.items.every((i) => i.idSource === 'legacy-fingerprint')).toBe(true);
  });
});
