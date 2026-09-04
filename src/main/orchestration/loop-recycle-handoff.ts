/**
 * T6 + T39: structured recycle handoff and OpenClaw-scale rehydrate caps.
 *
 * Recycle must not pay a summariser turn or dump 50k of NOTES. The durable
 * payload is HANDOFF.json (goal verbatim + open ledger ids). The next prompt
 * gets a capped pointer note: paths + hashes, bodies only under the total.
 * `getSmartCompactionManager()` is never called from this path (T16 / G3).
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseTaskLedger } from './loop-task-ledger';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import type { LoopChildResult } from './loop-coordinator.types';
import type { LoopIteration, LoopState } from '../../shared/types/loop.types';

export const LOOP_HANDOFF_FILE = 'HANDOFF.json';
export const MAX_REHYDRATE_FILES = 5;
export const MAX_REHYDRATE_BYTES_PER_FILE = 1_200;
export const MAX_REHYDRATE_TOTAL_BYTES = 2_800;
export const HANDOFF_INJECT_MAX_CHARS = 1_200;
export const HANDOFF_INJECT_MAX_LINES = 24;
export const HANDOFF_INJECT_MAX_LINE_CHARS = 160;
export const HANDOFF_KEEP_TURNS = 4;

export interface LoopHandoffLeaf {
  id: string;
  state: string;
  text: string;
}

export interface LoopHandoffTurn {
  seq: number;
  stage: string;
  filesChanged: number;
  tools: string[];
}

export interface LoopHandoff {
  goal: string;
  openLedgerLeaves: LoopHandoffLeaf[];
  lastVerify: { status: string; excerpt: string } | null;
  filesTouched: Array<{ path: string; sha256?: string }>;
  decisions: string[];
  lastTurns: LoopHandoffTurn[];
}

export function loopHandoffPath(workspaceCwd: string, loopRunId: string): string {
  return path.join(resolveLoopArtifactPaths(workspaceCwd, loopRunId).dir, LOOP_HANDOFF_FILE);
}

export function validateLoopHandoff(
  handoff: LoopHandoff,
  expectedGoal: string,
  expectedLeafIds: readonly string[],
): boolean {
  if (!handoff.goal || handoff.goal !== expectedGoal) return false;
  const got = new Set(handoff.openLedgerLeaves.map((leaf) => leaf.id));
  return expectedLeafIds.every((id) => got.has(id));
}

export function clipHandoffInjectNote(text: string): string {
  const lines = text.split('\n').slice(0, HANDOFF_INJECT_MAX_LINES).map((line) =>
    line.length > HANDOFF_INJECT_MAX_LINE_CHARS
      ? `${line.slice(0, HANDOFF_INJECT_MAX_LINE_CHARS - 1)}…`
      : line,
  );
  let clipped = lines.join('\n');
  if (clipped.length > HANDOFF_INJECT_MAX_CHARS) {
    clipped = `${clipped.slice(0, HANDOFF_INJECT_MAX_CHARS - 1)}…`;
  }
  return clipped;
}

function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function pairedToolNames(childResult: LoopChildResult): string[] {
  const names = (childResult.toolCalls ?? []).map((call) => call.toolName).filter(Boolean);
  // Never split a tool pair: drop a trailing call when the turn sealed with
  // an unmatched tool_use (no result).
  if (childResult.unresolvedToolCalls && names.length > 0) names.pop();
  return names.slice(0, 12);
}

export async function buildLoopHandoff(input: {
  state: LoopState;
  iteration: LoopIteration;
  childResult: LoopChildResult;
}): Promise<LoopHandoff | null> {
  const goal = input.state.config.initialPrompt.trim();
  if (!goal) return null;
  const tasksPath = resolveLoopArtifactPaths(input.state.config.workspaceCwd, input.state.id).tasks;
  let expectedIds: string[] = [];
  let openLedgerLeaves: LoopHandoffLeaf[] = [];
  try {
    const raw = await fsp.readFile(tasksPath, 'utf8');
    const ledger = parseTaskLedger(raw);
    const open = ledger.items.filter((item) => item.leaf && (item.state === 'todo' || item.state === 'doing'));
    expectedIds = open.map((item) => item.id);
    openLedgerLeaves = open.map((item) => ({
      id: item.id,
      state: item.state,
      text: item.text.slice(0, HANDOFF_INJECT_MAX_LINE_CHARS),
    }));
  } catch {
    // Missing ledger is valid (empty open set).
  }

  const filesTouched: LoopHandoff['filesTouched'] = [];
  const seen = new Set<string>();
  for (const change of input.childResult.filesChanged ?? []) {
    const rel = change.path;
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    filesTouched.push({ path: rel });
  }

  const lastTurns: LoopHandoffTurn[] = [{
    seq: input.iteration.seq,
    stage: input.iteration.stage,
    filesChanged: input.childResult.filesChanged?.length ?? 0,
    tools: pairedToolNames(input.childResult),
  }].slice(0, HANDOFF_KEEP_TURNS);

  const notesPath = resolveLoopArtifactPaths(input.state.config.workspaceCwd, input.state.id).notes;
  let decisions: string[] = [];
  try {
    const notes = await fsp.readFile(notesPath, 'utf8');
    decisions = notes
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-HANDOFF_KEEP_TURNS)
      .map((line) => line.slice(0, HANDOFF_INJECT_MAX_LINE_CHARS));
  } catch {
    decisions = [];
  }

  const lastVerify = input.iteration.verifyStatus === 'not-run'
    ? null
    : {
      status: input.iteration.verifyStatus,
      excerpt: (input.iteration.verifyOutputExcerpt || '').slice(0, 240),
    };

  const handoff: LoopHandoff = {
    goal,
    openLedgerLeaves,
    lastVerify,
    filesTouched,
    decisions,
    lastTurns,
  };
  if (!validateLoopHandoff(handoff, goal, expectedIds)) return null;
  return handoff;
}

export async function writeLoopHandoff(input: {
  state: LoopState;
  iteration: LoopIteration;
  childResult: LoopChildResult;
}): Promise<string | null> {
  const handoff = await buildLoopHandoff(input);
  if (!handoff) return null;
  const dest = loopHandoffPath(input.state.config.workspaceCwd, input.state.id);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
  return dest;
}

export async function loadRehydrationNote(paths: readonly string[]): Promise<string> {
  const pointerSections: string[] = [];
  const inlineBodies: string[] = [];
  let remaining = MAX_REHYDRATE_TOTAL_BYTES;
  for (const filePath of paths) {
    if (remaining <= 0) break;
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const hash = shortHash(raw);
    const pointer = `read \`${filePath}\` sha256:${hash} (${raw.length} bytes)`;
    pointerSections.push(pointer);
    remaining -= pointer.length;
    const base = path.basename(filePath);
    const pointerOnly = base === 'LOOP_TASKS.md' || /\.md$/i.test(base) && /plan/i.test(base);
    if (pointerOnly || remaining <= 0) continue;
    const perFileCap = Math.min(MAX_REHYDRATE_BYTES_PER_FILE, remaining);
    if (perFileCap <= 0) continue;
    const clipped = raw.length > perFileCap ? `${raw.slice(0, perFileCap)}\n… [truncated]` : raw;
    inlineBodies.push(`### ${filePath}\n${clipped}`);
    remaining -= clipped.length;
  }
  const parts = [
    ...pointerSections,
    ...(inlineBodies.length > 0 ? ['', 'Inlined bodies (capped):', ...inlineBodies] : []),
  ];
  return parts.join('\n');
}
