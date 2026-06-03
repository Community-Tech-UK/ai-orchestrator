import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LoopStageMachine, parsePlanChecklist } from './loop-stage-machine';
import { resolveLoopArtifactPaths, loopStateFile, type LoopArtifactPaths } from './loop-artifact-paths';
import { parseTaskLedger } from './loop-task-ledger';
import { defaultLoopConfig } from '../../shared/types/loop.types';

const RUN_ID = 'loop-test-1';
let tmpDir: string;
let paths: LoopArtifactPaths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-stage-test-'));
  paths = resolveLoopArtifactPaths(tmpDir, RUN_ID);
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopStageMachine', () => {
  it('bootstrap creates STAGE.md / NOTES.md / ITERATION_LOG.md in the per-run state dir (not the workspace root)', async () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'do thing');
    const stage = await m.bootstrap(cfg);
    expect(stage).toBe('IMPLEMENT');
    expect(fs.readFileSync(paths.stage, 'utf8').trim()).toBe('IMPLEMENT');
    expect(fs.existsSync(paths.notes)).toBe(true);
    expect(fs.existsSync(paths.iterationLog)).toBe(true);
    expect(fs.existsSync(paths.tasks)).toBe(true);
    // Crucially NOT at the workspace root — that is what made two loops in one
    // workspace collide and a new run inherit a prior run's files.
    expect(fs.existsSync(path.join(tmpDir, 'STAGE.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'LOOP_TASKS.md'))).toBe(false);
  });

  it('bootstrap writes a fresh empty LOOP_TASKS.md, and preserves an existing one on same-run re-bootstrap (recovery)', async () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'work the freshly attached doc');
    await m.bootstrap(cfg);

    // Fresh template has zero checkbox items → it cannot fire ledger-complete.
    expect(parseTaskLedger(fs.readFileSync(paths.tasks, 'utf8')).total).toBe(0);

    // Simulate in-progress work, then a same-run re-bootstrap (recovery path):
    // the in-progress ledger must be PRESERVED, not reset.
    fs.writeFileSync(paths.tasks, '- [ ] a real in-progress work item\n');
    await m.bootstrap(cfg);
    expect(fs.readFileSync(paths.tasks, 'utf8')).toContain('a real in-progress work item');
  });

  it('two runs in the same workspace get isolated state dirs (no cross-talk)', async () => {
    const a = new LoopStageMachine(tmpDir, 'loop-A');
    const b = new LoopStageMachine(tmpDir, 'loop-B');
    await a.bootstrap(defaultLoopConfig(tmpDir, 'goal a'));
    await b.bootstrap(defaultLoopConfig(tmpDir, 'goal b'));

    expect(a.paths.dir).not.toBe(b.paths.dir);
    // Advancing run A's stage must not touch run B's.
    fs.writeFileSync(a.paths.stage, 'REVIEW\n');
    expect(fs.readFileSync(a.paths.stage, 'utf8').trim()).toBe('REVIEW');
    expect(fs.readFileSync(b.paths.stage, 'utf8').trim()).toBe('IMPLEMENT');
  });

  it('bootstrap respects an existing valid STAGE.md in the per-run dir', async () => {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.stage, 'PLAN\n');
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const stage = await m.bootstrap(cfg);
    expect(stage).toBe('PLAN');
  });

  it('readStage falls back to initialStage when STAGE.md is gibberish', async () => {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.stage, 'BANANA\n');
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const stage = await m.readStage(cfg);
    expect(stage).toBe('IMPLEMENT');
  });

  it('buildPrompt scopes the loop state files under the per-run .aio-loop-state dir', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const p = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    expect(p).toContain(`${m.paths.relDir}/STAGE.md`);
    expect(p).toContain(`${m.paths.relDir}/NOTES.md`);
    expect(p).toContain(`${m.paths.relDir}/LOOP_TASKS.md`);
    expect(p).toContain(`${m.paths.relDir}/DONE.txt`);
    expect(p).toContain(`${m.paths.relDir}/BLOCKED.md`);
    // And the explicit directive that loop state lives there.
    expect(p).toContain('Loop state directory');
  });

  it('buildPrompt includes "Uncompleted Plan Files Detected" block when given uncompleted plans', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const p = m.buildPrompt({
      config: cfg,
      iterationSeq: 0,
      pendingInterventions: [],
      uncompletedPlanFilesAtStart: ['claude2.md', 'gemini.md'],
    });
    expect(p).toContain('Uncompleted Plan Files Detected');
    expect(p).toContain('`claude2.md`');
    expect(p).toContain('`gemini.md`');
    expect(p).toContain('requireCompletedFileRename');
    expect(p).not.toContain('the coordinator will run an **independent cross-model fresh-eyes review**');
  });

  it('buildPrompt only mentions fresh-eyes review when the gate is explicitly enabled', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    cfg.completion.crossModelReview = {
      enabled: true,
      blockingSeverities: ['critical', 'high'],
      timeoutSeconds: 90,
      reviewDepth: 'structured',
    };
    const p = m.buildPrompt({
      config: cfg,
      iterationSeq: 0,
      pendingInterventions: [],
      uncompletedPlanFilesAtStart: ['plan.md'],
    });

    expect(p).toContain('Fresh-eyes review is enabled');
    expect(p).toContain('critical/high severity finding');
  });

  it('FU-2: buildPrompt includes the manual-review-only block when manualReviewOnly=true', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const p = m.buildPrompt({
      config: cfg,
      iterationSeq: 0,
      pendingInterventions: [],
      manualReviewOnly: true,
    });
    expect(p).toContain('Manual-Review-Only Loop');
    expect(p).toContain('verifyCommand');
    expect(p).toContain('pause the loop for the operator to review');
  });

  it('FU-2: buildPrompt omits the manual-review-only block when manualReviewOnly is false/undefined', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const p1 = m.buildPrompt({
      config: cfg,
      iterationSeq: 0,
      pendingInterventions: [],
      manualReviewOnly: false,
    });
    expect(p1).not.toContain('Manual-Review-Only Loop');
    const p2 = m.buildPrompt({
      config: cfg,
      iterationSeq: 0,
      pendingInterventions: [],
    });
    expect(p2).not.toContain('Manual-Review-Only Loop');
  });

  it('buildPrompt omits the uncompleted-plans block when none are provided', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const p = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    expect(p).not.toContain('Uncompleted Plan Files Detected');
  });

  it('buildPrompt mentions stage transitions and the verify command', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    cfg.completion.verifyCommand = 'echo hi';
    const p = m.buildPrompt({ config: cfg, iterationSeq: 7, pendingInterventions: [] });
    expect(p).toContain('Iteration 7');
    expect(p).toContain('STAGE.md');
    expect(p).toContain('PLAN');
    expect(p).toContain('REVIEW');
    expect(p).toContain('IMPLEMENT');
    expect(p).toContain('echo hi');
    expect(p).toContain('Completion Inventory');
    // The DONE sentinel is now written at the scoped path; assert the durable
    // marker step still precedes the <promise>DONE</promise> emission.
    expect(p).toContain('DONE.txt');
    expect(p.indexOf('containing the date')).toBeLessThan(p.indexOf('Append `<promise>DONE</promise>`'));
  });

  it('buildPrompt embeds pending interventions verbatim', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const p = m.buildPrompt({
      config: cfg,
      iterationSeq: 1,
      pendingInterventions: ['Use test fixtures, not the real db'],
    });
    expect(p).toContain('User Intervention');
    expect(p).toContain('Use test fixtures, not the real db');
  });

  it('buildPrompt includes the persistent goal block on every iteration', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'My specific goal text');
    const iter0 = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    const iter5 = m.buildPrompt({ config: cfg, iterationSeq: 5, pendingInterventions: [] });
    expect(iter0).toContain('Goal (persistent across iterations)');
    expect(iter0).toContain('My specific goal text');
    expect(iter5).toContain('Goal (persistent across iterations)');
    expect(iter5).toContain('My specific goal text');
  });

  it('buildPrompt injects existing-session context as runtime background without changing the goal', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'My current loop goal');
    cfg.contextStrategy = 'fresh-child';
    const iter0 = m.buildPrompt({
      config: cfg,
      iterationSeq: 0,
      pendingInterventions: [],
      existingSessionContext: '<conversation_history>old session marker</conversation_history>',
    });
    const iter3 = m.buildPrompt({
      config: cfg,
      iterationSeq: 3,
      pendingInterventions: [],
      existingSessionContext: '<conversation_history>old session marker</conversation_history>',
    });

    expect(cfg.initialPrompt).toBe('My current loop goal');
    expect(iter0).toContain('Existing Session Context (read-only background)');
    expect(iter0).toContain('old session marker');
    expect(iter3).toContain('Existing Session Context (read-only background)');
    expect(iter3).toContain('old session marker');
    expect(iter0.indexOf('Existing Session Context')).toBeLessThan(iter0.indexOf('Goal (persistent across iterations)'));
  });

  it('buildPrompt only injects existing-session context once for same-session loops', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'My current loop goal');
    cfg.contextStrategy = 'same-session';
    const iter0 = m.buildPrompt({
      config: cfg,
      iterationSeq: 0,
      pendingInterventions: [],
      existingSessionContext: 'old session marker',
    });
    const iter1 = m.buildPrompt({
      config: cfg,
      iterationSeq: 1,
      pendingInterventions: [],
      existingSessionContext: 'old session marker',
    });

    expect(iter0).toContain('old session marker');
    expect(iter1).not.toContain('old session marker');
  });

  it('buildPrompt only renders the continuation directive on iter > 0 when iterationPrompt is set', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'goal text');
    cfg.iterationPrompt = 'please continue, fresh eyes, no shortcuts';
    const iter0 = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    const iter1 = m.buildPrompt({ config: cfg, iterationSeq: 1, pendingInterventions: [] });
    expect(iter0).not.toContain('Loop Continuation Directive');
    expect(iter0).not.toContain('please continue, fresh eyes');
    expect(iter1).toContain('Loop Continuation Directive');
    expect(iter1).toContain('please continue, fresh eyes, no shortcuts');
  });

  it('buildPrompt omits the continuation directive when iterationPrompt is unset', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'just one prompt');
    cfg.iterationPrompt = undefined;
    const iter1 = m.buildPrompt({ config: cfg, iterationSeq: 1, pendingInterventions: [] });
    expect(iter1).not.toContain('Loop Continuation Directive');
    // Goal block still present so the AI has context.
    expect(iter1).toContain('Goal (persistent across iterations)');
    expect(iter1).toContain('just one prompt');
  });

  it('buildPrompt preserves user prompts when planFile is set (does not silently drop)', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'user goal text');
    cfg.iterationPrompt = 'user directive text';
    cfg.planFile = 'PLAN.md';
    const iter0 = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    const iter1 = m.buildPrompt({ config: cfg, iterationSeq: 1, pendingInterventions: [] });
    expect(iter0).toContain('user goal text');
    expect(iter1).toContain('user goal text');
    expect(iter1).toContain('user directive text');
    // Plan file (a user doc) is referenced in body too — and stays workspace-relative.
    expect(iter0).toContain('PLAN.md');
  });

  it('buildPrompt includes the autonomous-mode rules block', () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const p = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    expect(p).toContain('Autonomous Mode Rules');
    expect(p).toContain('Do not ask clarifying questions');
    expect(p).toContain('BLOCKED.md');
  });

  it('appendIterationLog writes a structured entry', async () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    await m.bootstrap(cfg);
    await m.appendIterationLog({
      seq: 3,
      stage: 'IMPLEMENT',
      verdict: 'WARN',
      tokens: 1234,
      durationMs: 4567,
      filesChanged: 2,
      progressNotes: ['[A/WARN] identical hash'],
      completionNotes: [],
    });
    const log = fs.readFileSync(paths.iterationLog, 'utf8');
    expect(log).toContain('## Iteration 3');
    expect(log).toContain('IMPLEMENT');
    expect(log).toContain('WARN');
    expect(log).toContain('[A/WARN] identical hash');
  });
});

