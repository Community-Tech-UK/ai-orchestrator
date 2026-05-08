import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LoopStageMachine } from './loop-stage-machine';
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
    expect(stage).toBe('PLAN');
    expect(fs.readFileSync(path.join(tmpDir, 'STAGE.md'), 'utf8').trim()).toBe('PLAN');
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
    expect(stage).toBe('PLAN');
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
