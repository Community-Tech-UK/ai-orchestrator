/**
 * Node-local Copilot account binding verification.
 *
 * Reads bounded identity metadata out of one profile's own Copilot
 * `config.json` and reports whether that profile is authenticated as the
 * identity AIO expects. This is a security control, not an audit nicety:
 *
 * Copilot CLI stores account tokens in the OS keychain under service
 * `copilot-cli`, keyed by `${host}:${login}` — NOT by `COPILOT_HOME`. Separate
 * profile homes therefore share one keychain namespace, and isolation works
 * only because each home's `config.json` names a different `lastLoggedInUser`.
 * The CLI's `getAnyToken()` fallback calls `findPassword('copilot-cli')`, which
 * returns an *arbitrary* stored account's token. A profile home with a missing
 * or corrupt `lastLoggedInUser` can therefore authenticate as the wrong
 * account, so verification runs before every spawn and fails closed.
 *
 * The config file may contain PLAINTEXT tokens (`copilotTokens`, written when
 * the keychain is unavailable or the profile opts into `storeTokenPlaintext`),
 * so the parsed object is never returned, retained, or logged — only
 * field-picked `{host, login}` pairs leave this module.
 */

import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import type {
  CopilotAccountBindingStatus,
  CopilotAccountProfile,
} from '../../../shared/types/copilot-account.types';
import { normalizeCopilotHost } from '../../../shared/types/copilot-account.types';
import { resolveCopilotProfileHome } from '../../cli/adapters/copilot/copilot-account-home-resolver';
import { getLogger } from '../../logging/logger';

const logger = getLogger('CopilotAccountBinding');

/** The canonical identity of the controller's own execution node. */
export const LOCAL_COPILOT_NODE_ID = 'local';

/** Refuse to parse an oversized config rather than buffering it. */
export const MAX_COPILOT_CONFIG_BYTES = 1024 * 1024;

/** Cache TTL. Short: a binding can change the moment the user signs in. */
const BINDING_CACHE_TTL_MS = 30_000;

/**
 * Field-picking schema. `.passthrough()` is deliberately NOT used — anything
 * outside these keys (notably `copilotTokens`) is dropped by the parse, so the
 * value this module holds cannot carry token material even by accident.
 */
const identitySchema = z
  .object({
    host: z.string().min(1).max(253).optional(),
    login: z.string().min(1).max(64).optional(),
  })
  .transform((value) => ({ host: value.host, login: value.login }));

const copilotConfigIdentitySchema = z.object({
  lastLoggedInUser: identitySchema.optional().catch(undefined),
  loggedInUsers: z.array(identitySchema).max(64).optional().catch(undefined),
});

const copilotSettingsSchema = z.object({
  storeTokenPlaintext: z.boolean().optional().catch(undefined),
});

interface ObservedIdentity {
  host?: string;
  login?: string;
}

interface CacheEntry {
  status: CopilotAccountBindingStatus;
  configMtimeMs: number | null;
  cachedAt: number;
}

/**
 * Strip JSONC-style full-line comments. Anchored to start-of-line (after
 * optional whitespace) so quoted URL values keep their slashes — same narrow
 * strip as `copilot-quota-probe.ts`, which reads the same file format.
 */
function stripLineComments(input: string): string {
  return input.replace(/^[ \t]*\/\/.*$/gm, '');
}

function sameIdentity(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) {
    return false;
  }
  // The CLI compares login/host with plain equality; GitHub logins and hosts
  // are case-insensitive, so fold before comparing or a re-login that differs
  // only in case would read as a mismatch.
  return a.toLowerCase() === b.toLowerCase();
}

export class CopilotAccountBindingService {
  private readonly cache = new Map<string, CacheEntry>();

