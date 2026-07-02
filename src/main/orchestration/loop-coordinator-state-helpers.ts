import * as path from 'path';
import { createHash } from 'crypto';
import type {
  LoopConfig,
  LoopPreflightResult,
  LoopState,
  LoopTerminalIntent,
  ProgressSignalEvidence,
} from '../../shared/types/loop.types';
import type { LongRunResourceDecision } from '../runtime/long-run-resource-governor';
import {
  coercePendingInput,
  createLoopPendingInput,
  defaultLoopConfig,
  LOOP_MAX_PLAN_REGENERATIONS,
} from '../../shared/types/loop.types';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { LOOP_TEXT_FILE_MAX_BYTES, readUtf8FileHead, readUtf8FileHeadSync } from './bounded-file-read';
import { parseOutstandingSections } from './loop-stage-markdown';

function normalizeLoopCaps(
  base: LoopConfig['caps'],
  patch: Partial<LoopConfig['caps']> | undefined,
): LoopConfig['caps'] {
  const merged = { ...base, ...(patch ?? {}) };
  const maxTokens = merged.maxTokens == null
    ? null
    : Math.max(1, Math.floor(merged.maxTokens));
  return {
    ...merged,
    maxTokens,
    maxWallTimeMs: Math.max(1, Math.floor(merged.maxWallTimeMs)),
    maxToolCallsPerIteration: Math.max(1, Math.floor(merged.maxToolCallsPerIteration)),
  };
}

export function materializeLoopConfig(
  p: Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string },
): LoopConfig {
  const base = defaultLoopConfig(p.workspaceCwd, p.initialPrompt);
  if (p.planFile && p.completion?.requireCompletedFileRename === undefined) {
    base.completion.requireCompletedFileRename = true;
  }
  return {
    ...base,
    ...p,
    caps: normalizeLoopCaps(base.caps, p.caps),
    progressThresholds: {
      ...base.progressThresholds,
      ...(p.progressThresholds ?? {}),
      stageWarnIterations: { ...base.progressThresholds.stageWarnIterations, ...(p.progressThresholds?.stageWarnIterations ?? {}) },
      stageCriticalIterations: { ...base.progressThresholds.stageCriticalIterations, ...(p.progressThresholds?.stageCriticalIterations ?? {}) },
    },
    completion: { ...base.completion, ...(p.completion ?? {}) },
    audit: { ...base.audit, ...(p.audit ?? {}) },
  };
}

/**
 * D2 (#6, prompt-only interim): the directive injected into the ONE final
 * wrap-up iteration a capped loop runs before terminating. Strong instruction
 * only — tools are NOT API-disabled (that variant needs per-provider adapter
 * plumbing and is deferred), so this is best-effort by design.
 */
export function buildCapWrapUpDirective(
  cap: 'iterations' | 'wall-time' | 'tokens' | 'cost',
  reason: string,
): string {
  return (
    `FINAL ITERATION — the loop's ${cap} cap has been reached (${reason}). ` +
    `This is a wrap-up turn, not a work turn. Do NOT start new work, do NOT ` +
    `begin new edits, and do NOT run long commands. Produce a structured ` +
    `hand-off: (1) work completed this run, (2) work remaining (each item ` +
    `with enough detail to resume), (3) the exact next step you would have ` +
    `taken, and (4) current verify/build status as last observed. Update ` +
    `LOOP_TASKS.md and NOTES.md to match, then stop.`
  );
}

export function checkLoopHardCaps(state: LoopState): null | 'iterations' | 'wall-time' | 'tokens' | 'cost' {
  const caps = state.config.caps;
  if (caps.maxIterations !== null && state.totalIterations >= caps.maxIterations) return 'iterations';
  if (Date.now() - state.startedAt >= caps.maxWallTimeMs) return 'wall-time';
  if (caps.maxTokens !== null && state.totalTokens >= caps.maxTokens) return 'tokens';
  if (caps.maxCostCents !== null && state.totalCostCents >= caps.maxCostCents) return 'cost';
  return null;
}

