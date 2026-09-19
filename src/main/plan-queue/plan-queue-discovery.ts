/**
 * Plan Queue discovery — pure code, no LLM.
 *
 * Finds the documents a run should work through and classifies each by its
 * filename state (docs/plans lifecycle: `_plan.md` active, `_livetest.md`
 * pending live checks, `_completed` closed). Content is read only for two
 * deterministic checks: the standing-register marker and a plan's linked spec.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { PlanQueueKind } from '@contracts/schemas/plan-queue';

export interface DiscoveredDocument {
  /** Absolute path in the root checkout. */
  path: string;
  readiness: 'candidate' | 'not-ready';
  /** Why a `not-ready` document cannot start without James. */
  reason?: string;
}

/** Documents live under docs/ (docs/plans, docs/superpowers/plans, ...). */
const DEFAULT_GLOB = 'docs/**/*.md';

/** Directories never searched: generated, vendored, archived or other checkouts. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  '.claude',
  '.aio-review',
  '_archive',
  'archive',
  '_scratch',
  'dist',
]);

const STANDING_REGISTER_RE = /^\**Type:\**\s*standing register/im;
const SPEC_LINE_RE = /^\*\*Spec:\*\*(.*)$/m;
const MARKDOWN_LINK_TARGET_RE = /\]\(([^)\s]+\.md)\)/;
const HEADER_LINES = 40;
const MAX_FILES = 5_000;

/** Convert a repo-relative glob (`*`, `**`, `?`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        const followedBySlash = normalized[i + 2] === '/';
        source += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

type FilenameState = 'plan' | 'livetest' | 'spec-unplanned' | 'other';

export function classifyFilename(fileName: string): FilenameState {
  const name = fileName.toLowerCase();
  if (!name.endsWith('.md') || name.includes('_completed')) return 'other';
  if (name.endsWith('_livetest.md')) return 'livetest';
  if (name.endsWith('_plan.md')) return 'plan';
  if (name.endsWith('_spec.md')) return 'spec-unplanned';
  return 'other';
}

async function walkMarkdown(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

async function readHeader(file: string): Promise<string> {
  try {
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').slice(0, HEADER_LINES).join('\n');
  } catch {
    return '';
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false);
}

/** A plan whose `**Spec:**` line links a file that is not on disk is not ready. */
async function missingLinkedSpec(planPath: string, header: string): Promise<string | null> {
  const specLine = SPEC_LINE_RE.exec(header)?.[1];
  const target = specLine ? MARKDOWN_LINK_TARGET_RE.exec(specLine)?.[1] : undefined;
  if (!target || /^[a-z]+:\/\//i.test(target)) return null;
  const resolved = path.resolve(path.dirname(planPath), decodeURIComponent(target));
  if (await exists(resolved)) return null;
  return `the plan links spec ${path.basename(resolved)}, which does not exist`;
}

function planPathsFor(specPath: string): string[] {
  const base = path.basename(specPath).replace(/_spec\.md$/i, '');
  const dir = path.dirname(specPath);
  return [
    path.join(dir, `${base}_plan.md`),
    path.join(dir, '..', 'plans', `${base}_plan.md`),
  ];
}

/**
 * List the run's documents in stable path order.
 *
 * @param repoRoot the root checkout; every returned path is inside it.
 * @param glob optional repo-relative filter, e.g. `docs/plans/2026-09-*`.
 */
export async function discoverPlanQueueDocuments(
  repoRoot: string,
  kind: PlanQueueKind,
  glob?: string,
): Promise<DiscoveredDocument[]> {
  const matcher = globToRegExp(glob?.trim() || DEFAULT_GLOB);
  const files: string[] = [];
  await walkMarkdown(repoRoot, files);

  const discovered: DiscoveredDocument[] = [];
  for (const file of files.sort()) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    if (!matcher.test(relative)) continue;
    const state = classifyFilename(path.basename(file));
    const wanted = kind === 'plans'
      ? state === 'plan' || state === 'spec-unplanned'
      : state === 'livetest';
    if (!wanted) continue;

    const header = await readHeader(file);
    if (STANDING_REGISTER_RE.test(header)) continue;

    if (state === 'spec-unplanned') {
      const planned = await Promise.all(planPathsFor(file).map(exists));
      if (!planned.some(Boolean)) {
        discovered.push({ path: file, readiness: 'not-ready', reason: 'this spec has no implementation plan yet' });
      }
      continue;
    }

    const specProblem = state === 'plan' ? await missingLinkedSpec(file, header) : null;
    discovered.push(
      specProblem
        ? { path: file, readiness: 'not-ready', reason: specProblem }
        : { path: file, readiness: 'candidate' },
    );
  }
  return discovered;
}
