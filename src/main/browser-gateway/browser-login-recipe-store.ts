import { randomUUID } from 'node:crypto';
import { credentialScopeForProfile, existingTabGrantNodeId } from './browser-grant-scope';
import type { SessionFingerprint } from './browser-session-sentinel';

/**
 * Login fingerprints and re-login recipes for `browser.check_session`.
 *
 * Keyed by the same stable scope as credential authorizations
 * (`credentialScopeForProfile`): the managed profileId, or the node scope for
 * a shared existing tab, plus portal path and account reference. A recipe recorded
 * on one In-tend tab reaches the next tab on that computer, and the SQLite store
 * lets it survive a restart (migrations 065 and 081).
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
  id: string;
  scope: string;
  scopeKind: LoginRecipeScopeKind;
  origin: string;
  /** Null means a migrated origin-only recipe: never auto-select it. */
  portalPath: string | null;
  /** Vault reference, or empty for a markers-only recipe. Never a secret. */
  accountRef: string;
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
  put(recipe: LoginRecipe): void;
  list(filter?: { scope?: string; origin?: string }): LoginRecipe[];
  delete(id: string): boolean;
  recordOutcome(id: string, outcome: LoginRecipeOutcome, reason: string, at: number): void;
}

/** Test double. The app always uses the SQLite store. */
export class InMemoryLoginRecipeStore implements LoginRecipeRecordStore {
  private readonly rows = new Map<string, LoginRecipe>();

  put(recipe: LoginRecipe): void {
    this.rows.set(recipe.id, structuredClone(recipe));
  }

  list(filter?: { scope?: string; origin?: string }): LoginRecipe[] {
    return [...this.rows.values()]
      .filter((row) => (!filter?.scope || row.scope === filter.scope)
        && (!filter?.origin || row.origin === filter.origin))
      .map((row) => structuredClone(row));
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  recordOutcome(id: string, outcome: LoginRecipeOutcome, reason: string, at: number): void {
    const row = this.rows.get(id);
    if (row) {
      this.rows.set(id, { ...row, lastOutcome: outcome, lastOutcomeReason: reason, lastOutcomeAt: at });
    }
  }
}

export interface RememberLoginFingerprintInput {
  profileId: string;
  origin: string;
  loginUrl: string;
  portalPath?: string;
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
    const loginUrl = assertHttpUrl(input.loginUrl, 'loginUrl');
    if (loginUrl.origin !== origin) throw new Error('loginUrl must belong to the recipe origin');
    const portalPath = loginPortalPath(input.loginUrl, input.portalPath);
    if (!portalPathMatches(portalPath, loginUrl.pathname)) {
      throw new Error('loginUrl must belong to portalPath');
    }
    const { scope, scopeKind } = loginRecipeScopeFor(input.profileId);
    const scopedRows = this.records.list({ scope, origin });
    const rows = scopedRows.filter((row) => row.portalPath === portalPath);
    const accountRef = input.relogin?.vaultItemRef;
    if (accountRef && scopedRows.some((row) => row.accountRef === accountRef
      && row.portalPath !== null && row.portalPath !== portalPath
      && (portalPathMatches(row.portalPath, portalPath) || portalPathMatches(portalPath, row.portalPath)))) {
      throw new Error('login_recipe_portal_overlap: use browser.forget_login_recipe to remove the old path before recording its correction');
    }
    if (!accountRef && rows.length > 1) {
      throw new Error('login_recipe_account_ambiguous: supply the re-login vault item reference');
    }
    const existing = accountRef
      ? rows.find((row) => row.accountRef === accountRef)
        ?? (rows.length === 1 && rows[0].accountRef === '' ? rows[0] : undefined)
      : rows[0];
    const at = this.now();
    // A markers-only refresh after a manual login keeps the stored recipe;
    // browser.forget_login_recipe is the way to drop it.
    const relogin = input.relogin ?? existing?.relogin;
    const recipe: LoginRecipe = {
      id: existing?.id ?? randomUUID(),
      portalPath,
      accountRef: accountRef ?? existing?.accountRef ?? '',
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

  /** Select only within the live URL's portal; never choose an arbitrary account. */
  resolve(profileId: string, liveUrl: string, vaultItemRef?: string): LoginRecipeSelection {
    const url = assertHttpUrl(liveUrl, 'liveUrl');
    const rows = this.list({ profileId, origin: url.origin });
    const candidates = rows.filter((row) => row.portalPath !== null
      && portalPathMatches(row.portalPath, url.pathname));
    if (!candidates.length) {
      return { reason: rows.some((row) => row.portalPath === null)
        ? 'login_recipe_legacy_scope_unknown' : 'no_fingerprint' };
    }
    // Determine the portal BEFORE applying account preference. A root recipe
    // for a different account must not become a fallback for a child portal.
    const longest = Math.max(...candidates.map((row) => row.portalPath!.length));
    const portal = candidates.filter((row) => row.portalPath!.length === longest);
    const accounts = vaultItemRef ? portal.filter((row) => row.accountRef === vaultItemRef) : portal;
    if (accounts.length > 1) return { reason: 'login_recipe_account_ambiguous' };
    return accounts[0] ? { recipe: accounts[0] } : { reason: 'no_fingerprint' };
  }

  fingerprintOf(recipe: LoginRecipe): SessionFingerprint {
    return { loggedInMarkers: recipe.loggedInMarkers, loginUrl: recipe.loginUrl };
  }

  recordOutcome(recipeId: string, outcome: LoginRecipeOutcome, reason: string): void {
    this.records.recordOutcome(recipeId, outcome, reason, this.now());
  }

  list(filter?: { profileId?: string; origin?: string }): LoginRecipe[] {
    return this.records.list({
      ...(filter?.profileId ? { scope: loginRecipeScopeFor(filter.profileId).scope } : {}),
      ...(filter?.origin ? { origin: normalizeHttpOrigin(filter.origin) } : {}),
    });
  }

  forget(input: { scope: string; origin: string; recipeId?: string }): boolean {
    const rows = this.records.list({ scope: input.scope, origin: normalizeHttpOrigin(input.origin) });
    const selected = input.recipeId ? rows.filter((row) => row.id === input.recipeId) : rows;
    if (selected.length > 1) {
      throw new Error('login_recipe_ambiguous: supply recipeId from browser.list_login_recipes');
    }
    return selected[0] ? this.records.delete(selected[0].id) : false;
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

export type LoginRecipeSelection =
  | { recipe: LoginRecipe; reason?: never }
  | { recipe?: never; reason: 'no_fingerprint' | 'login_recipe_account_ambiguous' | 'login_recipe_legacy_scope_unknown' };

export function portalPathMatches(portalPath: string, pathname: string): boolean {
  return portalPath === '/' || pathname === portalPath || pathname.startsWith(`${portalPath}/`);
}

function normalizePortalPath(value: string): string {
  const url = new URL(value, 'https://portal.invalid');
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')
    || url.origin !== 'https://portal.invalid' || url.search || url.hash
    || url.pathname !== value) {
    throw new Error('portalPath must be a canonical absolute URL path');
  }
  return url.pathname.replace(/\/+$/, '') || '/';
}

/** Conservative default: the login URL directory, never an origin-wide legacy guess. */
export function loginPortalPath(loginUrl: string, portalPath?: string): string {
  const url = assertHttpUrl(loginUrl, 'loginUrl');
  const directory = new URL('.', url).pathname;
  if (portalPath === undefined && directory === '/' && url.pathname !== '/') {
    throw new Error('An explicit portalPath is required for a login URL in the root directory');
  }
  return normalizePortalPath(portalPath ?? directory);
}
