/**
 * Pure helpers for the loop branch-selector invoker.
 *
 * Split out of default-invokers.ts. These run/verify candidate worktrees, commit
 * their changes for merge, gate parent-adapter borrowing, and score candidate
 * diffs list-wise via the LLM. All are stateless module-level functions.
 */
import { spawnSync } from 'child_process';
import type { LoopProvider } from '../../shared/types/loop.types';
import type { BranchCandidate } from './loop-branch-select';
import { buildBranchListwiseScoringRequest } from './loop-branch-task-prompt';

export function branchSelectErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * LF-5 — run a verify command in a candidate worktree dir. Synchronous spawn
 * (bounded by `timeoutMs`); returns true only on a clean exit. Never throws.
 */
export function runVerifyInDir(cmd: string, cwd: string, timeoutMs: number): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  try {
    const result = spawnSync(trimmed, [], {
      cwd,
      shell: true,
      timeout: Math.max(1, timeoutMs),
      env: { ...process.env, CI: '1' },
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * LF-5 — commit a candidate worktree's working-tree changes onto its branch so
 * `mergeWorktree` (which merges branch COMMITS, not the dirty working tree) can
 * adopt them. Loop iterations don't commit, so without this the winner's edits
 * would never reach the workspace. Passes an explicit committer identity so it
 * succeeds even when global git config is absent (headless/CI). No-op when there
 * is nothing to commit; best-effort.
 */
export function commitWorktreeChanges(cwd: string): void {
  try {
    spawnSync('git', ['add', '-A'], { cwd, timeout: 30_000, stdio: 'ignore' });
    spawnSync(
      'git',
      ['-c', 'user.email=loop-branch@local', '-c', 'user.name=Loop Branch-Select', 'commit', '-m', 'loop branch-select candidate', '--no-verify'],
      { cwd, timeout: 30_000, stdio: 'ignore' },
    );
  } catch {
    /* nothing to commit / git unavailable — best-effort */
  }
}

export function canBorrowParentLoopAdapter(loopProvider: LoopProvider, liveProvider: string | undefined): boolean {
  // Claude's CLI session model is safe to borrow for "continue this chat"
  // loops. Codex exec/app-server threads are external rollout ids that can be
  // evicted independently of the visible chat, so Loop Mode should own its own
  // adapter/session instead of inheriting the parent chat's resume cursor.
  return loopProvider === 'claude' && liveProvider === 'claude';
}

export function liveAdapterMatchesRequestedModel(currentModel: unknown, requestedModel: string | undefined): boolean {
  if (!requestedModel || requestedModel === 'default') return true;
  return typeof currentModel === 'string' && currentModel === requestedModel;
}

/**
 * LF-5 — list-wise LLM scoring of candidate diffs (best-effort). Returns a
 * map of candidate id → score (0..1); `{}` on any failure so the caller falls
 * back to the verify+heuristic ranking. Lazy-requires the LLM stack.
 */
export async function scoreCandidatesListwise(
  candidates: readonly BranchCandidate[],
  goal: string,
): Promise<Record<string, number>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLLMService } = require('../rlm/llm-service') as typeof import('../rlm/llm-service');
    const llm = getLLMService();
    if (!(await llm.isAvailable())) return {};
    const { prompt, context } = buildBranchListwiseScoringRequest(candidates, goal);
    // Route branch scoring through the auxiliary service (local/remote-GPU
    // first). `branchScoring` defaults to `allowFrontierFallback:true`, so an
    // unhealthy/disabled aux model preserves today's cloud-first escalation; a
    // terminal failure yields the local-unavailable text whose JSON parse fails
    // → `{}` (heuristic ranking), exactly like today.
    const raw = await llm.subQueryViaAux('branchScoring', {
      requestId: `loop-branch-listwise-${Date.now()}`,
      prompt,
      context,
      depth: 0,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(obj)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = Math.max(0, Math.min(1, value));
    }
    return out;
  } catch {
    return {};
  }
}
