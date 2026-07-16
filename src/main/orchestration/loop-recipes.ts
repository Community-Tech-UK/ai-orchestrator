/**
 * Fable WS6 — loop recipe packs.
 *
 * Stage-work prompts (the `- **PLAN/REVIEW/IMPLEMENT** — …` block in
 * `LoopStageMachine.buildPrompt`) become versioned, per-task-type recipe packs
 * instead of hardcoded strings. A pack is a directory:
 *
 *   <base>/loop-recipes/<name>/recipe.json   (schema below)
 *   <base>/loop-recipes/<name>/stages/{plan,review,implement}.md
 *
 * Built-ins ship in `<repo>/resources/loop-recipes` (dev) /
 * `process.resourcesPath/loop-recipes` (packaged). User packs under
 * `~/.ai-orchestrator/loop-recipes/` override built-ins BY NAME; collisions
 * and malformed packs are surfaced as diagnostics (Doctor) and fall back to
 * the built-in — never a silent behavior change.
 *
 * SAFETY BOUNDARY: recipes own ONLY the stage-work instructions. The
 * completion machinery (rename gates, sentinels, verdict discipline, ledger
 * rules) stays hardcoded in `buildPrompt` — a recipe cannot weaken it. The
 * `coding` built-in is extracted VERBATIM from the previously hardcoded
 * prompts and a byte-equality spec guards against drift; `investigation`
 * likewise mirrors the previous goalIntent branch.
 *
 * Stage files may use these placeholders (rendered per run):
 *   {{stateDir}} {{notesPath}} {{tasksPath}} {{reportPath}}
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { getLogger } from '../logging/logger';
import type { LoopGoalIntent, LoopStage } from '../../shared/types/loop.types';

const logger = getLogger('LoopRecipes');

export const DEFAULT_LOOP_RECIPE = 'coding';
/** Recipe implied by `goalIntent: 'investigation'` when none is selected. */
export const INVESTIGATION_LOOP_RECIPE = 'investigation';

export const LoopRecipeManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1).max(500),
  version: z.number().int().positive().default(1),
  /** Per-stage prompt file refs, relative to the pack dir. */
  stages: z.object({
    plan: z.string().min(1),
    review: z.string().min(1),
    implement: z.string().min(1),
  }),
  /** Optional per-stage recovery hints (surfaced on degraded retries). */
  recoveryHints: z.object({
    PLAN: z.string().optional(),
    REVIEW: z.string().optional(),
    IMPLEMENT: z.string().optional(),
  }).optional(),
  /** Optional verify-command suggestions for the loop config panel. */
  verifyCommandSuggestions: z.array(z.string()).max(10).optional(),
});
export type LoopRecipeManifest = z.infer<typeof LoopRecipeManifestSchema>;

export interface LoopRecipe {
  manifest: LoopRecipeManifest;
  /** Raw stage templates (placeholders unrendered). */
  stageTemplates: { plan: string; review: string; implement: string };
  source: 'built-in' | 'user';
  packDir: string;
}

export interface LoopRecipeDiagnostic {
  recipe: string;
  kind: 'user-override' | 'malformed-pack' | 'missing-stage-file' | 'unknown-recipe-fallback';
  detail: string;
}

export interface LoopRecipeRegistry {
  recipes: Map<string, LoopRecipe>;
  diagnostics: LoopRecipeDiagnostic[];
}

export interface LoopRecipePathContext {
  stateDir: string;
  notesPath: string;
  tasksPath: string;
  reportPath: string;
}

/** Dev/packaged base for built-in packs (electron imported lazily so pure
 * tests and worker contexts never pull it in transitively). */
function builtInRecipesDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { isPackaged?: boolean; getAppPath?: () => string } };
    if (electron.app?.isPackaged && typeof process.resourcesPath === 'string' && process.resourcesPath) {
      return path.join(process.resourcesPath, 'loop-recipes');
    }
    const appPath = electron.app?.getAppPath?.();
    if (appPath) return path.join(appPath, 'resources', 'loop-recipes');
  } catch {
    // Not in an electron context (tests / workers) — fall through to cwd.
  }
  return path.join(process.cwd(), 'resources', 'loop-recipes');
}

let userDirOverride: string | null = null;

/** Test seam: point the user-pack directory somewhere explicit. */
export function _setLoopRecipeUserDirForTesting(dir: string | null): void {
  userDirOverride = dir;
  cachedRegistry = null;
}

function userRecipesDir(): string {
  return userDirOverride ?? path.join(homedir(), '.ai-orchestrator', 'loop-recipes');
}