export function describeLoopCapReason(
  state: LoopState,
  cap: 'iterations' | 'wall-time' | 'tokens' | 'cost',
  convergenceNote: string | undefined,
): string {
  const parts = [`cap=${cap}`, `after ${state.totalIterations} iteration(s)`];
  if (convergenceNote) {
    parts.push(`stopped while ${convergenceNote}`);
  } else {
    const verify = state.lastIteration?.verifyStatus;
    if (verify === 'failed') {
      parts.push('stopped while the last verify was FAILING');
    } else if (verify === 'passed') {
      parts.push('last verify passed but no clean completion was accepted');
    } else {
      parts.push('no completion was attempted (agent never reached a verifiable done state)');
    }
  }
  return parts.join('; ');
}

export function cloneLoopStateForBroadcast(s: LoopState): LoopState {
  const config = { ...s.config };
  delete (config as { nextObjectivePlanner?: unknown }).nextObjectivePlanner;
  return {
    ...s,
    config,
    pendingInterventions: s.pendingInterventions.map((item) => ({ ...coercePendingInput(item) })),
    recentWarnIterationSeqs: [...s.recentWarnIterationSeqs],
    completionAttempts: s.completionAttempts,
    contextWindowCalibration: s.contextWindowCalibration ? { ...s.contextWindowCalibration } : undefined,
    loopControl: s.loopControl ? { ...s.loopControl } : undefined,
    inFlightIteration: s.inFlightIteration ? { ...s.inFlightIteration } : undefined,
    terminalIntentPending: s.terminalIntentPending
      ? { ...s.terminalIntentPending, evidence: s.terminalIntentPending.evidence.map((item) => ({ ...item })) }
      : undefined,
    terminalIntentHistory: (s.terminalIntentHistory ?? []).map((intent) => ({
      ...intent,
      evidence: intent.evidence.map((item) => ({ ...item })),
    })),
  };
}

export function rememberLoopTerminalIntent(state: LoopState, intent: LoopTerminalIntent): void {
  const history = state.terminalIntentHistory ?? [];
  const existingIndex = history.findIndex((item) => item.id === intent.id);
  if (existingIndex >= 0) {
    history[existingIndex] = intent;
  } else {
    history.push(intent);
  }
  state.terminalIntentHistory = history;
}

