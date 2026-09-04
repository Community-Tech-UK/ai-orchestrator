import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import {
  buildLoopHandoff,
  clipHandoffInjectNote,
  HANDOFF_INJECT_MAX_CHARS,
  HANDOFF_INJECT_MAX_LINE_CHARS,
  HANDOFF_INJECT_MAX_LINES,
  loadRehydrationNote,
  MAX_REHYDRATE_BYTES_PER_FILE,
  MAX_REHYDRATE_TOTAL_BYTES,
  validateLoopHandoff,
  writeLoopHandoff,
} from './loop-recycle-handoff';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import type { LoopChildResult } from './loop-coordinator.types';

function makeState(id: string, cwd: string, goal = 'Ship the recycle handoff'): LoopState {
  const config = defaultLoopConfig(cwd, goal);
  config.planFile = 'PLAN.md';
  return {
    id,
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: 0,
    endedAt: null,
    totalIterations: 1,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
  };
}

function makeIteration(): LoopIteration {
  return {
    id: 'iter-1',
    loopRunId: 'loop-handoff-1',
    seq: 3,
    stage: 'IMPLEMENT',
    startedAt: 0,
    endedAt: 1,
    childInstanceId: null,
    tokens: 400,
    costCents: 0,
    filesChanged: [{ path: 'src/foo.ts', additions: 1, deletions: 0, contentHash: 'c' }],
    toolCalls: [
      { toolName: 'Read', argsHash: 'a', success: true, durationMs: 1 },
      { toolName: 'Edit', argsHash: 'b', success: true, durationMs: 1 },
    ],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: 'h',
    outputSimilarityToPrev: null,
    outputExcerpt: 'this assistant answer must never appear in the handoff',
    outputFull: 'this assistant answer must never appear in the handoff',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'failed',
    verifyOutputExcerpt: 'expected 2 to equal 1',
  };
}

function makeChild(): LoopChildResult {
  return {
    childInstanceId: null,
    output: 'assistant answer',
    tokens: 400,
    filesChanged: [{ path: 'src/foo.ts', additions: 1, deletions: 0, contentHash: 'c' }],
    toolCalls: [
      { toolName: 'Read', argsHash: 'a', success: true, durationMs: 1 },
      { toolName: 'Edit', argsHash: 'b', success: true, durationMs: 1 },
    ],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
    unresolvedToolCalls: false,
  };
}

describe('loop-recycle-handoff', () => {
  let cwd = '';

  afterEach(async () => {
    if (cwd) await fsp.rm(cwd, { recursive: true, force: true });
    cwd = '';
  });

  it('writes a handoff that keeps the goal and open ledger ids', async () => {
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'aio-handoff-'));
    const state = makeState('loop-handoff-1', cwd);
    const tasksPath = resolveLoopArtifactPaths(cwd, state.id).tasks;
    await fsp.mkdir(path.dirname(tasksPath), { recursive: true });
    await fsp.writeFile(
      tasksPath,
      '- [ ] Open work <!-- loop-task-id:open.work -->\n- [x] Done item <!-- loop-task-id:done.item -->\n',
      'utf8',
    );
    const dest = await writeLoopHandoff({
      state,
      iteration: makeIteration(),
      childResult: makeChild(),
    });
    expect(dest).toBeTruthy();
    const parsed = JSON.parse(await fsp.readFile(dest!, 'utf8')) as Awaited<ReturnType<typeof buildLoopHandoff>>;
    expect(parsed?.goal).toBe('Ship the recycle handoff');
    expect(parsed?.openLedgerLeaves.map((leaf) => leaf.id)).toEqual(['open.work']);
    expect(JSON.stringify(parsed)).not.toContain('this assistant answer must never appear');
    expect(parsed?.lastVerify?.status).toBe('failed');
  });

  it('rejects a handoff that drops the goal or ledger ids', () => {
    const ok = {
      goal: 'keep me',
      openLedgerLeaves: [{ id: 'a', state: 'todo', text: 'A' }],
      lastVerify: null,
      filesTouched: [],
      decisions: [],
      lastTurns: [],
    };
    expect(validateLoopHandoff(ok, 'keep me', ['a'])).toBe(true);
    expect(validateLoopHandoff({ ...ok, goal: '' }, 'keep me', ['a'])).toBe(false);
    expect(validateLoopHandoff({ ...ok, openLedgerLeaves: [] }, 'keep me', ['a'])).toBe(false);
  });

  it('drops an unmatched trailing tool so a pair is never split', async () => {
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'aio-handoff-pair-'));
    const state = makeState('loop-handoff-pair', cwd);
    const child = makeChild();
    child.unresolvedToolCalls = true;
    child.toolCalls = [
      { toolName: 'Read', argsHash: 'a', success: true, durationMs: 1 },
      { toolName: 'Bash', argsHash: 'b', success: true, durationMs: 1 },
    ];
    const handoff = await buildLoopHandoff({
      state,
      iteration: makeIteration(),
      childResult: child,
    });
    expect(handoff?.lastTurns[0]?.tools).toEqual(['Read']);
  });

  it('clips the inject note to claw-code scale', () => {
    const longLine = 'x'.repeat(HANDOFF_INJECT_MAX_LINE_CHARS + 40);
    const many = Array.from({ length: HANDOFF_INJECT_MAX_LINES + 5 }, () => longLine).join('\n');
    const clipped = clipHandoffInjectNote(many);
    expect(clipped.split('\n').length).toBeLessThanOrEqual(HANDOFF_INJECT_MAX_LINES);
    expect(clipped.length).toBeLessThanOrEqual(HANDOFF_INJECT_MAX_CHARS);
    expect(clipped.split('\n')[0]!.length).toBeLessThanOrEqual(HANDOFF_INJECT_MAX_LINE_CHARS);
  });

  it('T39: prefers path+hash pointers and keeps plan/ledger bodies out of the inject note', async () => {
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'aio-rehydrate-'));
    const plan = path.join(cwd, 'PLAN.md');
    const tasks = path.join(cwd, 'LOOP_TASKS.md');
    const src = path.join(cwd, 'src.ts');
    await fsp.writeFile(plan, `# Plan\n${'goal body '.repeat(80)}\n`, 'utf8');
    await fsp.writeFile(tasks, '- [ ] keep as pointer\n', 'utf8');
    await fsp.writeFile(src, 'export const n = 1;\n', 'utf8');
    const note = await loadRehydrationNote([plan, tasks, src]);
    expect(note).toContain('sha256:');
    expect(note).toContain(plan);
    expect(note).toContain(tasks);
    expect(note).not.toContain('goal body goal body');
    expect(note.length).toBeLessThanOrEqual(MAX_REHYDRATE_TOTAL_BYTES + 200);
    expect(MAX_REHYDRATE_BYTES_PER_FILE).toBe(1_200);
    expect(MAX_REHYDRATE_TOTAL_BYTES).toBe(2_800);
  });
});
