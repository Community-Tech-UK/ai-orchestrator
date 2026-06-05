/**
 * generate-cursor-models.ts
 *
 * Regenerates the curated Cursor fallback list embedded in
 * `src/shared/types/provider.types.ts` (the `cursor:` entry of
 * `PROVIDER_MODEL_LIST`) from the installed Cursor CLI.
 *
 * Why this exists
 * ---------------
 * The running app already auto-updates the Cursor model list at runtime: the
 * picker queries `cursor-agent --list-models` via `DynamicModelCatalogService`
 * and shows the full (~130-model) live list. The static block in
 * provider.types.ts is only the *offline fallback* + the pinned/family/tier
 * overlay applied onto that live list. We intentionally keep it tiny — just the
 * latest useful models — so it stays in the file's LOC budget and the picker's
 * "Latest" section is curated rather than a 130-row dump.
 *
 * This script keeps that tiny block honest without hand-editing: it spawns the
 * CLI, finds the newest variant of each curated "slot" (latest GPT / Claude /
 * Gemini + Composer), and rewrites the lines between the
 * `cursor-models:generated:start|end` markers.
 *
 * Selection policy (one entry per slot, newest version wins):
 *   - auto      — the `auto` sentinel (always; Cursor accepts `--model auto`).
 *   - Composer  — highest `composer-<maj>.<min>` (base, non-fast).
 *   - Claude    — highest Opus `*-thinking-high` (non-fast) → "Opus <maj>.<min>".
 *   - Codex     — highest base `gpt-<maj>.<min>-codex` → "Codex <maj>.<min>".
 *   - GPT       — highest base `gpt-<maj>.<min>-high` → "GPT <maj>.<min> High".
 *
 * Usage:
 *   npm run generate:cursor-models           # rewrite the block in place
 *   tsx scripts/generate-cursor-models.ts --check   # CI: fail if drifted
 *
 * `--check` is fail-soft when the CLI is missing/unreachable (exit 0 + notice),
 * so it is safe to run on hosts without an authenticated cursor-agent. It is
 * deliberately NOT wired into `prebuild` for that reason.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_FILE = resolve(
  SCRIPT_DIR,
  '../src/shared/types/provider.types.ts',
);

const START_MARKER = '// cursor-models:generated:start';
const END_MARKER = '// cursor-models:generated:end';
const INDENT = '    '; // entries sit at 4 spaces inside `  cursor: [`

type Tier = 'fast' | 'balanced' | 'powerful';

interface GeneratedEntry {
  /** The id expression rendered into the TS literal (kept verbatim). */
  idExpr: string;
  name: string;
  tier: Tier;
  family: string;
}

// ---------------------------------------------------------------------------
// CLI invocation + parsing
// ---------------------------------------------------------------------------

