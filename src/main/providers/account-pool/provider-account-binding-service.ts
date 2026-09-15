/**
 * Node-local sign-in health for Claude and Codex account profiles.
 *
 * - Claude: `claude auth status --json` with the profile's `CLAUDE_CONFIG_DIR`
 *   (no network). The reported `configDirectory` must equal the derived home
 *   byte for byte: Claude Code keys the Keychain item on the raw string, so a
 *   drifted path would read a different (or empty) sign-in.
 * - Codex: the profile's `auth.json` exists and its top-level `auth_mode` is
 *   `chatgpt`. Only that one field is picked from a size-bounded read; the
 *   file holds refresh tokens and is never logged, returned or retained.
 *   Identity (email, account id) comes from the short-lived app-server probe,
 *   recorded here via `rememberObservedIdentity`.
 *
 * Never throws for an unreadable profile: `unavailable` blocks a spawn just as
 * firmly. Results are cached for 30 s per (provider, profile, node).
 */

import { execFile } from 'child_process';
import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type {
  AccountBindingState,
  AccountBindingStatus,
  PooledProvider,
  ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import { buildCliSpawnOptions } from '../../cli/cli-environment';
import { resolveAccountProfileHome, type AccountProfileHome } from '../../cli/adapters/account-pool/provider-account-home-resolver';
import { CLAUDE_STRIPPED_AUTH_ENV_VARS } from '../../cli/adapters/adapter-spawn-helpers';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { getLogger } from '../../logging/logger';
import { emitProviderAccountEvent } from './provider-account-events';

const logger = getLogger('ProviderAccountBinding');

export const LOCAL_ACCOUNT_NODE_ID = 'local';
const BINDING_CACHE_TTL_MS = 30_000;
const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 8_000;
export const MAX_CODEX_AUTH_BYTES = 64 * 1024;

export interface ObservedAccountIdentity {
  identity: string;
  accountKey?: string | null;
  planLabel?: string | null;
}

export interface ClaudeAuthStatusResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface ProviderAccountBindingDeps {
  resolveHome?: (params: { provider: PooledProvider; profileId: string }) => AccountProfileHome;
  runClaudeAuthStatus?: (env: NodeJS.ProcessEnv) => Promise<ClaudeAuthStatusResult>;
  readCodexAuthHead?: (home: string) => Promise<string | null>;
  legacyCodexHome?: () => string;
  now?: () => number;
}

interface CacheEntry {
  status: AccountBindingStatus;
  cachedAt: number;
}

function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

function defaultRunClaudeAuthStatus(env: NodeJS.ProcessEnv): Promise<ClaudeAuthStatusResult> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['auth', 'status', '--json'],
      { timeout: CLAUDE_AUTH_STATUS_TIMEOUT_MS, maxBuffer: 256 * 1024, ...buildCliSpawnOptions(env) },
      (error, stdout) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          exitCode: failure ? (typeof failure.code === 'number' ? failure.code : null) : 0,
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          timedOut: Boolean(failure?.killed),
        });
      },
    );
  });
}

async function defaultReadCodexAuthHead(home: string): Promise<string | null> {
  const path = join(home, 'auth.json');
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    if (stats.size > MAX_CODEX_AUTH_BYTES) return '';
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw error;
  }
}

