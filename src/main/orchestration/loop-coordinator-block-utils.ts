import { execFile } from 'node:child_process';
import * as path from 'path';
import { promisify } from 'node:util';
import type { LoopTerminalIntentEvidence } from '../../shared/types/loop.types';

const execFileAsync = promisify(execFile);

export interface DegradedIterationChildResult {
  output: string;
  filesChanged: unknown[];
  toolCalls: unknown[];
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
    const { stdout } = await execFileAsync(
      process.execPath,
      ['-e', "process.stdout.write('AIO_PROBE_OK')"],
      {
        cwd: workspaceCwd,
        timeout: timeoutMs,
        // In the packaged app `process.execPath` is the Electron binary, which
        // only behaves as a plain Node interpreter when ELECTRON_RUN_AS_NODE is
        // set. Without it the probe would spuriously fail in production, report
        // the toolchain "dead", and honor exactly the hallucinated blocks this
        // gate exists to override. (Under vitest execPath is already node, so
        // this is a harmless no-op there.)
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
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
): 'invocation-error' | 'void-iteration' | null {
  if (!childResult) {
    return invocationError ? 'invocation-error' : null;
  }
  const noOutput = childResult.output.trim().length === 0;
  const noWork = childResult.filesChanged.length === 0 && childResult.toolCalls.length === 0;
  if (noOutput && noWork) return 'void-iteration';
  return null;
}
