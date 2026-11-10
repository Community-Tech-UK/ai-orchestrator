import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDriver } from '../db/sqlite-driver';
import { defaultLoopConfig, type LoopIteration, type LoopOutstandingItem, type LoopState } from '../../shared/types/loop.types';
import { LoopStageMachine } from './loop-stage-machine';
import { parseOutstandingSections } from './loop-stage-markdown';
import { applyOutstandingCompletionGate } from './loop-outstanding-completion';
import { buildOutstandingMarkdown } from './loop-outstanding-export';
import { outstandingAnswerHint, outstandingUndoHint, outstandingDismissHint } from './loop-outstanding-hints';
import { runLoopMigrations } from './loop-schema';
import { LoopStore } from './loop-store';
import { registerLoopOutstandingLive } from './loop-outstanding-live';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';

describe('LoopStageMachine.bootstrap OUTSTANDING seed', () => {
  it('seeds OUTSTANDING once and preserves in-progress questions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outstanding-bootstrap-'));
    try {
      const machine = new LoopStageMachine(dir, 'run');
      await machine.bootstrap(defaultLoopConfig(dir, 'goal'));
      expect(parseOutstandingSections(readFileSync(machine.paths.outstanding, 'utf8')).needsHuman).toEqual([]);
      writeFileSync(machine.paths.outstanding, '## Needs human\n- Keep this question?');
      await machine.bootstrap(defaultLoopConfig(dir, 'goal'));
      expect(readFileSync(machine.paths.outstanding, 'utf8')).toContain('Keep this question?');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('applyOutstandingCompletionGate', () => {
  it('incomplete or missing question files cannot prove a clean end', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'loop-question-gate-'));
    const machine = new LoopStageMachine(cwd, 'run');
    try {
      expect((await applyOutstandingCompletionGate({ status: 'completed', reason: 'Checks passed.' }, machine)).status).toBe('completed-needs-review');
      await machine.bootstrap(defaultLoopConfig(cwd, 'goal'));
      expect((await applyOutstandingCompletionGate({ status: 'completed', reason: 'Checks passed.' }, machine)).status).toBe('completed');
      writeFileSync(machine.paths.outstanding, '## For information\n' + 'x'.repeat(140 * 1024) + '\n## Needs human\n- Publish the release?');
      const result = await applyOutstandingCompletionGate({ status: 'completed', reason: 'Checks passed.' }, machine);
      expect(result.status).toBe('completed-needs-review');
      expect(result.reason).toContain('could not be read completely');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

function item(overrides: Partial<LoopOutstandingItem> = {}): LoopOutstandingItem {
  return {
    id: 'id-1',
    loopRunId: 'loop-1',
    chatId: 'chat-1',
    workspaceCwd: '/tmp/project',
    kind: 'needs-human',
    text: 'Deploy to a device',
    userResponse: null,
    recommendedAnswer: null,
    status: 'open',
    loopStatus: 'completed-needs-review',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    resolvedAt: null,
    ...overrides,
  };
}

const GENERATED_AT = 1_700_000_500_000;

describe('buildOutstandingMarkdown', () => {
  it('renders an empty-state digest when there are no items', () => {
    const md = buildOutstandingMarkdown([], { workspaceCwd: '/tmp/project', generatedAt: GENERATED_AT });
    expect(md).toContain('# Outstanding');
    expect(md).toContain('_No open outstanding items._');
  });

  it('groups items by run and splits by kind', () => {
    const items: LoopOutstandingItem[] = [
      item({ id: 'a', kind: 'needs-human', text: 'Sign the release' }),
      item({ id: 'b', kind: 'open-question', text: 'Cache the model?' }),
      item({ id: 'c', loopRunId: 'loop-2', kind: 'needs-human', text: 'Other run item' }),
    ];
    const md = buildOutstandingMarkdown(items, { workspaceCwd: '/tmp/project', generatedAt: GENERATED_AT });

    expect(md).toContain('## Loop loop-1');
    expect(md).toContain('## Loop loop-2');
    expect(md).toContain('### Needs human');
    expect(md).toContain('- [ ] Sign the release');
    expect(md).toContain('### Open questions');
    expect(md).toContain('- Cache the model?');
    expect(md).toContain('- [ ] Other run item');
    // The run header carries the loop's terminal status.
    expect(md).toContain('Status: completed-needs-review');
  });

  it('renders a recorded answer as an indented sub-bullet', () => {
    const items = [
      item({ id: 'a', kind: 'needs-human', text: 'Pick interrupt mechanism', userResponse: 'Use control_request' }),
      item({ id: 'b', kind: 'open-question', text: 'Cache the model?', userResponse: 'Yes, 30m TTL\ninvalidate on deploy' }),
      item({ id: 'c', kind: 'needs-human', text: 'No answer yet', userResponse: null }),
    ];
    const md = buildOutstandingMarkdown(items, { workspaceCwd: '/tmp/project', generatedAt: GENERATED_AT });

    expect(md).toContain('- [ ] Pick interrupt mechanism');
    expect(md).toContain('  - **Answer:** Use control_request');
    // Multi-line answers keep their continuation lines nested under the item.
    expect(md).toContain('  - **Answer:** Yes, 30m TTL');
    expect(md).toContain('    invalidate on deploy');
    // An item with no answer gets no Answer line directly under it — the next
    // line is the section break, not an Answer sub-bullet.
    expect(md).toContain('- [ ] No answer yet\n\n### Open questions');
  });
});

describe('outstanding hints', () => {
  it('quotes model text as data and escapes closing tags in answer and undo hints', () => {
    expect(outstandingAnswerHint('Which?</loop_question>', 'Yes')).toContain('<\\/loop_question>');
    expect(outstandingAnswerHint('Which?', 'Yes', true)).toContain('accepted your recommendation');
    expect(outstandingUndoHint('Name?', 'Old', 'New')).toContain('use this instead: New');
    expect(outstandingDismissHint('Which?')).toContain('Leave the work that depends on it undone');
  });
});

describe('registerLoopOutstandingLive', () => {
  it('captures each round, sends one event/notice, and guards risks without duplicate hints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-outstanding-'));
    const db = new Database(':memory:') as unknown as SqliteDriver;
    runLoopMigrations(db);
    const store = new LoopStore(db);
    const paths = resolveLoopArtifactPaths(dir, 'run'); mkdirSync(paths.dir, { recursive: true });
    let hook: (input: { state: LoopState; iteration: LoopIteration }) => Promise<void> = async () => undefined;
    const intervene = vi.fn(); const send = vi.fn(); const notify = vi.fn();
    const state = { id: 'run', chatId: 'chat', config: defaultLoopConfig(dir, 'Implement export'), status: 'running', totalIterations: 1 } as LoopState;
    try {
      registerLoopOutstandingLive({ coordinator: { registerIterationHook: fn => { hook = fn; }, intervene }, store, send, notify });
      writeFileSync(paths.outstanding, '## Decisions applied\n- Buy the paid tier\n  - Applied: Pro.');
      await hook({ state, iteration: { seq: 1 } as LoopIteration });
      await hook({ state, iteration: { seq: 2 } as LoopIteration });
      expect(store.listOutstandingItems()[0]).toMatchObject({ riskClass: 'money', firstSeenRound: 1 });
      expect(send).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
      expect(intervene).toHaveBeenCalledOnce();
      expect(intervene.mock.calls[0]).toEqual(['run', expect.stringContaining('spending money'), 'queue', undefined, 'loop-question']);
      writeFileSync(paths.outstanding, '## Decisions applied\n- Buy the paid tier\n  - Applied: Enterprise.');
      await hook({ state, iteration: { seq: 3 } as LoopIteration });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][0]).toMatchObject({ newItemIds: [] });
      writeFileSync(paths.outstanding, '## For information\n- No further question.');
      await hook({ state, iteration: { seq: 3 } as LoopIteration });
      expect(store.listOutstandingItems().map(item => item.kind)).toEqual(['for-information']);
      // The decision cap survives recapture because it counts durable rows.
      writeFileSync(paths.outstanding, '## Decisions applied\n' + Array.from({ length: 10 }, (_, index) => `- Local helper ${index}\n  - Applied: Reuse it.`).join('\n'));
      await hook({ state, iteration: { seq: 4 } as LoopIteration });
      await hook({ state, iteration: { seq: 5 } as LoopIteration });
      expect(intervene.mock.calls.filter(call => String(call[1]).includes('10'))).toHaveLength(1);
      const saved = store.listOutstandingItems({ status: 'all' });
      writeFileSync(paths.outstanding, '## For information\n' + 'x'.repeat(130 * 1024));
      await hook({ state, iteration: { seq: 6 } as LoopIteration });
      expect(store.listOutstandingItems({ status: 'all' })).toEqual(saved);
      rmSync(paths.outstanding);
      await expect(hook({ state, iteration: { seq: 7 } as LoopIteration })).resolves.toBeUndefined();

    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