export class ProviderAccountBindingService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AccountBindingStatus>>();
  private readonly observed = new Map<string, ObservedAccountIdentity>();

  constructor(private readonly deps: ProviderAccountBindingDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private key(provider: PooledProvider, profileId: string, nodeId: string): string {
    return `${nodeId}::${provider}::${profileId}`;
  }

  invalidate(provider?: PooledProvider, profileId?: string, nodeId: string = LOCAL_ACCOUNT_NODE_ID): void {
    if (!provider || !profileId) {
      this.cache.clear();
      return;
    }
    this.cache.delete(this.key(provider, profileId, nodeId));
  }

  /** Last cached status, without running a check. */
  getCached(provider: PooledProvider, profileId: string, nodeId: string = LOCAL_ACCOUNT_NODE_ID): AccountBindingStatus | null {
    const entry = this.cache.get(this.key(provider, profileId, nodeId));
    return entry && this.now() - entry.cachedAt < BINDING_CACHE_TTL_MS ? entry.status : null;
  }

  /** Identity observed out-of-band (the Codex app-server probe). Not a secret. */
  rememberObservedIdentity(
    provider: PooledProvider,
    profileId: string,
    identity: ObservedAccountIdentity,
    nodeId: string = LOCAL_ACCOUNT_NODE_ID,
  ): void {
    this.observed.set(this.key(provider, profileId, nodeId), identity);
    this.cache.delete(this.key(provider, profileId, nodeId));
  }

  getObservedIdentity(provider: PooledProvider, profileId: string, nodeId: string = LOCAL_ACCOUNT_NODE_ID): ObservedAccountIdentity | null {
    return this.observed.get(this.key(provider, profileId, nodeId)) ?? null;
  }

  async checkBinding(
    profile: ProviderAccountProfile,
    nodeId: string = LOCAL_ACCOUNT_NODE_ID,
    options: { force?: boolean } = {},
  ): Promise<AccountBindingStatus> {
    const key = this.key(profile.provider, profile.id, nodeId);
    if (!options.force) {
      const cached = this.getCached(profile.provider, profile.id, nodeId);
      if (cached) return cached;
      const pending = this.inFlight.get(key);
      if (pending) return pending;
    }
    const run = this.runCheck(profile, nodeId)
      .then((status) => {
        this.cache.set(key, { status, cachedAt: this.now() });
        emitProviderAccountEvent({
          event: 'account_binding_checked',
          provider: profile.provider,
          profileId: profile.id,
          nodeId,
          state: status.state,
        });
        return status;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private build(
    profile: ProviderAccountProfile,
    nodeId: string,
    state: AccountBindingState,
    extra: Partial<Pick<AccountBindingStatus, 'observedIdentity' | 'observedAccountKey' | 'observedPlan' | 'errorCode'>> = {},
  ): AccountBindingStatus {
    return {
      provider: profile.provider,
      profileId: profile.id,
      nodeId,
      state,
      checkedAt: this.now(),
      ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined && value !== null)),
    };
  }

  private resolveHome(profile: ProviderAccountProfile): AccountProfileHome {
    const resolve = this.deps.resolveHome
      ?? ((params) => resolveAccountProfileHome(params, { createIfMissing: false }));
    return resolve({ provider: profile.provider, profileId: profile.id });
  }

  private async runCheck(profile: ProviderAccountProfile, nodeId: string): Promise<AccountBindingStatus> {
    let home: AccountProfileHome;
    try {
      home = this.resolveHome(profile);
    } catch {
      return this.build(profile, nodeId, 'unavailable', { errorCode: 'home-unresolvable' });
    }
    try {
      return profile.provider === 'claude'
        ? await this.checkClaude(profile, nodeId, home)
        : await this.checkCodex(profile, nodeId, home);
    } catch (error) {
      logger.warn('Account binding check failed', {
        provider: profile.provider,
        profileId: profile.id,
        code: (error as NodeJS.ErrnoException | undefined)?.code,
      });
      return this.build(profile, nodeId, 'unavailable', { errorCode: 'check-failed' });
    }
  }

  private async checkClaude(
    profile: ProviderAccountProfile,
    nodeId: string,
    home: AccountProfileHome,
  ): Promise<AccountBindingStatus> {
    const env: NodeJS.ProcessEnv = { ...getSafeEnvForTrustedProcess() };
    delete env['CLAUDECODE'];
    for (const key of CLAUDE_STRIPPED_AUTH_ENV_VARS) delete env[key];
    if (home.kind === 'derived') env['CLAUDE_CONFIG_DIR'] = home.home;

    const result = await (this.deps.runClaudeAuthStatus ?? defaultRunClaudeAuthStatus)(env);
    if (result.timedOut) {
      return this.build(profile, nodeId, 'unavailable', { errorCode: 'timeout' });
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(result.stdout);
      parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed['loggedIn'] !== 'boolean') {
      return result.exitCode === 1
        ? this.build(profile, nodeId, 'unauthenticated', { errorCode: 'not-logged-in' })
        : this.build(profile, nodeId, 'unavailable', { errorCode: 'unexpected-output' });
    }
    if (home.kind === 'derived' && typeof parsed['configDirectory'] === 'string'
      && parsed['configDirectory'] !== home.home) {
      return this.build(profile, nodeId, 'unavailable', { errorCode: 'config-dir-mismatch' });
    }
    if (parsed['loggedIn'] !== true) {
      return this.build(profile, nodeId, 'unauthenticated', { errorCode: 'not-logged-in' });
    }
    const email = typeof parsed['email'] === 'string' ? parsed['email'].slice(0, 320) : undefined;
    const orgId = typeof parsed['orgId'] === 'string' ? parsed['orgId'].slice(0, 128) : undefined;
    const plan = typeof parsed['subscriptionType'] === 'string' ? parsed['subscriptionType'].slice(0, 64) : undefined;
    const authMethod = typeof parsed['authMethod'] === 'string' ? parsed['authMethod'] : undefined;
    if (home.kind === 'derived' && authMethod !== undefined && authMethod !== 'claude.ai') {
      // A derived profile exists to hold a subscription sign-in; anything else
      // (an API key helper, a cloud provider) is not what the pool assumes.
      return this.build(profile, nodeId, 'unavailable', { errorCode: 'not-subscription-auth', observedPlan: plan });
    }
    const extra = { observedIdentity: email, observedAccountKey: orgId, observedPlan: plan };
    if (profile.expectedIdentity !== null && email && !sameIdentity(email, profile.expectedIdentity)) {
      return this.build(profile, nodeId, 'identity-mismatch', { ...extra, errorCode: 'identity-mismatch' });
    }
    return this.build(profile, nodeId, 'authenticated', extra);
  }

  private async checkCodex(
    profile: ProviderAccountProfile,
    nodeId: string,
    home: AccountProfileHome,
  ): Promise<AccountBindingStatus> {
    const dir = home.kind === 'derived'
      ? home.home
      : (this.deps.legacyCodexHome?.() ?? join(process.env['HOME'] || process.env['USERPROFILE'] || homedir(), '.codex'));
    const raw = await (this.deps.readCodexAuthHead ?? defaultReadCodexAuthHead)(dir);
    if (raw === null) {
      return this.build(profile, nodeId, 'unauthenticated', { errorCode: 'no-auth' });
    }
    let authMode: string | null = null;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const mode = (value as Record<string, unknown>)['auth_mode'];
        authMode = typeof mode === 'string' ? mode.toLowerCase() : null;
      }
    } catch {
      authMode = null;
    }
    if (authMode === null) {
      return this.build(profile, nodeId, 'unavailable', { errorCode: 'auth-unreadable' });
    }
    if (home.kind === 'derived' && !authMode.includes('chatgpt')) {
      return this.build(profile, nodeId, 'unavailable', { errorCode: 'not-chatgpt-auth' });
    }
    const observed = this.getObservedIdentity('codex', profile.id, nodeId);
    const extra = {
      observedIdentity: observed?.identity,
      observedAccountKey: observed?.accountKey ?? undefined,
      observedPlan: observed?.planLabel ?? undefined,
    };
    if (profile.expectedIdentity !== null && observed?.identity && !sameIdentity(observed.identity, profile.expectedIdentity)) {
      return this.build(profile, nodeId, 'identity-mismatch', { ...extra, errorCode: 'identity-mismatch' });
    }
    return this.build(profile, nodeId, 'authenticated', extra);
  }
}

let instance: ProviderAccountBindingService | null = null;

export function getProviderAccountBindingService(): ProviderAccountBindingService {
  if (!instance) {
    instance = new ProviderAccountBindingService();
  }
  return instance;
}

export function _resetProviderAccountBindingServiceForTesting(next?: ProviderAccountBindingService): void {
  instance = next ?? null;
}
