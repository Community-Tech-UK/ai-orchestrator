import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserGatewayResult } from '@contracts/types/browser';
import { checkSessionOperation, type CheckSessionDeps } from './browser-session-relogin';
import { InMemoryLoginRecipeStore, LoginFingerprintStore } from './browser-login-recipe-store';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const ORIGIN = 'https://portal.example.gov.uk';

function allowed<T>(data: T): BrowserGatewayResult<T> {
  return {
    decision: 'allowed',
    outcome: 'succeeded',
    data,
  } as unknown as BrowserGatewayResult<T>;
}

interface PageState {
  url: string;
  text: string;
  hasPasswordField: boolean;
}

function makeDeps(page: PageState, fingerprints = new LoginFingerprintStore(new InMemoryLoginRecipeStore())) {
  const escalations = { raise: vi.fn(() => ({ escalationId: 'esc-1', parked: true as const })) };
  const deps: CheckSessionDeps = {
    fingerprints,
    escalations,
    snapshot: vi.fn(async () => allowed({ title: 'Portal', url: page.url, text: page.text })),
    queryElements: vi.fn(async () =>
      allowed(page.hasPasswordField ? [{ selector: '#pw', tagName: 'input', inputType: 'password' }] : []),
    ),
    navigate: vi.fn(async () => allowed(null)),
    fillCredential: vi.fn(async () => allowed({ filled: 1 })),
    click: vi.fn(async () => allowed(null)),
    sleep: vi.fn(async () => undefined),
  };
  return { deps, fingerprints, escalations, page };
}

const REQUEST = { profileId: 'profile-1', targetId: 'target-1', instanceId: 'instance-1' };

