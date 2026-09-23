import { credentialScopeForProfile, existingTabGrantNodeId } from './browser-grant-scope';
import type { SessionFingerprint } from './browser-session-sentinel';

/**
 * Login fingerprints and re-login recipes for `browser.check_session`.
 *
 * Keyed by the same stable scope as credential authorizations
 * (`credentialScopeForProfile`): the managed profileId, or the node scope for
 * a shared existing tab. That is what lets a recipe recorded on one In-tend tab
 * reach the next tab on the same computer, and the SQLite record store is what
 * lets it survive a restart (migration 065).
 *
 * A recipe holds a vault item REFERENCE and selectors. Never a secret: the
 * secret is resolved in-process at fill time and jailed to the live origin.
 */

export interface LoginReloginDetails {
  /** Vault item to re-login with (a reference, never a secret). */
  vaultItemRef: string;
  usernameSelector?: string;
  passwordSelector: string;
  submitSelector?: string;
  /** Second-factor input, filled on a second pass when configured. */
  codeSelector?: string;
  codeKind?: 'totp' | 'email_code';
}

export type LoginRecipeScopeKind = 'profile' | 'node';

/** What the most recent `check_session` against this recipe concluded. */
export type LoginRecipeOutcome =
  | 'logged_in'
  | 'relogged_in'
  | 'relogin_failed'
  | 'observation_blocked'
  | 'no_relogin_recipe'
  | 'unknown';

export interface LoginRecipe {
  scope: string;
  scopeKind: LoginRecipeScopeKind;
  origin: string;
  loginUrl: string;
  loggedInMarkers: string[];
  relogin?: LoginReloginDetails;
  createdAt: number;
  updatedAt: number;
  lastOutcome?: LoginRecipeOutcome;
  lastOutcomeReason?: string;
  lastOutcomeAt?: number;
}

export interface LoginRecipeRecordStore {
  /** Insert or fully replace the row for (scope, origin). */
  put(recipe: LoginRecipe): void;
  get(scope: string, origin: string): LoginRecipe | undefined;
  list(filter?: { scope?: string; origin?: string }): LoginRecipe[];
  delete(scope: string, origin: string): boolean;
  recordOutcome(
    scope: string,
    origin: string,
    outcome: LoginRecipeOutcome,
    reason: string,
    at: number,
  ): void;
}

/** Test double. The app always uses the SQLite store. */
export class InMemoryLoginRecipeStore implements LoginRecipeRecordStore {
  private readonly rows = new Map<string, LoginRecipe>();

  private key(scope: string, origin: string): string {
    return JSON.stringify([scope, origin]);
  }

  put(recipe: LoginRecipe): void {
    this.rows.set(this.key(recipe.scope, recipe.origin), structuredClone(recipe));
  }

  get(scope: string, origin: string): LoginRecipe | undefined {
    const row = this.rows.get(this.key(scope, origin));
    return row ? structuredClone(row) : undefined;
  }

  list(filter?: { scope?: string; origin?: string }): LoginRecipe[] {
    return [...this.rows.values()]
      .filter((row) => (!filter?.scope || row.scope === filter.scope)
        && (!filter?.origin || row.origin === filter.origin))
      .map((row) => structuredClone(row));
  }

  delete(scope: string, origin: string): boolean {
    return this.rows.delete(this.key(scope, origin));
  }

  recordOutcome(
    scope: string,
    origin: string,
    outcome: LoginRecipeOutcome,
    reason: string,
    at: number,
  ): void {
    const row = this.rows.get(this.key(scope, origin));
    if (row) {
      this.rows.set(this.key(scope, origin), {
        ...row,
        lastOutcome: outcome,
        lastOutcomeReason: reason,
        lastOutcomeAt: at,
      });
    }
  }
}

export interface RememberLoginFingerprintInput {
  profileId: string;
  origin: string;
  loginUrl: string;
  loggedInMarkers: string[];
  relogin?: LoginReloginDetails;
}

export interface LoginRecipeScope {
  scope: string;
  scopeKind: LoginRecipeScopeKind;
}

export function loginRecipeScopeFor(profileId: string): LoginRecipeScope {
  return {
    scope: credentialScopeForProfile(profileId),
    scopeKind: existingTabGrantNodeId(profileId) ? 'node' : 'profile',
  };
}

/**
 * Write-through recipe service over a record store. Every read goes to the
 * store; there is no in-process cache that could answer for a missing row.
 */
export class LoginFingerprintStore {
  constructor(
    private readonly records: LoginRecipeRecordStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  remember(input: RememberLoginFingerprintInput): LoginRecipe {
    const origin = normalizeHttpOrigin(input.origin);
    assertHttpUrl(input.loginUrl, 'loginUrl');
    const { scope, scopeKind } = loginRecipeScopeFor(input.profileId);
    const existing = this.records.get(scope, origin);
    const at = this.now();
    // A markers-only refresh after a manual login keeps the stored recipe;
    // browser.forget_login_recipe is the way to drop it.
    const relogin = input.relogin ?? existing?.relogin;
    const recipe: LoginRecipe = {
      scope,
      scopeKind,
      origin,
      loginUrl: input.loginUrl,
      loggedInMarkers: [...input.loggedInMarkers],
      ...(relogin ? { relogin } : {}),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.records.put(recipe);
    return recipe;
  }

  /** Recipe for the tab/profile's stable scope and a page origin. */
  find(profileId: string, origin: string): LoginRecipe | undefined {
    return this.records.get(loginRecipeScopeFor(profileId).scope, origin);
  }

  fingerprintOf(recipe: LoginRecipe): SessionFingerprint {
    return { loggedInMarkers: recipe.loggedInMarkers, loginUrl: recipe.loginUrl };
  }

  recordOutcome(
    profileId: string,
    origin: string,
    outcome: LoginRecipeOutcome,
    reason: string,
  ): void {
    this.records.recordOutcome(
      loginRecipeScopeFor(profileId).scope,
      origin,
      outcome,
      reason,
      this.now(),
    );
  }

  list(filter?: { profileId?: string; origin?: string }): LoginRecipe[] {
    return this.records.list({
      ...(filter?.profileId ? { scope: loginRecipeScopeFor(filter.profileId).scope } : {}),
      ...(filter?.origin ? { origin: normalizeHttpOrigin(filter.origin) } : {}),
    });
  }

  forget(scope: string, origin: string): boolean {
    return this.records.delete(scope, normalizeHttpOrigin(origin));
  }
}

function normalizeHttpOrigin(value: string): string {
  const url = assertHttpUrl(value, 'origin');
  return url.origin;
}

function assertHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${field}: not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid ${field}: must be http(s)`);
  }
  return url;
}