/** Run `cursor-agent --list-models` and return its stdout, or null on failure. */
function fetchModelOutput(): string | null {
  try {
    const result = spawnSync('cursor-agent', ['--list-models'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.error || result.status !== 0 || !result.stdout) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

/**
 * Parse the plain-text `<id> - <Display Name>` block into model ids. Mirrors
 * `parseCursorModelList` in cursor-cli-adapter.models.ts but kept self-contained
 * so this build script has no app-runtime import chain.
 */
function parseModelIds(output: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([A-Za-z0-9][\w.-]*)\s+-\s+.+$/);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Slot selection
// ---------------------------------------------------------------------------

/** Compare two `[major, minor]` tuples; returns >0 when `a` is newer. */
function compareVersion(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pick the id with the newest version among `ids` for which `versionOf` returns
 * a non-null tuple. Deterministic: ties keep the first-seen id. Pure — the
 * label is derived from the winning id afterwards (never as an iteration
 * side-effect, which would capture the last match rather than the newest).
 */
function pickNewest(
  ids: string[],
  versionOf: (id: string) => number[] | null,
): string | null {
  let best: { id: string; version: number[] } | null = null;
  for (const id of ids) {
    const version = versionOf(id);
    if (!version) continue;
    if (!best || compareVersion(version, best.version) > 0) {
      best = { id, version };
    }
  }
  return best?.id ?? null;
}

function selectComposer(ids: string[]): GeneratedEntry | null {
  const versionOf = (id: string): number[] | null => {
    const m = id.match(/^composer-(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const id = pickNewest(ids, versionOf);
  if (!id) return null;
  const m = id.match(/^composer-(\d+)\.(\d+)$/)!;
  return {
    idExpr: quote(id),
    name: `Composer ${m[1]}.${m[2]}`,
    tier: 'balanced',
    family: 'Composer',
  };
}

// Two Opus id shapes have shipped: `claude-opus-4-8-...` and `claude-4.6-opus-...`.
function opusVersion(id: string): number[] | null {
  const m = id.match(/opus-(\d+)-(\d+)/) ?? id.match(/(\d+)\.(\d+)-opus/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function selectClaudeOpus(ids: string[]): GeneratedEntry | null {
  const candidates = ids.filter(
    (id) =>
      id.includes('opus') &&
      id.includes('thinking') &&
      id.includes('high') &&
      !id.includes('fast'),
  );
  const id = pickNewest(candidates, opusVersion);
  if (!id) return null;
  const v = opusVersion(id)!;
  return {
    idExpr: quote(id),
    name: `Opus ${v[0]}.${v[1]}`,
    tier: 'powerful',
    family: 'Claude',
  };
}

// Headline Codex is the base `gpt-<maj>.<min>-codex` (the CLI's "(current)"
// variant) — not the reasoning-effort (`-high`/`-xhigh`) or `-max`/`-mini` forks.
function codexVersion(id: string): number[] | null {
  const m = id.match(/^gpt-(\d+)\.(\d+)-codex$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function selectCodex(ids: string[]): GeneratedEntry | null {
  const id = pickNewest(ids, codexVersion);
  if (!id) return null;
  const v = codexVersion(id)!;
  return {
    idExpr: quote(id),
    name: `Codex ${v[0]}.${v[1]}`,
    tier: 'balanced',
    family: 'Codex',
  };
}

// Headline GPT is the base `gpt-<maj>.<min>-high` (high-reasoning chat variant,
// displayed e.g. "GPT-5.5 1M High") — not the codex fork, the `-fast` speed
// variant, the other reasoning efforts (`-low`/`-medium`/`-none`/`-extra-high`),
// or the `-mini` forks.
function gptVersion(id: string): number[] | null {
  const m = id.match(/^gpt-(\d+)\.(\d+)-high$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function selectGpt(ids: string[]): GeneratedEntry | null {
  const id = pickNewest(ids, gptVersion);
  if (!id) return null;
  const v = gptVersion(id)!;
  return {
    idExpr: quote(id),
    name: `GPT ${v[0]}.${v[1]} High`,
    tier: 'balanced',
    family: 'GPT',
  };
}

/** The fixed `auto` sentinel — kept identical to the existing source line. */
const AUTO_ENTRY: GeneratedEntry = {
  idExpr: 'CURSOR_MODELS.AUTO',
  name: 'Auto (let Cursor pick)',
  tier: 'balanced',
  family: 'Auto',
};

function buildEntries(ids: string[]): GeneratedEntry[] {
  const slots: { name: string; entry: GeneratedEntry | null }[] = [
    { name: 'Composer', entry: selectComposer(ids) },
    { name: 'Claude (Opus)', entry: selectClaudeOpus(ids) },
    { name: 'Codex', entry: selectCodex(ids) },
    { name: 'GPT', entry: selectGpt(ids) },
  ];

  const missing = slots.filter((slot) => slot.entry === null).map((s) => s.name);
  if (missing.length > 0) {
    throw new Error(
      `Could not resolve Cursor model slot(s): ${missing.join(', ')}. ` +
        `The CLI's id scheme may have changed — update the selectors in ` +
        `scripts/generate-cursor-models.ts.`,
    );
  }

  return [AUTO_ENTRY, ...slots.map((slot) => slot.entry as GeneratedEntry)];
}

// ---------------------------------------------------------------------------
// Rendering + file rewrite
// ---------------------------------------------------------------------------

function quote(value: string): string {
  return `'${value}'`;
}

function renderEntry(entry: GeneratedEntry): string {
  return (
    `${INDENT}{ id: ${entry.idExpr}, name: ${quote(entry.name)}, ` +
    `tier: ${quote(entry.tier)}, pinned: true, family: ${quote(entry.family)} },`
  );
}

function renderBlock(entries: GeneratedEntry[]): string {
  return entries.map(renderEntry).join('\n');
}

interface BlockBounds {
  before: string;
  after: string;
  current: string;
}

function locateBlock(source: string): BlockBounds {
  const startIdx = source.indexOf(START_MARKER);
  const endIdx = source.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Could not find the cursor-models generated markers in ${TARGET_FILE}.`,
    );
  }
  // Keep the marker lines; replace only the lines strictly between them.
  const afterStart = source.indexOf('\n', startIdx) + 1;
  const beforeEnd = source.lastIndexOf('\n', endIdx);
  return {
    before: source.slice(0, afterStart),
    current: source.slice(afterStart, beforeEnd),
    after: source.slice(beforeEnd),
  };
}

function main(): void {
  const check = process.argv.includes('--check');

  const output = fetchModelOutput();
  if (!output) {
    const message =
      'cursor-agent --list-models unavailable (CLI missing, unauthenticated, ' +
      'or timed out).';
    if (check) {
      console.log(`generate:cursor-models — skipped: ${message}`);
      process.exit(0);
    }
    console.error(`generate:cursor-models — ${message}`);
    process.exit(1);
  }

  const ids = parseModelIds(output);
  const entries = buildEntries(ids);
  const block = renderBlock(entries);

  const source = readFileSync(TARGET_FILE, 'utf8');
  const { before, current, after } = locateBlock(source);

  if (current === block) {
    console.log('generate:cursor-models — up to date.');
    process.exit(0);
  }

  if (check) {
    console.error(
      'generate:cursor-models — DRIFT: the curated Cursor list is out of date.\n' +
        `Run \`npm run generate:cursor-models\` to refresh.\n\nExpected:\n${block}\n\nFound:\n${current}`,
    );
    process.exit(1);
  }

  writeFileSync(TARGET_FILE, `${before}${block}${after}`);
  console.log(`generate:cursor-models — wrote ${entries.length} entries:`);
  for (const entry of entries) console.log(`  ${entry.name} (${entry.idExpr})`);
}

main();