describe('checkSessionOperation', () => {
  let harness: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    harness = makeDeps({
      url: `${ORIGIN}/dashboard`,
      text: 'Welcome back · Log out',
      hasPasswordField: false,
    });
    harness.fingerprints.remember({
      profileId: 'profile-1',
      origin: ORIGIN,
      loginUrl: `${ORIGIN}/login`,
      loggedInMarkers: ['log out'],
      relogin: {
        vaultItemRef: 'item-1',
        usernameSelector: '#user',
        passwordSelector: '#pass',
        submitSelector: '#submit',
      },
    });
  });

  it('reports logged_in and does nothing when the fingerprint matches', async () => {
    const outcome = await checkSessionOperation(harness.deps, REQUEST);

    expect(outcome).toMatchObject({ state: 'logged_in', reloggedIn: false, attempts: 0 });
    expect(harness.deps.navigate).not.toHaveBeenCalled();
    expect(harness.escalations.raise).not.toHaveBeenCalled();
  });

  it('re-logs in when the page shows a password field', async () => {
    harness.page.hasPasswordField = true;
    harness.page.text = 'Please sign in';
    // After the re-login attempt, the page looks logged-in again.
    let probes = 0;
    harness.deps.snapshot = vi.fn(async () => {
      probes += 1;
      return probes >= 2
        ? allowed({ title: 'Portal', url: `${ORIGIN}/dashboard`, text: 'Log out' })
        : allowed({ title: 'Login', url: `${ORIGIN}/login`, text: 'Please sign in' });
    });
    harness.deps.queryElements = vi.fn(async () =>
      allowed(probes >= 2 ? [] : [{ selector: '#pw', tagName: 'input', inputType: 'password' }]),
    );

    const outcome = await checkSessionOperation(harness.deps, REQUEST);

    expect(outcome).toMatchObject({ state: 'logged_in', reloggedIn: true, attempts: 1 });
    expect(harness.deps.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${ORIGIN}/login` }),
    );
    expect(harness.deps.fillCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultItemRef: 'item-1',
        fields: [
          { selector: '#user', kind: 'username' },
          { selector: '#pass', kind: 'password' },
        ],
      }),
    );
    expect(harness.deps.click).toHaveBeenCalledWith(
      expect.objectContaining({ selector: '#submit' }),
    );
  });

  it('parks a relogin_failed escalation after two failed attempts', async () => {
    harness.page.hasPasswordField = true;
    harness.page.text = 'Please sign in';
    harness.deps.fillCredential = vi.fn(async () =>
      ({ decision: 'denied', outcome: 'not_run', reason: 'credential_not_authorized:x' }) as never,
    );

    const outcome = await checkSessionOperation(
      harness.deps,
      { ...REQUEST, campaignId: 'campaign-1' },
    );

    expect(outcome).toMatchObject({
      state: 'logged_out',
      reason: 'relogin_failed',
      attempts: 2,
      parked: true,
      escalationId: 'esc-1',
    });
    expect(harness.deps.navigate).toHaveBeenCalledTimes(2);
    expect(harness.escalations.raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'relogin_failed', campaignId: 'campaign-1' }),
    );
  });

  it('parks immediately when logged out with no fingerprint recorded', async () => {
    const bare = makeDeps({
      url: 'https://unknown-site.example.com/login',
      text: 'Sign in',
      hasPasswordField: true,
    });

    const outcome = await checkSessionOperation(bare.deps, REQUEST);

    expect(outcome).toMatchObject({
      state: 'logged_out',
      reason: 'no_fingerprint',
      parked: true,
    });
    expect(bare.deps.navigate).not.toHaveBeenCalled();
    expect(bare.escalations.raise).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a re-login when autoRelogin is false', async () => {
    harness.page.hasPasswordField = true;

    const outcome = await checkSessionOperation(harness.deps, {
      ...REQUEST,
      autoRelogin: false,
    });

    expect(outcome).toMatchObject({ state: 'logged_out', reloggedIn: false, attempts: 0 });
    expect(harness.deps.navigate).not.toHaveBeenCalled();
    expect(harness.escalations.raise).not.toHaveBeenCalled();
  });

  it('runs the second-factor pass when a code selector is configured', async () => {
    harness.fingerprints.remember({
      profileId: 'profile-1',
      origin: ORIGIN,
      loginUrl: `${ORIGIN}/login`,
      loggedInMarkers: ['log out'],
      relogin: {
        vaultItemRef: 'item-1',
        passwordSelector: '#pass',
        submitSelector: '#submit',
        codeSelector: '#code',
        codeKind: 'email_code',
      },
    });
    harness.page.hasPasswordField = true;
    let probes = 0;
    harness.deps.snapshot = vi.fn(async () => {
      probes += 1;
      return probes >= 2
        ? allowed({ title: 'Portal', url: `${ORIGIN}/dashboard`, text: 'Log out' })
        : allowed({ title: 'Login', url: `${ORIGIN}/login`, text: 'Sign in' });
    });
    harness.deps.queryElements = vi.fn(async () =>
      allowed(probes >= 2 ? [] : [{ selector: '#pw', tagName: 'input', inputType: 'password' }]),
    );

    const outcome = await checkSessionOperation(harness.deps, REQUEST);

    expect(outcome.reloggedIn).toBe(true);
    const fillCalls = (harness.deps.fillCredential as ReturnType<typeof vi.fn>).mock.calls;
    expect(fillCalls).toHaveLength(2);
    expect(fillCalls[1]![0]).toMatchObject({
      fields: [{ selector: '#code', kind: 'email_code' }],
    });
    expect(harness.deps.click).toHaveBeenCalledTimes(2);
  });

  it('always asks for a live snapshot, never the cached copy', async () => {
    await checkSessionOperation(harness.deps, REQUEST);

    expect(harness.deps.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ requireLive: true }),
    );
  });

  it('returns the live page and records the outcome on the recipe', async () => {
    harness.page.hasPasswordField = true;
    let probes = 0;
    harness.deps.snapshot = vi.fn(async () => {
      probes += 1;
      return probes >= 2
        ? allowed({ title: 'Portal home', url: `${ORIGIN}/dashboard`, text: 'Log out' })
        : allowed({ title: 'Login', url: `${ORIGIN}/login`, text: 'Sign in' });
    });
    harness.deps.queryElements = vi.fn(async () =>
      allowed(probes >= 2 ? [] : [{ selector: '#pw', tagName: 'input', inputType: 'password' }]),
    );

    const outcome = await checkSessionOperation(harness.deps, REQUEST);

    expect(outcome).toMatchObject({
      state: 'logged_in',
      reloggedIn: true,
      recipeScope: 'profile-1',
      page: { title: 'Portal home', url: `${ORIGIN}/dashboard` },
    });
    expect(harness.fingerprints.list()[0]).toMatchObject({
      lastOutcome: 'relogged_in',
      lastOutcomeReason: 'fingerprint_matched',
    });
  });

  it('waits for a slow post-login redirect before judging the page', async () => {
    harness.page.hasPasswordField = true;
    let probes = 0;
    harness.deps.snapshot = vi.fn(async () => {
      probes += 1;
      // Probe 1 is the initial check; probes 2-3 are the login form still
      // showing while the submit redirects.
      return probes >= 4
        ? allowed({ title: 'Portal', url: `${ORIGIN}/dashboard`, text: 'Log out' })
        : allowed({ title: 'Login', url: `${ORIGIN}/login`, text: 'Sign in' });
    });
    harness.deps.queryElements = vi.fn(async () =>
      allowed(probes >= 4 ? [] : [{ selector: '#pw', tagName: 'input', inputType: 'password' }]),
    );

    const outcome = await checkSessionOperation(harness.deps, REQUEST);

    expect(outcome).toMatchObject({ state: 'logged_in', reloggedIn: true, attempts: 1 });
    expect(harness.deps.sleep).toHaveBeenCalledTimes(2);
    expect(harness.deps.fillCredential).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unreadable page after sign-in as success', async () => {
    harness.page.hasPasswordField = true;
    let probes = 0;
    harness.deps.snapshot = vi.fn(async () => {
      probes += 1;
      return probes >= 2
        ? allowed({
            title: 'Secret-filled tab',
            url: `${ORIGIN}/`,
            text: '',
            textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin',
          })
        : allowed({ title: 'Login', url: `${ORIGIN}/login`, text: 'Sign in' });
    });
    harness.deps.queryElements = vi.fn(async () =>
      allowed([{ selector: '#pw', tagName: 'input', inputType: 'password' }]),
    );

    const outcome = await checkSessionOperation(harness.deps, REQUEST);

    expect(outcome).toMatchObject({
      state: 'unknown',
      reason: 'observation_blocked_after_relogin',
      reloggedIn: false,
      attempts: 1,
      parked: true,
    });
    // Refilling a credential into a page we still cannot read helps nothing.
    expect(harness.deps.fillCredential).toHaveBeenCalledTimes(1);
    expect(harness.escalations.raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'relogin_failed', reason: expect.stringMatching(/cannot be read/) }),
    );
    expect(harness.fingerprints.list()[0]?.lastOutcome).toBe('observation_blocked');
  });

  it('does not treat a failed snapshot after sign-in as success', async () => {
    harness.page.hasPasswordField = true;
    let probes = 0;
    harness.deps.snapshot = vi.fn(async () => {
      probes += 1;
      return probes >= 2
        ? ({ decision: 'allowed', outcome: 'failed', reason: 'browser_extension_command_timeout', data: null } as never)
        : allowed({ title: 'Login', url: `${ORIGIN}/login`, text: 'Sign in' });
    });

    const outcome = await checkSessionOperation(harness.deps, REQUEST);

    expect(outcome).toMatchObject({
      state: 'logged_out',
      reason: 'relogin_failed',
      reloggedIn: false,
      attempts: 2,
    });
    expect(harness.fingerprints.list()[0]).toMatchObject({
      lastOutcome: 'relogin_failed',
      lastOutcomeReason: 'browser_extension_command_timeout',
    });
  });

  it('fails the attempt with the reason when the submit click is refused', async () => {
    harness.page.hasPasswordField = true;
    harness.deps.click = vi.fn(async () =>
      ({ decision: 'requires_user', outcome: 'not_run', reason: 'grant_required', data: null }) as never,
    );

    const outcome = await checkSessionOperation(harness.deps, REQUEST);

    expect(outcome).toMatchObject({ reason: 'relogin_failed', attempts: 2 });
    expect(harness.deps.snapshot).toHaveBeenCalledTimes(1);
    expect(harness.escalations.raise).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('relogin submit refused: grant_required') }),
    );
  });

  it('parks with no_relogin_recipe when only markers were remembered', async () => {
    const markersOnly = makeDeps({ url: `${ORIGIN}/login`, text: 'Sign in', hasPasswordField: true });
    markersOnly.fingerprints.remember({
      profileId: 'profile-1',
      origin: ORIGIN,
      loginUrl: `${ORIGIN}/login`,
      loggedInMarkers: ['log out'],
    });

    const outcome = await checkSessionOperation(markersOnly.deps, REQUEST);

    expect(outcome).toMatchObject({ state: 'logged_out', reason: 'no_relogin_recipe', parked: true });
    expect(markersOnly.deps.navigate).not.toHaveBeenCalled();
  });

  it('finds a recipe recorded on one shared tab from a different tab on the same node', async () => {
    const records = new InMemoryLoginRecipeStore();
    const fingerprints = new LoginFingerprintStore(records);
    fingerprints.remember({
      profileId: 'existing-tab:n.node-a:10:11',
      origin: ORIGIN,
      loginUrl: `${ORIGIN}/login`,
      loggedInMarkers: ['log out'],
      relogin: { vaultItemRef: 'item-1', passwordSelector: '#pass', submitSelector: '#submit' },
    });
    let probes = 0;
    const next = makeDeps({ url: `${ORIGIN}/login`, text: 'Sign in', hasPasswordField: true }, fingerprints);
    next.deps.snapshot = vi.fn(async () => {
      probes += 1;
      return probes >= 2
        ? allowed({ title: 'Portal', url: `${ORIGIN}/dashboard`, text: 'Log out' })
        : allowed({ title: 'Login', url: `${ORIGIN}/login`, text: 'Sign in' });
    });
    next.deps.queryElements = vi.fn(async () =>
      allowed(probes >= 2 ? [] : [{ selector: '#pw', tagName: 'input', inputType: 'password' }]),
    );

    const outcome = await checkSessionOperation(next.deps, {
      profileId: 'existing-tab:n.node-a:10:99',
      targetId: 'existing-tab:n.node-a:10:99:target',
    });

    expect(outcome).toMatchObject({ reloggedIn: true, recipeScope: 'node-a' });

    // A different computer is a different scope.
    const other = makeDeps({ url: `${ORIGIN}/login`, text: 'Sign in', hasPasswordField: true }, fingerprints);
    const otherOutcome = await checkSessionOperation(other.deps, {
      profileId: 'existing-tab:n.node-b:10:11',
      targetId: 'existing-tab:n.node-b:10:11:target',
    });
    expect(otherOutcome).toMatchObject({ reason: 'no_fingerprint', recipeScope: 'node-b' });
  });
});
