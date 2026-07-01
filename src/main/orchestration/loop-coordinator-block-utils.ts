import { execFile } from 'node:child_process';
import * as path from 'path';
import { promisify } from 'node:util';
import {
  coercePendingInput,
  createLoopPendingInput,
  type LoopPendingInput,
  type LoopTerminalIntentEvidence,
} from '../../shared/types/loop.types';
import type { DegradedReason } from '../cli/adapters/degraded-output-classifier';
import { evaluatePostCompactionCanary } from './loop-context-survival';

const execFileAsync = promisify(execFile);

/**
 * Pi Task 18: split a pending-input queue by drain timing. `follow-up` hints are
 * held back for the completion seam; everything else (`queue`/`steer`) drains
 * into the current prompt. See `LoopPendingInputKind`.
 */
export function partitionPendingByDrainTiming(
  pending: readonly (string | LoopPendingInput)[],
): { drainNow: LoopPendingInput[]; deferredFollowUps: LoopPendingInput[] } {
  const coerced = pending.map(coercePendingInput);
  return {
    drainNow: coerced.filter((i) => i.kind !== 'follow-up'),
    deferredFollowUps: coerced.filter((i) => i.kind === 'follow-up'),
  };
}

/**
 * Pi Task 18: when the loop would complete, convert queued `follow-up` messages
 * into next-iteration hints so they run "before you finish."
 *
 * Drain policy (per-message `drainMode`, FIFO): messages drain from the front
 * until — and including — the first `one-at-a-time` message, at which point the
 * remaining follow-ups stay deferred for the NEXT completion seam. With the
 * default `all` mode (no one-at-a-time), the whole batch drains at once.
 *
 * Returns the re-queued list (drained→`queue`, remaining kept as `follow-up`),
 * how many drained, and how many remain; or null when there are no follow-ups.
 */
export function drainFollowUpsForCompletion(
  pending: readonly (string | LoopPendingInput)[],
): { requeued: LoopPendingInput[]; followUpCount: number; remainingFollowUps: number } | null {
  const coerced = pending.map(coercePendingInput);
  const nonFollowUps = coerced.filter((i) => i.kind !== 'follow-up');
  const followUps = coerced.filter((i) => i.kind === 'follow-up');
  if (followUps.length === 0) return null;

  let cut = followUps.length;
  for (let i = 0; i < followUps.length; i++) {
    if (followUps[i].drainMode === 'one-at-a-time') {
      cut = i + 1; // drain this one, defer the rest
      break;
    }
  }
  const toDrain = followUps.slice(0, cut);
  const remaining = followUps.slice(cut);
  const requeued = nonFollowUps
    .concat(toDrain.map((f) => createLoopPendingInput(f.message, { kind: 'queue', source: f.source })))
    .concat(remaining);
  return { requeued, followUpCount: toDrain.length, remainingFollowUps: remaining.length };
}

/**
 * B5: run the post-compaction health canary. If the prior iteration reset the
 * context and this turn came back void, probe the workspace; return pause details
 * when the executor/workspace is genuinely unresponsive, else null (defer to
 * normal no-progress handling). See `evaluatePostCompactionCanary`.
 */
export async function evaluatePostCompactionCanaryPause(params: {
  postCompaction: { seq: number; reason: string } | undefined;
  childResultVoid: boolean;
  workspaceCwd: string;
  probeTimeoutMs: number;
}): Promise<{ reason: string; probeDetail: string; compactedAtSeq: number } | null> {
  if (!params.postCompaction || !params.childResultVoid) return null;
  const probe = await runWorkspaceLivenessProbe(params.workspaceCwd, params.probeTimeoutMs)
    .catch((err) => ({ alive: false, detail: `liveness probe threw: ${err instanceof Error ? err.message : String(err)}` }));
  const canary = evaluatePostCompactionCanary({ iterationVoid: true, workspaceAlive: probe.alive });
  if (!canary.failed) return null;
  return {
    reason: `post-compaction canary failed (compacted at seq ${params.postCompaction.seq}: ${params.postCompaction.reason}): ${canary.reason}`,
    probeDetail: probe.detail,
    compactedAtSeq: params.postCompaction.seq,
  };
}

export interface DegradedIterationChildResult {
  output: string;
  filesChanged: unknown[];
  toolCalls: unknown[];
  /** A3: adapter-layer degraded classification, when the feature flag was on. */
  degradedReason?: DegradedReason;
}

