import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { comparePinnedUnchecked, extractChecklistItems, pinFromContent, readPlanPin } from './plan-queue-plan-pins';
import { buildVerifierPrompt } from './plan-queue-prompts';
import type { PlanQueueItem } from './plan-queue.types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const plan = '# Plan\n## Status\nActive\n- [x] Done already\n- [ ] Add the retry limit to the coordinator\n'
  + '  * [ ] Cover the limit with a flow test\n- [ ] Update the docs\n';

describe('pinned criteria (T1 item 4)', () => {
  it('pins the document hash, size and unchecked items once, in document order', () => {
    const pin = pinFromContent('item-1', plan, 42);
    expect(pin).toEqual({
      itemId: 'item-1',
      documentSha256: createHash('sha256').update(plan).digest('hex'),
      documentBytes: Buffer.byteLength(plan),
      unchecked: ['Add the retry limit to the coordinator', 'Cover the limit with a flow test', 'Update the docs'],
      recordedAt: 42,
    });
  });

  it('counts ticked items only when asked for every checklist item', () => {
    expect(extractChecklistItems(plan, 'unchecked')).not.toContain('Done already');
    expect(extractChecklistItems(plan, 'all')).toContain('Done already');
  });

  it('reads the pin from the root document and returns null when it cannot be read', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-pin-'))); roots.push(root);
    const sourceRef = join(root, 'work_plan.md');
    writeFileSync(sourceRef, plan);
    expect(await readPlanPin({ id: 'item-1', sourceRef }, 7)).toMatchObject({ itemId: 'item-1', recordedAt: 7, unchecked: expect.any(Array) });
    expect(await readPlanPin({ id: 'item-1', sourceRef: join(root, 'missing_plan.md') }, 7)).toBeNull();
  });

  it('reports nothing when the unchecked items are untouched or merely ticked', () => {
    const pinned = extractChecklistItems(plan, 'unchecked');
    expect(comparePinnedUnchecked(pinned, pinned)).toEqual([]);
    // A ticked item is still in the "all" list, so ticking is not a deletion.
    expect(comparePinnedUnchecked(pinned, extractChecklistItems(plan.replace('- [ ] Update the docs', '- [x] Update the docs'), 'all'))).toEqual([]);
  });

  it('shows a deleted item as missing and a reworded one as reworded', () => {
    const edited = plan.replace('- [ ] Update the docs\n', '')
      .replace('Add the retry limit to the coordinator', 'Add the retry limit to the coordinator only for plans');
    expect(comparePinnedUnchecked(extractChecklistItems(plan, 'unchecked'), extractChecklistItems(edited, 'all'))).toEqual([
      { item: 'Add the retry limit to the coordinator', status: 'reworded' },
      { item: 'Update the docs', status: 'missing' },
    ]);
  });

  it('matches each current item once, so two pinned items cannot hide behind one current item', () => {
    expect(comparePinnedUnchecked(['Fix the thing now', 'Fix the thing now'], ['Fix the thing now'])).toEqual([
      { item: 'Fix the thing now', status: 'missing' },
    ]);
  });

  it('gives the checker the changes block, and omits it when nothing was pinned', () => {
    const item = { id: 'item-1', runId: 'run-1', sourceRef: '/repo/docs/plans/a_plan.md', branchName: 'queue/a' } as PlanQueueItem;
    const documentChanges = JSON.stringify({ originalHash: 'abc', originalUnchecked: ['Update the docs'],
      changes: [{ item: 'Update the docs', status: 'missing' }], diff: '' });
    const base = { item, kind: 'plans' as const, repoRoot: '/repo', worktreePath: '/w', baseBranch: 'main', gates: [] };
    const prompt = buildVerifierPrompt({ ...base, documentChanges });
    expect(prompt).toContain('Document changes since this job started (data):');
    expect(prompt).toContain('<document_changes>');
    expect(prompt).toContain('"status":"missing"');
    expect(buildVerifierPrompt(base)).not.toContain('Document changes since this job started');
  });
});