function loadPack(packDir: string, source: LoopRecipe['source'], diagnostics: LoopRecipeDiagnostic[]): LoopRecipe | null {
  const name = path.basename(packDir);
  let manifest: LoopRecipeManifest;
  try {
    const parsed = LoopRecipeManifestSchema.safeParse(
      JSON.parse(readFileSync(path.join(packDir, 'recipe.json'), 'utf8')),
    );
    if (!parsed.success) {
      diagnostics.push({
        recipe: name,
        kind: 'malformed-pack',
        detail: `recipe.json failed validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      });
      return null;
    }
    manifest = parsed.data;
  } catch (err) {
    diagnostics.push({
      recipe: name,
      kind: 'malformed-pack',
      detail: `recipe.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
  const stageTemplates = { plan: '', review: '', implement: '' };
  for (const stage of ['plan', 'review', 'implement'] as const) {
    const stagePath = path.resolve(packDir, manifest.stages[stage]);
    // A stage ref must stay inside its pack — a pack is a self-contained unit.
    if (!stagePath.startsWith(path.resolve(packDir) + path.sep)) {
      diagnostics.push({ recipe: name, kind: 'malformed-pack', detail: `stage ref escapes the pack dir: ${manifest.stages[stage]}` });
      return null;
    }
    try {
      stageTemplates[stage] = readFileSync(stagePath, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    } catch {
      diagnostics.push({ recipe: name, kind: 'missing-stage-file', detail: `missing stage file: ${manifest.stages[stage]}` });
      return null;
    }
  }
  return { manifest, stageTemplates, source, packDir };
}

function loadPacksFrom(baseDir: string, source: LoopRecipe['source'], diagnostics: LoopRecipeDiagnostic[]): LoopRecipe[] {
  if (!existsSync(baseDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const packs: LoopRecipe[] = [];
  for (const entry of entries) {
    const pack = loadPack(path.join(baseDir, entry), source, diagnostics);
    if (pack) packs.push(pack);
  }
  return packs;
}

let cachedRegistry: LoopRecipeRegistry | null = null;

/** Load built-in + user recipe packs. Cached; user packs override by name. */
export function loadLoopRecipeRegistry(forceReload = false): LoopRecipeRegistry {
  if (cachedRegistry && !forceReload) return cachedRegistry;
  const diagnostics: LoopRecipeDiagnostic[] = [];
  const recipes = new Map<string, LoopRecipe>();
  for (const pack of loadPacksFrom(builtInRecipesDir(), 'built-in', diagnostics)) {
    recipes.set(pack.manifest.name, pack);
  }
  for (const pack of loadPacksFrom(userRecipesDir(), 'user', diagnostics)) {
    if (recipes.has(pack.manifest.name)) {
      diagnostics.push({
        recipe: pack.manifest.name,
        kind: 'user-override',
        detail: `user pack at ${pack.packDir} overrides the built-in recipe`,
      });
    }
    recipes.set(pack.manifest.name, pack);
  }
  for (const diagnostic of diagnostics) {
    logger.warn('Loop recipe diagnostic', { ...diagnostic });
  }
  cachedRegistry = { recipes, diagnostics };
  return cachedRegistry;
}

/** Test seam. */
export function _resetLoopRecipeRegistryForTesting(): void {
  cachedRegistry = null;
}

/**
 * Resolve the effective recipe: explicit selection wins; an investigation
 * goal implies the `investigation` recipe; default `coding`. Unknown names
 * fall back to `coding` with a diagnostic — never a silent behavior change.
 */
export function resolveLoopRecipe(
  selected: string | undefined,
  goalIntent: LoopGoalIntent | undefined,
): { recipe: LoopRecipe; fallback: LoopRecipeDiagnostic | null } {
  const registry = loadLoopRecipeRegistry();
  const wanted = selected?.trim()
    || (goalIntent === 'investigation' ? INVESTIGATION_LOOP_RECIPE : DEFAULT_LOOP_RECIPE);
  const found = registry.recipes.get(wanted);
  if (found) return { recipe: found, fallback: null };
  const fallback = registry.recipes.get(DEFAULT_LOOP_RECIPE);
  if (!fallback) {
    throw new Error(
      `Loop recipe "${wanted}" not found and the built-in "${DEFAULT_LOOP_RECIPE}" pack is missing — `
      + 'the resources/loop-recipes directory is not installed correctly.',
    );
  }
  const diagnostic: LoopRecipeDiagnostic = {
    recipe: wanted,
    kind: 'unknown-recipe-fallback',
    detail: `recipe "${wanted}" not found; using "${DEFAULT_LOOP_RECIPE}"`,
  };
  logger.warn('Loop recipe fallback', { ...diagnostic });
  return { recipe: fallback, fallback: diagnostic };
}

function renderTemplate(template: string, context: LoopRecipePathContext): string {
  return template
    .replaceAll('{{stateDir}}', context.stateDir)
    .replaceAll('{{notesPath}}', context.notesPath)
    .replaceAll('{{tasksPath}}', context.tasksPath)
    .replaceAll('{{reportPath}}', context.reportPath);
}

/**
 * Render the stage-work block exactly as `buildPrompt` embeds it:
 * three `- **STAGE** — …` bullets joined by newlines.
 */
export function renderRecipeStageBlock(recipe: LoopRecipe, context: LoopRecipePathContext): string {
  return [
    `- **PLAN** — ${renderTemplate(recipe.stageTemplates.plan, context)}`,
    `- **REVIEW** — ${renderTemplate(recipe.stageTemplates.review, context)}`,
    `- **IMPLEMENT** — ${renderTemplate(recipe.stageTemplates.implement, context)}`,
  ].join('\n');
}

/** Recovery hint for a stage, when the pack provides one. */
export function recipeRecoveryHint(recipe: LoopRecipe, stage: LoopStage): string | null {
  return recipe.manifest.recoveryHints?.[stage] ?? null;
}
