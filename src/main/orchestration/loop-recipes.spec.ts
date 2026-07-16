/**
 * Fable WS6 Task 1 — recipe packs: loader, resolution, and the byte-equality
 * guarantee that the default `coding` / `investigation` packs reproduce the
 * previously hardcoded stage prompts EXACTLY (no behavior change by default).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetLoopRecipeRegistryForTesting,
  _setLoopRecipeUserDirForTesting,
  loadLoopRecipeRegistry,
  renderRecipeStageBlock,
  resolveLoopRecipe,
  type LoopRecipePathContext,
} from './loop-recipes';

const CONTEXT: LoopRecipePathContext = {
  stateDir: '/ws/.aio-loop-state/loop-1',
  notesPath: '/ws/.aio-loop-state/loop-1/NOTES.md',
  tasksPath: '/ws/.aio-loop-state/loop-1/LOOP_TASKS.md',
  reportPath: '/ws/.aio-loop-state/loop-1/REPORT.md',
};

/** The EXACT strings buildPrompt hardcoded before WS6 (verbatim). */
const LEGACY_IMPLEMENTATION_BLOCK = `- **PLAN** — Continue or improve the plan. Choose the best architectural decisions. Do not take shortcuts. If a plan does not exist yet, draft one.
- **REVIEW** — Re-read the plan with completely fresh eyes. Treat the plan as if a stranger wrote it. Identify and fix issues. Improve clarity, completeness, and correctness. If the plan is sound, say so explicitly.
- **IMPLEMENT** — Implement the next concrete chunk toward the goal. If a plan exists, follow it. If no plan exists, inspect the code and make progress directly rather than drafting a new plan unless the user explicitly asked for planning. For broad goals such as "implement everything", first build or update the \`${CONTEXT.notesPath}\` completion inventory by searching for unfinished implementations (for example TODO/FIXME, "not implemented", placeholder, stub, fake/mock behavior in production paths, constant returns standing in for real logic). Use maintainable architecture. After implementing, re-review your code with completely fresh eyes and fix anything you'd reject in code review. Run appropriate verification if you can.`;

const LEGACY_INVESTIGATION_BLOCK = `- **PLAN** — Scope the investigation: in \`${CONTEXT.tasksPath}\`, list the concrete questions / sub-claims you must resolve to answer the goal (one checkbox each). Do not draft a software plan.
- **REVIEW** — Re-read \`${CONTEXT.reportPath}\` with completely fresh eyes. Is every claim backed by \`file:line\` evidence? Flag and fix any unverified assertion, gap, or item you accepted from a doc without confirming in code.
- **IMPLEMENT** — Do the investigation: read the relevant code, resolve each open question in the ledger, and write/extend \`${CONTEXT.reportPath}\` with the answer and \`file:line\` citations. **Do not edit production code.** Run read-only checks (grep/tests/build output) only to gather evidence.`;

beforeEach(() => {
  _resetLoopRecipeRegistryForTesting();
});

afterEach(() => {
  _resetLoopRecipeRegistryForTesting();
  vi.restoreAllMocks();
});

describe('byte-equality with the previously hardcoded prompts', () => {
  it('the coding pack renders the legacy implementation block EXACTLY', () => {
    const { recipe, fallback } = resolveLoopRecipe(undefined, 'implementation');
    expect(fallback).toBeNull();
    expect(recipe.manifest.name).toBe('coding');
    expect(renderRecipeStageBlock(recipe, CONTEXT)).toBe(LEGACY_IMPLEMENTATION_BLOCK);
  });

  it('the investigation pack renders the legacy investigation block EXACTLY', () => {
    const { recipe, fallback } = resolveLoopRecipe(undefined, 'investigation');
    expect(fallback).toBeNull();
    expect(recipe.manifest.name).toBe('investigation');
    expect(renderRecipeStageBlock(recipe, CONTEXT)).toBe(LEGACY_INVESTIGATION_BLOCK);
  });
});

describe('resolution rules', () => {
  it('an explicit recipe wins over goal intent', () => {
    const { recipe } = resolveLoopRecipe('coding', 'investigation');
    expect(recipe.manifest.name).toBe('coding');
  });

  it('switching recipes changes the stage prompts', () => {
    const coding = resolveLoopRecipe('coding', undefined).recipe;
    const docs = resolveLoopRecipe('doc-work', undefined).recipe;
    expect(renderRecipeStageBlock(docs, CONTEXT)).not.toBe(renderRecipeStageBlock(coding, CONTEXT));
    expect(renderRecipeStageBlock(docs, CONTEXT)).toContain('target reader');
  });

  it('an unknown recipe falls back to coding WITH a diagnostic (never silently)', () => {
    const { recipe, fallback } = resolveLoopRecipe('does-not-exist', undefined);
    expect(recipe.manifest.name).toBe('coding');
    expect(fallback).toMatchObject({ kind: 'unknown-recipe-fallback', recipe: 'does-not-exist' });
  });
});

describe('registry loading and user overrides', () => {
  let fakeHome: string | null = null;

  afterEach(() => {
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
    fakeHome = null;
    _setLoopRecipeUserDirForTesting(null);
    _resetLoopRecipeRegistryForTesting();
  });

  function writeUserCodingPack(opts: { badJson?: boolean } = {}): void {
    fakeHome = mkdtempSync(join(tmpdir(), 'loop-recipes-home-'));
    _setLoopRecipeUserDirForTesting(join(fakeHome, '.ai-orchestrator', 'loop-recipes'));
    const dir = join(fakeHome, '.ai-orchestrator', 'loop-recipes', 'coding');
    mkdirSync(join(dir, 'stages'), { recursive: true });
    if (opts.badJson) {
      writeFileSync(join(dir, 'recipe.json'), '{not json');
      return;
    }
    writeFileSync(join(dir, 'recipe.json'), JSON.stringify({
      name: 'coding',
      description: 'operator-tuned coding pack',
      stages: { plan: 'stages/plan.md', review: 'stages/review.md', implement: 'stages/implement.md' },
    }));
    writeFileSync(join(dir, 'stages/plan.md'), 'OPERATOR PLAN {{tasksPath}}');
    writeFileSync(join(dir, 'stages/review.md'), 'OPERATOR REVIEW');
    writeFileSync(join(dir, 'stages/implement.md'), 'OPERATOR IMPLEMENT');
  }

  it('built-ins load with no diagnostics', () => {
    const registry = loadLoopRecipeRegistry(true);
    expect([...registry.recipes.keys()]).toEqual(expect.arrayContaining(['coding', 'doc-work', 'investigation']));
    expect(registry.diagnostics).toEqual([]);
  });

  it('a user pack overrides a built-in by name and surfaces a diagnostic', () => {
    writeUserCodingPack();

    const registry = loadLoopRecipeRegistry(true);

    const coding = registry.recipes.get('coding');
    expect(coding?.source).toBe('user');
    expect(renderRecipeStageBlock(coding!, CONTEXT)).toContain(`OPERATOR PLAN ${CONTEXT.tasksPath}`);
    expect(registry.diagnostics).toContainEqual(expect.objectContaining({ kind: 'user-override', recipe: 'coding' }));
  });

  it('a malformed user pack is skipped with a diagnostic and the built-in survives', () => {
    writeUserCodingPack({ badJson: true });

    const registry = loadLoopRecipeRegistry(true);

    expect(registry.recipes.get('coding')?.source).toBe('built-in');
    expect(registry.diagnostics).toContainEqual(expect.objectContaining({ kind: 'malformed-pack', recipe: 'coding' }));
  });
});
