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
import { countHiddenPlanQueueCopies, isExactPlanQueueSelection, selectPlanQueuePaths } from './plan-queue-discovery-paths';
import type { PlanQueueDiscoveryPreview } from '@contracts/schemas/plan-queue';

export interface DiscoveredDocument {
  /** Absolute path in the root checkout. */
  path: string;
  readiness: 'candidate' | 'not-ready';
  /** Structural prerequisite triage must investigate before a worker starts. */
  reason?: string;
}

/** Documents live under docs/ (docs/plans, docs/superpowers/plans, ...). */
const DEFAULT_GLOB = 'docs/**/*.md';

const STANDING_REGISTER_RE = /^\**Type:\**\s*standing register/im;
/**
 * A programme document that is not itself a queue job (each of its phases is
 * queued separately). Only the first lines are read, so a stray mention of the
 * phrase further down never hides a real plan.
 */
const NOT_AN_ITEM_RE = /^Queue:[ \t]*not an item[ \t]*$/im;
const NOT_AN_ITEM_HEADER_LINES = 8;
const SPEC_LINE_RE = /^\*\*Spec:\*\*(.*)$/m;
const MARKDOWN_LINK_TARGET_RE = /\]\(([^)\s]+\.md)\)/;
const HEADER_LINES = 40;
const HEADER_BYTES = 16 * 1024;

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

async function readHeader(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead).split('\n').slice(0, HEADER_LINES).join('\n');
  } finally {
    await handle.close();
  }
}

function insideRoot(repoRoot: string, target: string): boolean {
  const relative = path.relative(repoRoot, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(repoRoot: string, target: string): Promise<boolean> {
  if (!insideRoot(repoRoot, target)) return false;
  try {
    const resolved = await fs.realpath(target);
    return insideRoot(repoRoot, resolved) && (await fs.stat(resolved)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** A plan whose `**Spec:**` line links a file that is not on disk is not ready. */
async function missingLinkedSpec(repoRoot: string, planPath: string, header: string): Promise<string | null> {
  const specLine = SPEC_LINE_RE.exec(header)?.[1];
  const target = specLine ? MARKDOWN_LINK_TARGET_RE.exec(specLine)?.[1] : undefined;
  if (!target || /^[a-z]+:\/\//i.test(target)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return 'the plan has an invalid local spec link';
  }
  const resolved = path.resolve(path.dirname(planPath), decoded);
  if (!insideRoot(repoRoot, resolved)) return 'the plan links a spec outside this repository';
  if (await exists(repoRoot, resolved)) return null;
  return `the plan links spec ${path.basename(resolved)}, which does not exist as a file inside this repository`;
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
  repoRoot = await fs.realpath(repoRoot);
  const selection = glob?.trim() || DEFAULT_GLOB;
  const matcher = globToRegExp(selection);
  const files = await selectPlanQueuePaths(repoRoot, selection, matcher, name => {
    const state = classifyFilename(name);
    return kind === 'plans' ? state === 'plan' || state === 'spec-unplanned' : state === 'livetest';
  });

  const discovered: DiscoveredDocument[] = [];
  for (const file of files) {
    const state = classifyFilename(path.basename(file));

    const header = await readHeader(file);
    if (STANDING_REGISTER_RE.test(header)) continue;
    if (NOT_AN_ITEM_RE.test(header.split('\n').slice(0, NOT_AN_ITEM_HEADER_LINES).join('\n'))) continue;

    if (state === 'spec-unplanned') {
      const planned = await Promise.all(planPathsFor(file).map(file => exists(repoRoot, file)));
      if (!planned.some(Boolean)) {
        discovered.push({ path: file, readiness: 'not-ready', reason: 'this spec has no implementation plan yet' });
      }
      continue;
    }

    const specProblem = state === 'plan' ? await missingLinkedSpec(repoRoot, file, header) : null;
    discovered.push(
      specProblem
        ? { path: file, readiness: 'not-ready', reason: specProblem }
        : { path: file, readiness: 'candidate' },
    );
  }
  return discovered;
}

/** Read-only form preview; exact picks retain their no-walk guarantee. */
export async function previewPlanQueueDocuments(repoRoot: string, kind: PlanQueueKind, glob?: string): Promise<PlanQueueDiscoveryPreview> {
  repoRoot = await fs.realpath(repoRoot);
  const documents = await discoverPlanQueueDocuments(repoRoot, kind, glob);
  if (isExactPlanQueueSelection(glob)) return { found: documents.length, hiddenCopies: null, hiddenCountComplete: true };
  const selection = glob?.trim() || DEFAULT_GLOB;
  const hidden = await countHiddenPlanQueueCopies(repoRoot, selection, globToRegExp(selection), name => {
    const state = classifyFilename(name);
    return kind === 'plans' ? state === 'plan' || state === 'spec-unplanned' : state === 'livetest';
  });
  return { found: documents.length, hiddenCopies: hidden.count, hiddenCountComplete: hidden.complete };
}