describe('parsePlanChecklist (single-source-of-truth checkbox parser)', () => {
  it('reports fullyChecked=true only when at least one item exists and all are ticked', () => {
    expect(parsePlanChecklist('# P\n- [x] one\n- [x] two\n')).toEqual({
      checked: 2,
      unchecked: 0,
      total: 2,
      fullyChecked: true,
    });
  });

  it('reports fullyChecked=false when any item is unchecked', () => {
    expect(parsePlanChecklist('- [x] a\n- [ ] b\n').fullyChecked).toBe(false);
  });

  it('reports fullyChecked=false when there are zero items (empty plan should not look complete)', () => {
    expect(parsePlanChecklist('# Plan\n\nFreeform prose, no boxes.\n')).toEqual({
      checked: 0,
      unchecked: 0,
      total: 0,
      fullyChecked: false,
    });
  });

  it('accepts both `-` and `*` bullets and `[x]/[X]`', () => {
    const r = parsePlanChecklist('- [x] dash-x\n* [X] star-cap-X\n- [ ] open\n');
    expect(r.checked).toBe(2);
    expect(r.unchecked).toBe(1);
    expect(r.fullyChecked).toBe(false);
  });
});

describe('LoopStageMachine.captureStartupSnapshot', () => {
  it('captures both flags as false in a clean workspace', async () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap).toEqual({
      doneSentinelPresent: false,
      planChecklistFullyChecked: false,
      uncompletedPlanFilesAtStart: [],
      loopTasksLedgerResolvedAtStart: false,
    });
  });

  it('lists uncompleted plan-like .md files but excludes denylist + already-completed names', async () => {
    fs.writeFileSync(path.join(tmpDir, 'my-plan.md'), '# Plan\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Readme\n');           // denylisted
    fs.writeFileSync(path.join(tmpDir, 'NOTES.md'), '# Notes\n');             // denylisted
    fs.writeFileSync(path.join(tmpDir, 'STAGE.md'), 'IMPLEMENT\n');           // denylisted
    fs.writeFileSync(path.join(tmpDir, 'feature_completed.md'), '# Done\n'); // already completed
    fs.writeFileSync(path.join(tmpDir, 'other_Completed.md'), '# Done\n');   // already completed (cap C)
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.uncompletedPlanFilesAtStart).toEqual(['my-plan.md']);
  });

  it('does NOT classify a prose .md (no checkbox, no plan-ish name) as a plan — but DOES via a checklist', async () => {
    // Regression for the incident: `token-efficiency-accuracy-*.md` are published
    // blog drafts — prose, no checkboxes, no plan-ish name. They must NOT be
    // flagged as "uncompleted plans" (which made the agent rename them to satisfy
    // the rename gate). A same-shaped file with a checklist IS a plan.
    fs.writeFileSync(path.join(tmpDir, 'token-efficiency-accuracy-linkedin.md'), 'We spent weeks getting token usage under control. Prose, no checkboxes.\n');
    fs.writeFileSync(path.join(tmpDir, 'random-notes-doc.md'), 'Just some freeform prose with no boxes.\n');
    fs.writeFileSync(path.join(tmpDir, 'work-items.md'), '# Work\n- [ ] do a thing\n- [x] did a thing\n'); // checklist → plan
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.uncompletedPlanFilesAtStart).toEqual(['work-items.md']);
  });

  it('detects a done sentinel present in the per-run state dir at start', async () => {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(loopStateFile(paths, 'DONE.txt'), 'leftover\n');
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    // NOTE: skip bootstrap to simulate a sentinel that survived into the snapshot.
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.doneSentinelPresent).toBe(true);
  });

  it('ignores a workspace-root DONE.txt — the sentinel is scoped to the per-run dir', async () => {
    fs.writeFileSync(path.join(tmpDir, 'DONE.txt'), 'leftover at root\n');
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.doneSentinelPresent).toBe(false);
  });

  it('detects an already-fully-checked planFile', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '# Plan\n- [x] one\n- [x] two\n',
    );
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = { ...defaultLoopConfig(tmpDir, 'x'), planFile: 'PLAN.md' };
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.planChecklistFullyChecked).toBe(true);
  });

  it('returns false for plan when planFile is configured but missing on disk', async () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = { ...defaultLoopConfig(tmpDir, 'x'), planFile: 'PLAN.md' };
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.planChecklistFullyChecked).toBe(false);
  });

  it('returns false for plan when no planFile is configured', async () => {
    const m = new LoopStageMachine(tmpDir, RUN_ID);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    expect(cfg.planFile).toBeUndefined();
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.planChecklistFullyChecked).toBe(false);
  });
});
