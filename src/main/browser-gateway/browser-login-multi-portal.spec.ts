import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { InMemoryLoginRecipeStore, LoginFingerprintStore, type LoginRecipeRecordStore } from './browser-login-recipe-store';
import { SqliteLoginRecipeStore } from './browser-unattended-sqlite-stores';
import { checkSessionOperation, type CheckSessionDeps } from './browser-session-relogin';
import type { BrowserGatewayResult } from '@contracts/types/browser';

const ORIGIN = 'https://supplier.example';
const PROFILE = 'existing-tab:n.windows-pc:1:1';

function allowed<T>(data: T): BrowserGatewayResult<T> {
  return { decision: 'allowed', outcome: 'succeeded', data } as BrowserGatewayResult<T>;
}

describe.each(['sqlite', 'memory'])('shared-origin buyer login recipes (LT-708, %s)', (backend) => {
  let db: SqliteDriver;
  let records: LoginRecipeRecordStore;
  let store: LoginFingerprintStore;
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    records = backend === 'sqlite' ? new SqliteLoginRecipeStore(db) : new InMemoryLoginRecipeStore();
    store = new LoginFingerprintStore(records);
  });
  afterEach(() => db?.close());

  function remember(portal: string, account = `TEST_ONLY_${portal}`) {
    return store.remember({
      profileId: PROFILE,
      origin: ORIGIN,
      loginUrl: `${ORIGIN}/${portal}/home`,
      loggedInMarkers: ['Logout'],
      relogin: { vaultItemRef: account, passwordSelector: '#password', submitSelector: '#login' },
    });
  }

  function session(portal: string) {
    const page = { url: `${ORIGIN}/${portal}/home`, text: 'Sign in', loggedIn: false };
    const deps: CheckSessionDeps = {
      fingerprints: store,
      escalations: { raise: vi.fn(() => ({ escalationId: 'TEST_ONLY_escalation', parked: true as const })) },
      snapshot: vi.fn(async () => allowed({ url: page.url, title: 'Buyer', text: page.text })),
      queryElements: vi.fn(async () => allowed(page.loggedIn
        ? [] : [{ tagName: 'input', selector: '#password', inputType: 'password' }])),
      navigate: vi.fn(async ({ url }) => { page.url = url; return allowed(null); }),
      fillCredential: vi.fn(async () => allowed({ filled: 1 })),
      click: vi.fn(async () => {
        page.loggedIn = true;
        page.text = 'Logout';
        page.url = `${ORIGIN}/${portal}/tenders/current`;
        return allowed(null);
      }),
      waitFor: vi.fn(async () => allowed(null)),
      sleep: async () => undefined,
    };
    return { page, deps };
  }

  it('retains both buyer portals instead of replacing the first account', () => {
    remember('cpcatapult');
    remember('publicagroup');
    expect(store.list()).toHaveLength(2);
    expect(store.list().map((r) => r.loginUrl).sort()).toEqual([
      `${ORIGIN}/cpcatapult/home`, `${ORIGIN}/publicagroup/home`,
    ]);
  });

  it.each(['cpcatapult', 'publicagroup'])('relogs only %s on a new tab and updates only its outcome', async (portal) => {
    remember('cpcatapult');
    remember('publicagroup');
    const { deps } = session(portal);
    const outcome = await checkSessionOperation(deps, {
      profileId: 'existing-tab:n.windows-pc:8:99', targetId: 'TEST_ONLY_new_tab',
    });
    expect(outcome).toMatchObject({ state: 'logged_in', reloggedIn: true, attempts: 1, recipeScope: 'windows-pc' });
    expect(deps.navigate).toHaveBeenCalledWith(expect.objectContaining({ url: `${ORIGIN}/${portal}/home` }));
    expect(deps.fillCredential).toHaveBeenCalledTimes(1);
    expect(deps.fillCredential).toHaveBeenCalledWith(expect.objectContaining({ vaultItemRef: `TEST_ONLY_${portal}` }));
    expect(store.list().find((r) => r.portalPath === `/${portal}`)?.lastOutcome).toBe('relogged_in');
    expect(store.list().find((r) => r.portalPath !== `/${portal}`)?.lastOutcome).toBeUndefined();
  });

  it('does not match a sibling name, another origin or another computer', () => {
    remember('publicagroup');
    for (const url of [`${ORIGIN}/publicagroup-other/home`, `${ORIGIN}/cpcatapult/home`, 'https://other.example/publicagroup/home']) {
      expect(store.resolve(PROFILE, url)).toEqual({ reason: 'no_fingerprint' });
    }
    expect(store.resolve('existing-tab:n.other-pc:8:99', `${ORIGIN}/publicagroup/home`)).toEqual({ reason: 'no_fingerprint' });
    expect(store.resolve(PROFILE, `${ORIGIN}/publicagroup?tab=home`).recipe?.accountRef).toBe('TEST_ONLY_publicagroup');
  });

  it('keeps both accounts and refuses ambiguous auto-login and markers-only refresh', async () => {
    remember('publicagroup', 'TEST_ONLY_first');
    remember('publicagroup', 'TEST_ONLY_second');
    const { deps } = session('publicagroup');
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'unknown', reason: 'login_recipe_account_ambiguous', attempts: 0 });
    expect(deps.fillCredential).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(() => store.remember({ profileId: PROFILE, origin: ORIGIN,
      loginUrl: `${ORIGIN}/publicagroup/home`, loggedInMarkers: ['Account'] }))
      .toThrow(/account_ambiguous/);
    expect(store.list()).toHaveLength(2);
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab', vaultItemRef: 'TEST_ONLY_second' }))
      .toMatchObject({ state: 'logged_in', reloggedIn: true });
    expect(deps.fillCredential).toHaveBeenCalledWith(expect.objectContaining({ vaultItemRef: 'TEST_ONLY_second' }));
  });

  it('matches the most specific portal before selecting the requested account', () => {
    remember('publicagroup', 'TEST_ONLY_parent');
    remember('publicagroup/subportal', 'TEST_ONLY_child');
    const url = `${ORIGIN}/publicagroup/subportal/home`;
    expect(store.resolve(PROFILE, url).recipe?.accountRef).toBe('TEST_ONLY_child');
    expect(store.resolve(PROFILE, url, 'TEST_ONLY_parent')).toEqual({ reason: 'no_fingerprint' });
  });

  it('refuses ambiguous deletion and deletes only the selected recipe', () => {
    const catapult = remember('cpcatapult');
    const publica = remember('publicagroup');
    expect(() => store.forget({ scope: 'windows-pc', origin: ORIGIN })).toThrow(/ambiguous/);
    expect(store.forget({ scope: 'other-pc', origin: ORIGIN, recipeId: catapult.id })).toBe(false);
    expect(store.forget({ scope: 'windows-pc', origin: ORIGIN, recipeId: catapult.id })).toBe(true);
    expect(store.list()).toEqual([publica]);
  });

  it('keeps an account recipe during its markers-only refresh without affecting another portal', () => {
    const catapult = remember('cpcatapult');
    const publica = remember('publicagroup');
    const updated = store.remember({ profileId: PROFILE, origin: ORIGIN,
      loginUrl: `${ORIGIN}/publicagroup/home`, loggedInMarkers: ['Account', 'Logout'] });
    expect(updated).toMatchObject({ id: publica.id, relogin: publica.relogin, loggedInMarkers: ['Account', 'Logout'] });
    expect(store.list().find((r) => r.id === catapult.id)).toEqual(catapult);
  });

  it('stops before filling after a same-origin redirect into the other buyer portal', async () => {
    remember('cpcatapult');
    remember('publicagroup');
    const { page, deps } = session('cpcatapult');
    deps.navigate = vi.fn(async () => { page.url = `${ORIGIN}/publicagroup/home`; return allowed(null); });
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'unknown', reason: 'login_recipe_portal_changed', attempts: 1 });
    expect(deps.fillCredential).not.toHaveBeenCalled();
  });

  it('does not report success from the other portal even when Logout is visible', async () => {
    remember('cpcatapult');
    remember('publicagroup');
    const { page, deps } = session('cpcatapult');
    deps.click = vi.fn(async () => {
      page.url = `${ORIGIN}/publicagroup/tenders/current`;
      page.text = 'Logout'; page.loggedIn = true;
      return allowed(null);
    });
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'unknown', reason: 'login_recipe_portal_changed', reloggedIn: false });
  });

  it('does not fill a second factor after the password submit changes buyer portal', async () => {
    const recipe = remember('cpcatapult');
    remember('publicagroup');
    store.remember({ profileId: PROFILE, origin: ORIGIN, loginUrl: recipe.loginUrl,
      loggedInMarkers: ['Logout'], relogin: { ...recipe.relogin!, codeSelector: '#code', codeKind: 'totp' } });
    const { page, deps } = session('cpcatapult');
    deps.click = vi.fn(async () => { page.url = `${ORIGIN}/publicagroup/home`; return allowed(null); });
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'unknown', reason: 'login_recipe_portal_changed', attempts: 1 });
    expect(deps.fillCredential).toHaveBeenCalledTimes(1);
    expect(deps.fillCredential).toHaveBeenCalledWith(expect.objectContaining({
      fields: [{ selector: '#password', kind: 'password' }], vaultItemRef: 'TEST_ONLY_cpcatapult',
    }));
  });

  it('waits for the code input before rechecking a delayed post-password redirect', async () => {
    const recipe = remember('cpcatapult');
    remember('publicagroup');
    store.remember({ profileId: PROFILE, origin: ORIGIN, loginUrl: recipe.loginUrl,
      loggedInMarkers: ['Logout'], relogin: { ...recipe.relogin!, codeSelector: '#code', codeKind: 'totp' } });
    const { page, deps } = session('cpcatapult');
    // The click returns before navigation, as it can on the real extension.
    deps.click = vi.fn(async () => allowed(null));
    const waitFor = vi.fn(async () => { page.url = `${ORIGIN}/publicagroup/home`; return allowed(null); });
    deps.waitFor = waitFor;
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'unknown', reason: 'login_recipe_portal_changed', attempts: 1 });
    expect(waitFor).toHaveBeenCalledWith(expect.objectContaining({ selector: '#code' }));
    expect(deps.fillCredential).toHaveBeenCalledTimes(1);
  });

  it('returns a diagnostic without navigation or fill for an ambiguous migrated legacy row', async () => {
    records.put({ id: 'TEST_ONLY_legacy', scope: 'windows-pc', scopeKind: 'node', origin: ORIGIN,
      portalPath: null, accountRef: '', loginUrl: `${ORIGIN}/publicagroup/home`,
      loggedInMarkers: ['Logout'], relogin: { vaultItemRef: 'TEST_ONLY_legacy', passwordSelector: '#password' },
      createdAt: 1, updatedAt: 1 });
    const { deps } = session('cpcatapult');
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'unknown', reason: 'login_recipe_legacy_scope_unknown', attempts: 0 });
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(deps.fillCredential).not.toHaveBeenCalled();
  });

  it('does not fill a code when its post-submit page cannot be read', async () => {
    const recipe = remember('publicagroup');
    store.remember({ profileId: PROFILE, origin: ORIGIN, loginUrl: recipe.loginUrl,
      loggedInMarkers: ['Logout'], relogin: { ...recipe.relogin!, codeSelector: '#code', codeKind: 'totp' } });
    const { page, deps } = session('publicagroup');
    let codeReady = false;
    deps.waitFor = vi.fn(async () => { codeReady = true; return allowed(null); });
    deps.snapshot = vi.fn(async () => allowed({ url: page.url, title: 'Buyer', text: codeReady ? '' : 'Sign in',
      ...(codeReady ? { textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin' } : {}) }));
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'unknown', reason: 'browser_secret_observation_blocked_for_tainted_origin', attempts: 1 });
    expect(deps.fillCredential).toHaveBeenCalledTimes(1);
  });

  it('does not retry passwords when the second-factor control never arrives', async () => {
    const recipe = remember('publicagroup');
    store.remember({ profileId: PROFILE, origin: ORIGIN, loginUrl: recipe.loginUrl,
      loggedInMarkers: ['Logout'], relogin: { ...recipe.relogin!, codeSelector: '#code', codeKind: 'totp' } });
    const { deps } = session('publicagroup');
    deps.waitFor = vi.fn(async () => ({ decision: 'allowed', outcome: 'failed', reason: 'TEST_ONLY_wait_timeout', data: null }) as BrowserGatewayResult<null>);
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'unknown', reason: 'TEST_ONLY_wait_timeout', attempts: 1 });
    expect(deps.fillCredential).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing credential refusal instead of treating recipe choice as permission', async () => {
    remember('publicagroup');
    const { deps } = session('publicagroup');
    deps.fillCredential = vi.fn(async () => ({ decision: 'denied', outcome: 'not_run',
      reason: 'credential_not_authorized', data: null }) as BrowserGatewayResult<null>);
    expect(await checkSessionOperation(deps, { profileId: PROFILE, targetId: 'TEST_ONLY_tab' }))
      .toMatchObject({ state: 'logged_out', reason: 'relogin_failed', reloggedIn: false });
    expect(deps.click).not.toHaveBeenCalled();
  });

  it('rejects cross-origin login URLs and paths outside the selected portal', () => {
    const input = { profileId: PROFILE, origin: ORIGIN, loggedInMarkers: ['Logout'] };
    expect(() => store.remember({ ...input, loginUrl: 'https://other.example/publicagroup/home' })).toThrow(/origin/);
    expect(() => store.remember({ ...input, loginUrl: `${ORIGIN}/publicagroup/home`, portalPath: '/cpcatapult' })).toThrow(/portalPath/);
    for (const portalPath of ['//other.example', '/publicagroup/../', '/publicagroup?buyer=other', '/publicagroup#other', '/publicagroup\\other']) {
      expect(() => store.remember({ ...input, loginUrl: `${ORIGIN}/publicagroup/home`, portalPath })).toThrow(/portalPath/);
    }
  });

  it('requires an explicit path instead of inferring an origin-wide recipe from a single-segment URL', () => {
    for (const loginUrl of [`${ORIGIN}/publicagroup`, `${ORIGIN}/login`]) {
      expect(() => store.remember({ profileId: PROFILE, origin: ORIGIN, loginUrl, loggedInMarkers: ['Logout'] }))
        .toThrow(/explicit portalPath/);
    }
    expect(store.list()).toEqual([]);
    store.remember({ profileId: PROFILE, origin: ORIGIN, loginUrl: `${ORIGIN}/login`,
      portalPath: '/', loggedInMarkers: ['Logout'] });
    expect(store.resolve(PROFILE, `${ORIGIN}/dashboard`).recipe).toBeDefined();
  });

  it('refuses a silent portal-path correction that would leave an older overlapping recipe in control', () => {
    const old = remember('publicagroup/aspx', 'TEST_ONLY_account');
    expect(() => store.remember({ profileId: PROFILE, origin: ORIGIN,
      loginUrl: `${ORIGIN}/publicagroup/home`, portalPath: '/publicagroup', loggedInMarkers: ['Logout'],
      relogin: { vaultItemRef: 'TEST_ONLY_account', passwordSelector: '#password' } }))
      .toThrow(/portal_overlap.*forget_login_recipe/);
    expect(store.list()).toEqual([old]);
    expect(store.forget({ scope: 'windows-pc', origin: ORIGIN, recipeId: old.id })).toBe(true);
    const corrected = remember('publicagroup', 'TEST_ONLY_account');
    expect(store.resolve(PROFILE, `${ORIGIN}/publicagroup/aspx/home`).recipe?.id).toBe(corrected.id);
  });
});
