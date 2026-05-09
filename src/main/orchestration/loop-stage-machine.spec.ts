import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LoopStageMachine, parsePlanChecklist } from './loop-stage-machine';
import { defaultLoopConfig } from '../../shared/types/loop.types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-stage-test-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopStageMachine', () => {
  it('bootstrap creates STAGE.md / NOTES.md / ITERATION_LOG.md', async () => {
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'do thing');
    const stage = await m.bootstrap(cfg);
    expect(stage).toBe('IMPLEMENT');
    expect(fs.readFileSync(path.join(tmpDir, 'STAGE.md'), 'utf8').trim()).toBe('IMPLEMENT');
    expect(fs.existsSync(path.join(tmpDir, 'NOTES.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'ITERATION_LOG.md'))).toBe(true);
  });

  it('bootstrap respects an existing valid STAGE.md', async () => {
    fs.writeFileSync(path.join(tmpDir, 'STAGE.md'), 'IMPLEMENT\n');
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const stage = await m.bootstrap(cfg);
    expect(stage).toBe('IMPLEMENT');
  });

  it('readStage falls back to initialStage when STAGE.md is gibberish', async () => {
    fs.writeFileSync(path.join(tmpDir, 'STAGE.md'), 'BANANA\n');
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const stage = await m.readStage(cfg);
    expect(stage).toBe('IMPLEMENT');
  });

  it('buildPrompt mentions stage transitions and the verify command', () => {
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    cfg.completion.verifyCommand = 'echo hi';
    const p = m.buildPrompt({ config: cfg, iterationSeq: 7, pendingInterventions: [] });
    expect(p).toContain('Iteration 7');
    expect(p).toContain('STAGE.md');
    expect(p).toContain('PLAN');
    expect(p).toContain('REVIEW');
    expect(p).toContain('IMPLEMENT');
    expect(p).toContain('echo hi');
  });

  it('buildPrompt embeds pending interventions verbatim', () => {
    const m = new LoopStageMachine(tmpDir);
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
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'My specific goal text');
    const iter0 = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    const iter5 = m.buildPrompt({ config: cfg, iterationSeq: 5, pendingInterventions: [] });
    expect(iter0).toContain('Goal (persistent across iterations)');
    expect(iter0).toContain('My specific goal text');
    expect(iter5).toContain('Goal (persistent across iterations)');
    expect(iter5).toContain('My specific goal text');
  });

  it('buildPrompt injects existing-session context as runtime background without changing the goal', () => {
    const m = new LoopStageMachine(tmpDir);
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
    const m = new LoopStageMachine(tmpDir);
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
    const m = new LoopStageMachine(tmpDir);
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
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'just one prompt');
    cfg.iterationPrompt = undefined;
    const iter1 = m.buildPrompt({ config: cfg, iterationSeq: 1, pendingInterventions: [] });
    expect(iter1).not.toContain('Loop Continuation Directive');
    // Goal block still present so the AI has context.
    expect(iter1).toContain('Goal (persistent across iterations)');
    expect(iter1).toContain('just one prompt');
  });

  it('buildPrompt preserves user prompts when planFile is set (does not silently drop)', () => {
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'user goal text');
    cfg.iterationPrompt = 'user directive text';
    cfg.planFile = 'PLAN.md';
    const iter0 = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    const iter1 = m.buildPrompt({ config: cfg, iterationSeq: 1, pendingInterventions: [] });
    expect(iter0).toContain('user goal text');
    expect(iter1).toContain('user goal text');
    expect(iter1).toContain('user directive text');
    // Plan file is referenced in body too.
    expect(iter0).toContain('PLAN.md');
  });

  it('buildPrompt includes the autonomous-mode rules block', () => {
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const p = m.buildPrompt({ config: cfg, iterationSeq: 0, pendingInterventions: [] });
    expect(p).toContain('Autonomous Mode Rules');
    expect(p).toContain('Do not ask clarifying questions');
    expect(p).toContain('BLOCKED.md');
  });

  it('appendIterationLog writes a structured entry', async () => {
    const m = new LoopStageMachine(tmpDir);
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
    const log = fs.readFileSync(path.join(tmpDir, 'ITERATION_LOG.md'), 'utf8');
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
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap).toEqual({ doneSentinelPresent: false, planChecklistFullyChecked: false });
  });

  it('detects a stale DONE.txt that survived bootstrap (e.g. unlink failed)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'DONE.txt'), 'leftover\n');
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    // NOTE: we deliberately skip bootstrap() here to simulate the failure
    // case where the unlink would otherwise have removed it.
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.doneSentinelPresent).toBe(true);
  });

  it('detects an already-fully-checked planFile', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '# Plan\n- [x] one\n- [x] two\n',
    );
    const m = new LoopStageMachine(tmpDir);
    const cfg = { ...defaultLoopConfig(tmpDir, 'x'), planFile: 'PLAN.md' };
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.planChecklistFullyChecked).toBe(true);
  });

  it('returns false for plan when planFile is configured but missing on disk', async () => {
    const m = new LoopStageMachine(tmpDir);
    const cfg = { ...defaultLoopConfig(tmpDir, 'x'), planFile: 'PLAN.md' };
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.planChecklistFullyChecked).toBe(false);
  });

  it('returns false for plan when no planFile is configured', async () => {
    const m = new LoopStageMachine(tmpDir);
    const cfg = defaultLoopConfig(tmpDir, 'x');
    expect(cfg.planFile).toBeUndefined();
    const snap = await m.captureStartupSnapshot(cfg);
    expect(snap.planChecklistFullyChecked).toBe(false);
  });
});
