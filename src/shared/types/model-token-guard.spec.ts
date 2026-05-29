/**
 * Guard: model identifiers must come from the single source of truth
 * (`CLAUDE_MODELS` / `*_MODELS` in provider.types.ts), not hardcoded literals
 * in app code. Prevents the class of bug where a stale concrete Claude model id
 * (e.g. a "claude-3-…" string) rots in a default/list and gets handed to the CLI,
 * which rejects it.
 *
 * Scope: quoted concrete Claude model-id literals in src/main + src/renderer.
 * Bare aliases ("sonnet"/"opus"/"haiku") are intentionally fine — the CLI
 * resolves them to the latest version, so they never need updating. Comment
 * lines are ignored. A small allowlist covers files that legitimately hold raw
 * ids (historical pricing tables, legacy→alias migration maps).
 *
 * If this fails: import the relevant `*_MODELS` constant from provider.types.ts
 * and reference it instead of the literal.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_DIRS = ['src/main', 'src/renderer'];

// Matches a quoted concrete Claude model id, e.g. 'claude-3-sonnet',
// "claude-opus-4-7", `claude-sonnet-4.6`. Bare prefix checks like 'claude-3'
// or 'claude-' do NOT match (they require a family + separator).
const CONCRETE_CLAUDE_ID = /['"`]claude-(?:3|opus|sonnet|haiku)[-.][\w.\-]*['"`]/;

// Files that legitimately contain raw model ids (data tables, not app logic).
const ALLOWLIST = new Set<string>([
  // legacy full id -> bare alias migration map
  'src/main/core/config/settings-manager.ts',
  // historical pricing keyed by full API id (cost tracking for old models)
  'src/main/rlm/token-counter.ts',
  'src/renderer/app/features/verification/shared/services/verification.service.ts',
]);

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function collectTsFiles(absDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(absDir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries
    .filter(
      (p) =>
        p.endsWith('.ts') &&
        !p.endsWith('.spec.ts') &&
        !p.endsWith('.d.ts') &&
        !p.includes('__tests__'),
    )
    .map((p) => join(absDir, p));
}

describe('model-token guard', () => {
  it('has no hardcoded concrete Claude model-id literals in app code', () => {
    const violations: string[] = [];

    for (const dir of SCAN_DIRS) {
      const absDir = join(REPO_ROOT, dir);
      for (const file of collectTsFiles(absDir)) {
        const rel = relative(REPO_ROOT, file).split('\\').join('/');
        if (ALLOWLIST.has(rel)) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (isCommentLine(line.trim())) return;
          // Strip inline comments so commented-out examples don't trip the guard.
          const stripped = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
          if (CONCRETE_CLAUDE_ID.test(stripped)) {
            violations.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(
      violations,
      `Hardcoded Claude model ids found — import a *_MODELS constant from provider.types.ts instead:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