export function syntheticChildResultFromTerminalIntent(
  intent: LoopTerminalIntent,
  invocationError: string | null,
): {
  childInstanceId: null;
  output: string;
  tokens: number;
  filesChanged: [];
  toolCalls: [];
  errors: { bucket: string; exactHash: string; excerpt: string }[];
  testPassCount: null;
  testFailCount: null;
  exitedCleanly: false;
} {
  const output = [
    `Loop-control ${intent.kind} intent recorded: ${intent.summary}`,
    invocationError ? `Provider invocation also failed: ${invocationError}` : '',
  ].filter(Boolean).join('\n');
  return {
    childInstanceId: null,
    output,
    tokens: 0,
    filesChanged: [],
    toolCalls: [],
    errors: invocationError
      ? [{ bucket: 'provider-invocation-error', exactHash: createHash('sha256').update(invocationError).digest('hex'), excerpt: invocationError }]
      : [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: false,
  };
}

export function canRegenerateLoopPlanOnStall(state: LoopState, done: number): boolean {
  if (!state.config.plan?.regenerateOnStall) return false;
  return done < LOOP_MAX_PLAN_REGENERATIONS;
}

export function applyLoopPlanRegenerationOnStall(params: {
  state: LoopState;
  seq: number;
  done: number;
  emit: (eventName: string, payload: unknown) => boolean;
}): boolean {
  if (!params.state.config.plan?.regenerateOnStall) return false;
  if (params.done >= LOOP_MAX_PLAN_REGENERATIONS) return false;
  params.state.recentWarnIterationSeqs = [];
  params.state.pendingInterventions.push(
    createLoopPendingInput(
      'The current plan/approach is STALLING (repeated no-progress). Treat the plan as ' +
      'disposable: throw it out and regenerate it from the goal. Re-derive the task list in ' +
      '`LOOP_TASKS.md` from scratch, pick a DIFFERENT approach for the stuck part, and proceed. ' +
      `(disposable-plan regeneration ${params.done + 1}/${LOOP_MAX_PLAN_REGENERATIONS})`,
      { source: 'plan-regen' },
    ),
  );
  params.emit('loop:plan-regenerated', {
    loopRunId: params.state.id,
    seq: params.seq,
    attempt: params.done + 1,
    max: LOOP_MAX_PLAN_REGENERATIONS,
  });
  return true;
}

function blockedFileCandidates(state: LoopState): string[] {
  const scoped = resolveLoopArtifactPaths(state.config.workspaceCwd, state.id).blocked;
  // When isolation is active, skip the root BLOCKED.md fallback: a stale or
  // concurrent root file from another run would pause the wrong loop.
  if (state.config.isolateLoopWorkspaces) {
    return [scoped];
  }
  return [scoped, path.join(state.config.workspaceCwd, 'BLOCKED.md')];
}

export async function firstExistingBlockedFile(state: LoopState): Promise<string | null> {
  const fs = await import('node:fs/promises');
  for (const candidate of blockedFileCandidates(state)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export async function readBlockedFileIfPresent(state: LoopState): Promise<{ message: string } | null> {
  const target = await firstExistingBlockedFile(state);
  if (!target) return null;
  try {
    const trimmed = (await readUtf8FileHead(target, 8 * 1024)).text.trim();
    if (!trimmed) return null;
    const message = trimmed.length > 4096 ? `${trimmed.slice(0, 4096)}\n…(truncated)` : trimmed;
    return { message };
  } catch {
    return null;
  }
}

export async function moveBlockedFileAside(params: {
  state: LoopState;
  loopControlDir?: string;
  warn: (details: { errorCode: string | null; error: string }) => void;
}): Promise<void> {
  const fs = await import('node:fs/promises');
  const blockedPath = await firstExistingBlockedFile(params.state);
  if (!blockedPath) return;
  const preferredTarget = params.loopControlDir
    ? path.join(params.loopControlDir, `blocked-overridden-${params.state.totalIterations}.md`)
    : path.join(params.state.config.workspaceCwd, 'BLOCKED.overridden.md');

  try {
    await fs.rename(blockedPath, preferredTarget);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return;
    if (!params.loopControlDir) {
      params.warn({ errorCode: code ?? null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  try {
    await fs.rename(blockedPath, path.join(params.state.config.workspaceCwd, 'BLOCKED.overridden.md'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return;
    params.warn({ errorCode: code ?? null, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function archiveBlockedFileForIntent(params: {
  state: LoopState;
  intent: LoopTerminalIntent;
  loopControlDir?: string;
  debugAbsent: () => void;
  warn: (details: { errorCode: string | null; error: string }) => void;
  emitArchiveFailure: (failure: string) => void;
}): Promise<void> {
  if (!params.loopControlDir) return;
  const fs = await import('node:fs/promises');
  const blockedPath = await firstExistingBlockedFile(params.state);
  if (!blockedPath) return;
  const target = path.join(params.loopControlDir, `blocked-handled-${params.intent.iterationSeq}.md`);
  try {
    await fs.rename(blockedPath, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      params.debugAbsent();
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    params.warn({ errorCode: code ?? null, error: reason });
    params.emitArchiveFailure(
      `block intent recorded but BLOCKED.md could not be archived (${code ?? 'unknown'}): ${reason}. The next iteration will re-pause on the residual file until you resolve it manually.`,
    );
  }
}

export function captureLoopOutstanding(state: LoopState): void {
  try {
    const paths = resolveLoopArtifactPaths(state.config.workspaceCwd, state.id);
    const raw = readUtf8FileHeadSync(paths.outstanding, LOOP_TEXT_FILE_MAX_BYTES).text;
    const { needsHuman, openQuestions } = parseOutstandingSections(raw);
    if (needsHuman.length === 0 && openQuestions.length === 0) return;
    state.outstanding = {
      needsHuman,
      openQuestions,
      raw,
      capturedAt: Date.now(),
    };
  } catch {
    // Missing or unreadable OUTSTANDING.md should never block loop termination.
  }
}

export function resourceGovernorPauseSignal(
  reason: string,
  decision: LongRunResourceDecision,
): ProgressSignalEvidence {
  return {
    id: 'BLOCKED',
    verdict: 'CRITICAL',
    message: reason,
    detail: { reason: 'resource-governor', decision },
  };
}

export function preflightBlockedSignal(
  reason: string,
  preflight: LoopPreflightResult,
): ProgressSignalEvidence {
  return {
    id: 'BLOCKED',
    verdict: 'CRITICAL',
    message: reason,
    detail: { preflight },
  };
}