  /** Test seam. Production reads the real profile home. */
  constructor(
    private readonly deps: {
      resolveHome?: (profile: CopilotAccountProfile) => string;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private homeFor(profile: CopilotAccountProfile): string {
    if (this.deps.resolveHome) {
      return this.deps.resolveHome(profile);
    }
    return resolveCopilotProfileHome(profile.id, {
      isLegacy: profile.isLegacy,
      createIfMissing: false,
    });
  }

  private cacheKey(profileId: string, nodeId: string): string {
    return `${nodeId}::${profileId}`;
  }

  /** Drop cached health for one profile, or all profiles when omitted. */
  invalidate(profileId?: string, nodeId: string = LOCAL_COPILOT_NODE_ID): void {
    if (!profileId) {
      this.cache.clear();
      return;
    }
    this.cache.delete(this.cacheKey(profileId, nodeId));
  }

  /**
   * Verify that `profile` is signed in on this node as the identity AIO
   * expects. Never throws for an unreadable profile — an unreadable profile is
   * `unavailable`, which blocks the spawn just as firmly.
   */
  async checkBinding(
    profile: CopilotAccountProfile,
    nodeId: string = LOCAL_COPILOT_NODE_ID,
  ): Promise<CopilotAccountBindingStatus> {
    const key = this.cacheKey(profile.id, nodeId);
    const configPath = (() => {
      try {
        return join(this.homeFor(profile), 'config.json');
      } catch (error) {
        logger.warn('Could not derive a Copilot profile home', {
          profileId: profile.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (!configPath) {
      const status = this.build(profile, nodeId, 'unavailable', {}, 'home-unresolvable');
      this.cache.set(key, { status, configMtimeMs: null, cachedAt: this.now() });
      return status;
    }

    let configMtimeMs: number | null = null;
    let sizeBytes: number | null = null;
    try {
      const stats = await stat(configPath);
      configMtimeMs = stats.mtimeMs;
      sizeBytes = stats.size;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'ENOENT') {
        const status = this.build(profile, nodeId, 'unauthenticated', {}, 'no-config');
        this.cache.set(key, { status, configMtimeMs: null, cachedAt: this.now() });
        return status;
      }
      const status = this.build(profile, nodeId, 'unavailable', {}, code ?? 'stat-failed');
      this.cache.set(key, { status, configMtimeMs: null, cachedAt: this.now() });
      return status;
    }

    // Cache is keyed by (profileId, nodeId, configMtimeMs): a re-login rewrites
    // config.json, so a changed mtime always forces a fresh read even inside
    // the TTL.
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.configMtimeMs === configMtimeMs &&
      this.now() - cached.cachedAt < BINDING_CACHE_TTL_MS
    ) {
      return cached.status;
    }

    if (sizeBytes !== null && sizeBytes > MAX_COPILOT_CONFIG_BYTES) {
      const status = this.build(profile, nodeId, 'unavailable', {}, 'config-too-large');
      this.cache.set(key, { status, configMtimeMs, cachedAt: this.now() });
      return status;
    }

    let observed: ObservedIdentity | null;
    try {
      observed = await this.readIdentity(configPath);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const status = this.build(profile, nodeId, 'unavailable', {}, code ?? 'config-unreadable');
      this.cache.set(key, { status, configMtimeMs, cachedAt: this.now() });
      return status;
    }

    const storesTokenPlaintext = await this.readStoresTokenPlaintext(configPath);

    if (!observed || (!observed.login && !observed.host)) {
      const status = this.build(
        profile,
        nodeId,
        'unauthenticated',
        {},
        'no-logged-in-user',
        storesTokenPlaintext,
      );
      this.cache.set(key, { status, configMtimeMs, cachedAt: this.now() });
      return status;
    }

    const hostMatches = sameIdentity(observed.host, normalizeCopilotHost(profile.host));
    // `expectedLogin === null` means "not yet verified" — the first verified
    // login adopts the observed identity, so a null expectation is not a
    // mismatch. Every later difference is.
    const loginMatches =
      profile.expectedLogin === null || sameIdentity(observed.login, profile.expectedLogin);

    const state = hostMatches && loginMatches ? 'authenticated' : 'identity-mismatch';
    const status = this.build(
      profile,
      nodeId,
      state,
      observed,
      state === 'identity-mismatch'
        ? hostMatches
          ? 'login-mismatch'
          : 'host-mismatch'
        : undefined,
      storesTokenPlaintext,
    );
    this.cache.set(key, { status, configMtimeMs, cachedAt: this.now() });
    return status;
  }

  private async readIdentity(configPath: string): Promise<ObservedIdentity | null> {
    const raw = await readFile(configPath, 'utf8');
    if (raw.length > MAX_COPILOT_CONFIG_BYTES) {
      throw Object.assign(new Error('Copilot config exceeded the size bound'), {
        code: 'config-too-large',
      });
    }
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(stripLineComments(raw)) as unknown;
    } catch {
      // Deliberately no file content in the message — this file can hold a
      // plaintext token, so even a parse-error excerpt is unsafe to log.
      throw Object.assign(new Error('Copilot config is not valid JSON'), {
        code: 'config-unparseable',
      });
    }
    const result = copilotConfigIdentitySchema.safeParse(parsedUnknown);
    if (!result.success) {
      return null;
    }
    // The CLI writes `host` WITH a scheme (`https://github.com`); rules and git
    // remotes use a bare hostname. Normalize on the way out so every comparison
    // downstream is like-for-like.
    const last = result.data.lastLoggedInUser;
    if (last?.login || last?.host) {
      return { host: normalizeCopilotHost(last.host), login: last.login };
    }
    const first = result.data.loggedInUsers?.find((user) => user.login || user.host);
    return first ? { host: normalizeCopilotHost(first.host), login: first.login } : null;
  }

  /**
   * Whether the profile opts into plaintext token storage. Reported by Doctor
   * as a warning; the token itself is never read.
   */
  private async readStoresTokenPlaintext(configPath: string): Promise<boolean | undefined> {
    const settingsPath = join(configPath, '..', 'settings.json');
    try {
      const stats = await stat(settingsPath);
      if (stats.size > MAX_COPILOT_CONFIG_BYTES) {
        return undefined;
      }
      const raw = await readFile(settingsPath, 'utf8');
      const parsed = copilotSettingsSchema.safeParse(JSON.parse(stripLineComments(raw)) as unknown);
      return parsed.success ? parsed.data.storeTokenPlaintext : undefined;
    } catch {
      return undefined;
    }
  }

  private build(
    profile: CopilotAccountProfile,
    nodeId: string,
    state: CopilotAccountBindingStatus['state'],
    observed: ObservedIdentity,
    errorCode?: string,
    storesTokenPlaintext?: boolean,
  ): CopilotAccountBindingStatus {
    return {
      profileId: profile.id,
      nodeId,
      state,
      ...(observed.login ? { observedLogin: observed.login } : {}),
      ...(observed.host ? { observedHost: observed.host } : {}),
      checkedAt: this.now(),
      ...(errorCode ? { errorCode } : {}),
      ...(storesTokenPlaintext !== undefined ? { storesTokenPlaintext } : {}),
    };
  }
}

let instance: CopilotAccountBindingService | null = null;

export function getCopilotAccountBindingService(): CopilotAccountBindingService {
  if (!instance) {
    instance = new CopilotAccountBindingService();
  }
  return instance;
}

export function _resetForTesting(): void {
  instance = null;
}