export function getBlockOverrideInterventionText(): string {
  // Follow-up (out of scope here): adapter-layer empty/batched tool-output
  // detection + retry belongs in the CLI adapter path, not coordinator logic.
  // Tracked: docs/plans/2026-05-30-loop-adapter-degraded-output-detection.md
  return (
    'Your block intent was NOT honored. A workspace liveness probe just confirmed the ' +
    'toolchain is responsive (shell + file reads work). Your earlier "tooling is dead / ' +
    'empty output" reading was almost certainly delayed/batched tool output or a stale/synthetic ' +
    'read — NOT a real outage. Re-establish ground truth with SINGLE, exit-0 commands (no chained ' +
    'commands, no parallel batches — one failed command can cancel a whole batch). Do not trust any ' +
    'earlier file read; re-read fresh before concluding anything is missing or broken. Then continue the task.'
  );
}

export function isToolchainClassBlock(summary: string, evidence: LoopTerminalIntentEvidence[]): boolean {
  if (evidence.length === 0) return true;

  // Heuristics for "tooling/harness/environment looks broken" narratives.
  const patterns: readonly RegExp[] = [
    /\btoolchain\b/i,
    /\btool(?:s|ing)?\b.*\b(?:non-?responsive|unresponsive|dead|not\s+working|return(?:ing)?\s+empty|empty\s+output)\b/i,
    /\bcannot\s+(?:read|run|write|access)\b/i,
    /\bharness\b/i,
    /\bdegraded\b/i,
    /\bsynthetic\b/i,
    /\bhallucinat\w*\b/i,
    /\bbash\b.*\bempty\b/i,
    /\b(?:read|write|tool)\b.*\b(?:empty|returned\s+nothing|no\s+output)\b/i,
  ];
  return patterns.some((pattern) => pattern.test(summary));
}

export async function runWorkspaceLivenessProbe(
  workspaceCwd: string,
  timeoutMs: number,
): Promise<{ alive: boolean; detail: string }> {
  const details: string[] = [];
  let execOk = false;
  let fsOk = false;

  try {
    // The probe answers "can this workspace exec a child process at all", so
    // it must NOT spawn `process.execPath`: in the packaged app that is the
    // Electron binary, and with the RunAsNode fuse disabled (see
    // scripts/set-electron-fuses.js) ELECTRON_RUN_AS_NODE is silently ignored
    // - the spawn boots a full second Electron app instead of a Node
    // interpreter (2026-06 helper crash storm). A platform echo binary tests
    // exec capability without depending on fuse state.
    const probe =
      process.platform === 'win32'
        ? { file: process.env['comspec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', 'echo AIO_PROBE_OK'] }
        : { file: '/bin/echo', args: ['AIO_PROBE_OK'] };
    const { stdout } = await execFileAsync(probe.file, probe.args, {
      cwd: workspaceCwd,
      timeout: timeoutMs,
    });
    execOk = stdout.includes('AIO_PROBE_OK');
    details.push(execOk ? 'exec=ok' : 'exec=unexpected-output');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    details.push(`exec=fail:${reason}`);
  }

  try {
    const fs = await import('node:fs/promises');
    const packageJsonPath = path.join(workspaceCwd, 'package.json');
    try {
      await fs.readFile(packageJsonPath, 'utf8');
      fsOk = true;
      details.push('fs=read:package.json');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        const entries = await fs.readdir(workspaceCwd);
        fsOk = entries.length > 0;
        details.push(fsOk ? `fs=readdir:${entries.length}` : 'fs=readdir:empty');
      } else {
        throw err;
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    details.push(`fs=fail:${reason}`);
  }

  return { alive: execOk && fsOk, detail: details.join('; ') };
}

/**
 * True when an iteration invocation error is a circuit-breaker rejection
 * (`Circuit breaker '<name>' is OPEN`, thrown by CircuitBreaker.execute when the
 * circuit is open). This is a *transient, self-healing* condition — the breaker
 * reopens to HALF_OPEN after its reset window — so the loop must back off and
 * retry rather than treat it as a degraded iteration or a fatal error. Matching
 * is on the stable message shape emitted by `core/circuit-breaker.ts`.
 */
export function isCircuitBreakerOpenError(invocationError: string | null | undefined): boolean {
  if (!invocationError) return false;
  return /circuit breaker\b.*\bis open\b/i.test(invocationError);
}

export function classifyDegradedIteration(
  childResult: DegradedIterationChildResult | null,
  invocationError: string | null,
): 'invocation-error' | 'void-iteration' | 'adapter-degraded' | null {
  if (!childResult) {
    return invocationError ? 'invocation-error' : null;
  }
  // A3: adapter-layer degraded classification takes priority over the void check
  // so the retry loop knows the root cause. Only fires when the feature flag was
  // on during the iteration; all DegradedReason values warrant a fresh-session retry.
  if (childResult.degradedReason) {
    return 'adapter-degraded';
  }
  const noOutput = childResult.output.trim().length === 0;
  const noWork = childResult.filesChanged.length === 0 && childResult.toolCalls.length === 0;
  if (noOutput && noWork) return 'void-iteration';
  return null;
}
