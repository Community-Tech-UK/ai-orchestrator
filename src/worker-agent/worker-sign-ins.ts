/**
 * Which Claude Code and Codex accounts are signed in on this node, for the Computers page.
 *
 * Each installed tool's default sign-in is checked, plus every account profile with a home here, using the same check a
 * routed session meets at spawn time. Display only: that spawn-time check still decides. The heartbeat never waits for
 * it: the reporter takes the last result and a refresh runs in the background, at most every ten minutes, because a
 * Claude check starts `claude auth status` and each check writes a log line.
 */

import type { WorkerNodeSignIn } from '../shared/types/worker-node.types';
import type { AccountBindingStatus, PooledProvider } from '../shared/types/provider-account.types';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../shared/types/provider-account.types';
import {
  WORKER_ACCOUNT_NODE_ID,
  checkWorkerAccountBinding,
  workerAccountProfile,
  type WorkerBindingCheck,
} from './worker-account-route';

export const WORKER_SIGN_IN_CACHE_MS = 10 * 60_000;
/**
 * Longest one account's check may take. Claude's own check gives up at 8 s, but on Windows a timed-out shell may leave
 * the CLI holding the pipe, and a check that never ends would stop every later refresh.
 */
export const WORKER_SIGN_IN_CHECK_LIMIT_MS = 30_000;
const SIGN_IN_PROVIDERS = ['claude', 'codex'] as const satisfies readonly PooledProvider[];

export interface WorkerSignInInput {
  /** The AI tools installed here. A tool that isn't installed is not checked. */
  supportedClis: readonly string[];
  /** Account profiles with a home here, as the reporter lists them. */
  accountProfileIds: Partial<Record<PooledProvider, string[]>>;
}

export interface WorkerSignInDeps {
  checkBinding?: WorkerBindingCheck;
  now?: () => number;
  checkLimitMs?: number;
}

let cache: { expiresAt: number; key: string; value: WorkerNodeSignIn[] } | undefined;
let inFlight: { key: string; run: Promise<WorkerNodeSignIn[]> } | undefined;
/** Counts started checks, so one overtaken by a check of a newer set of accounts can't overwrite its result. */
let generation = 0;

/** The accounts to check, in a stable order: each installed tool's default sign-in, then its profiles. */
function accountsToCheck(input: WorkerSignInInput): { provider: 'claude' | 'codex'; profileId: string }[] {
  return SIGN_IN_PROVIDERS
    .filter(provider => input.supportedClis.includes(provider))
    .flatMap(provider => [LEGACY_ACCOUNT_PROFILE_ID, ...(input.accountProfileIds[provider] ?? [])
      .filter(profileId => profileId !== LEGACY_ACCOUNT_PROFILE_ID)]
      .map(profileId => ({ provider, profileId })));
}

/** The check's answer, or a throw once the limit passes. */
async function withinLimit<T>(check: Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('The sign-in check took too long.')), limitMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([check, limit]);
  } finally {
    clearTimeout(timer);
  }
}

function toSignIn(provider: 'claude' | 'codex', profileId: string, status: AccountBindingStatus): WorkerNodeSignIn {
  // No identity is expected here, so a mismatch can't arise; if it ever did, the account is still signed in.
  const signedIn = status.state === 'authenticated' || status.state === 'identity-mismatch';
  const state = signedIn ? 'signed-in' : status.state === 'unauthenticated' ? 'signed-out' : 'unknown';
  const identity = signedIn && provider === 'claude' ? status.observedIdentity?.slice(0, 320) : undefined;
  return { provider, profileId, state, ...(identity ? { identity } : {}) };
}

/**
 * The last result, or undefined before the first check finishes. Starts a refresh when the result is old or the set
 * of accounts to check has changed, so a newly installed tool or a new profile home shows on the next report.
 */
export function getCachedWorkerSignIns(input: WorkerSignInInput, deps: WorkerSignInDeps = {}): WorkerNodeSignIn[] | undefined {
  const now = deps.now ?? Date.now;
  const key = JSON.stringify(accountsToCheck(input));
  if (!cache || cache.key !== key || cache.expiresAt <= now()) {
    refreshWorkerSignIns(input, deps).catch(() => undefined);
  }
  return cache?.value;
}

/** Check now, unless the result is fresh or a check of the same accounts is already running. */
export function refreshWorkerSignIns(input: WorkerSignInInput, deps: WorkerSignInDeps = {}): Promise<WorkerNodeSignIn[]> {
  const now = deps.now ?? Date.now;
  const check = deps.checkBinding ?? checkWorkerAccountBinding;
  const accounts = accountsToCheck(input);
  const key = JSON.stringify(accounts);
  if (cache && cache.key === key && cache.expiresAt > now()) return Promise.resolve(cache.value);
  if (inFlight?.key === key) return inFlight.run;
  // One at a time: a check can start a CLI process, and this machine is doing other work.
  const started = ++generation;
  const run = (async () => {
    const value: WorkerNodeSignIn[] = [];
    for (const { provider, profileId } of accounts) {
      let status: AccountBindingStatus;
      try {
        status = await withinLimit(
          check(workerAccountProfile(provider, profileId, null), WORKER_ACCOUNT_NODE_ID),
          deps.checkLimitMs ?? WORKER_SIGN_IN_CHECK_LIMIT_MS,
        );
      } catch {
        value.push({ provider, profileId, state: 'unknown' });
        continue;
      }
      value.push(toSignIn(provider, profileId, status));
    }
    if (started === generation) cache = { expiresAt: now() + WORKER_SIGN_IN_CACHE_MS, key, value };
    return value;
  })().finally(() => {
    if (inFlight?.run === run) inFlight = undefined;
  });
  inFlight = { key, run };
  return run;
}

export function resetWorkerSignInsForTesting(): void {
  cache = undefined;
  inFlight = undefined;
}
