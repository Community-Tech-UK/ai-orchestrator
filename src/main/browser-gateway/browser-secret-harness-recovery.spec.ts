import { describe, expect, it } from 'vitest';
import type { ScriptResult, TestCommand } from './browser-secret-recovery.testutil';
import { MARKER, PROTECTED_ORIGIN, PUBLIC_ORIGIN, recoveryHarness, settle } from './browser-secret-recovery.testutil';

const OTHER_ORIGIN = 'https://test-only-other-protected.example';
const OPERATION_ID = 'op-test-only-0001';
const protectedTab = { version: 2, origins: [PROTECTED_ORIGIN, OTHER_ORIGIN], tabs: { '42': PROTECTED_ORIGIN, '77': OTHER_ORIGIN } };

let commandCount = 0;
function command(name: string, payload: Record<string, unknown> = {}, tabId = 42): TestCommand {
  commandCount += 1;
  return { id: `cmd-${commandCount}`, command: name, target: { tabId }, payload, timeoutMs: 5000 };
}

async function ready(stored: unknown = protectedTab) {
  const h = recoveryHarness(stored);
  await settle();
  await h.setGatewayEnabled(true);
  h.tabs.set(77, { id: 77, windowId: 7, url: OTHER_ORIGIN + '/', title: 'Other' });
  return h;
}

type Harness = Awaited<ReturnType<typeof ready>>;

async function review(h: Harness, payload: Record<string, unknown> = {}, tabId = 42) {
  const reply = await h.run(command('secret_protection_review', payload, tabId));
  expect(reply['ok']).toBe(true);
  return reply['result'] as {
    state: string; origins?: string[]; affectedTabCount?: number;
    writeGeneration?: string; reviewToken?: string;
  };
}

function release(h: Harness, reviewed: Awaited<ReturnType<typeof review>>, overrides: Record<string, unknown> = {}, tabId = 42) {
  return h.run(command('release_secret_observation', {
    operationId: OPERATION_ID,
    reviewToken: reviewed.reviewToken,
    origins: reviewed.origins,
    writeGeneration: reviewed.writeGeneration,
    ...overrides,
  }, tabId));
}

describe('Harness secret protection recovery (shipped extension)', () => {
  it('reviews a protected tab through the native runner without any page-controlled data', async () => {
    const h = await ready();
    h.tabs.get(42)!.url = PUBLIC_ORIGIN + '/?value=' + MARKER;
    h.tabs.get(42)!.title = MARKER;
    const reviewed = await review(h);
    expect(reviewed).toEqual({
      state: 'protected',
      origins: [PROTECTED_ORIGIN],
      affectedTabCount: 1,
      writeGeneration: expect.any(String),
      reviewToken: expect.any(String),
    });
    expect(JSON.stringify(reviewed)).not.toContain(MARKER);
    // A legacy state had no generation; review gives it one and stores it.
    expect(h.storage['browserGatewaySecretTaints']).toMatchObject({ writeGeneration: reviewed.writeGeneration });
  });

  it('releases only the reviewed origin and its tabs, keeping everything else', async () => {
    const h = await ready();
    const reviewed = await review(h);
    const reply = await release(h, reviewed);
    expect(reply).toMatchObject({ ok: true, result: { released: true, alreadyApplied: false, clearedTabCount: 1 } });
    expect([...h.secretTaintedOrigins]).toEqual([OTHER_ORIGIN]);
    expect([...h.secretTaintedTabs.entries()]).toEqual([['77', OTHER_ORIGIN]]);
    expect(h.storage['browserGatewaySecretTaints']).toEqual({
      version: 2,
      origins: [OTHER_ORIGIN],
      tabs: { '77': OTHER_ORIGIN },
      writeGeneration: reviewed.writeGeneration,
      recoveryReceipts: [{ operationId: OPERATION_ID, clearedTabCount: 1 }],
    });
    // The operator setting and the sharing switch are untouched.
    expect(h.protectionEnabled()).toBe(true);
    expect(h.enabled()).toBe(true);
    // The released tab can be read again; the other protected tab cannot.
    await expect(h.assertSecretObservationAllowed(command('snapshot'))).resolves.toBeUndefined();
    await expect(h.assertSecretObservationAllowed(command('snapshot', {}, 77))).rejects.toThrow('blocked_for_tainted_origin');
  });

  it('returns the stored receipt for a replayed operation instead of releasing again', async () => {
    const h = await ready();
    const reviewed = await review(h);
    await release(h, reviewed);
    const replay = await release(h, reviewed, { reviewToken: 'not-a-current-token' });
    expect(replay).toMatchObject({ ok: true, result: { released: true, alreadyApplied: true, clearedTabCount: 1 } });
    expect([...h.secretTaintedOrigins]).toEqual([OTHER_ORIGIN]);
  });

  it('keeps the receipt across a service-worker restart', async () => {
    const h = await ready();
    const reviewed = await review(h);
    await release(h, reviewed);
    const restarted = await ready(h.storage['browserGatewaySecretTaints']);
    const replay = await release(restarted, reviewed);
    expect(replay).toMatchObject({ ok: true, result: { alreadyApplied: true } });
  });

  it.each([
    ['an unknown token', { reviewToken: 'test-only-unknown-token' }],
    ['other origins', { origins: [OTHER_ORIGIN] }],
    ['an extra origin', { origins: [OTHER_ORIGIN, PROTECTED_ORIGIN] }],
    ['another generation', { writeGeneration: 'test-only-generation' }],
  ])('refuses a release with %s and keeps protection', async (_label, overrides) => {
    const h = await ready();
    const reviewed = await review(h);
    const reply = await release(h, reviewed, overrides);
    expect(reply).toMatchObject({ ok: false, error: 'secret_release_review_invalid' });
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    if (!('reviewToken' in overrides)) {
      // The presented token is spent even by a refused attempt.
      expect(await release(h, reviewed)).toMatchObject({ ok: false, error: 'secret_release_review_invalid' });
    }
  });

  it('refuses a review used on another tab, a reused review, and an expired review', async () => {
    const h = await ready();
    const wrongTab = await review(h);
    expect(await release(h, wrongTab, {}, 77)).toMatchObject({ ok: false, error: 'secret_release_review_invalid' });

    const used = await review(h);
    await release(h, used, { operationId: 'op-test-only-0002' });
    const reused = await release(h, used, { operationId: 'op-test-only-0003' });
    expect(reused).toMatchObject({ ok: false, error: 'secret_release_review_invalid' });

    const later = await ready();
    const expired = await review(later);
    later.advanceTime(2 * 60_000 + 1);
    expect(await release(later, expired)).toMatchObject({ ok: false, error: 'secret_release_review_invalid' });
    expect(later.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  it('refuses after any new secret write, even to the same origin and tab', async () => {
    const h = await ready();
    const reviewed = await review(h);
    await h.markSecretTaint(42, PROTECTED_ORIGIN);
    expect(h.writeGeneration()).not.toBe(reviewed.writeGeneration);
    expect(await release(h, reviewed)).toMatchObject({ ok: false, error: 'secret_release_review_invalid' });
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  it('refuses when the operator switched protection off or reset it after the review', async () => {
    const off = await ready();
    const offReview = await review(off);
    await off.applySecretObservationProtectionEnabled(false);
    expect(await release(off, offReview)).toMatchObject({ ok: false, error: 'secret_release_review_invalid' });

    const reset = await ready();
    const resetReview = await review(reset);
    await reset.setGatewayEnabled(false);
    const popup = await reset.status();
    expect((await reset.reset(popup.reviewToken)).ok).toBe(true);
    await reset.setGatewayEnabled(true);
    expect(await release(reset, resetReview)).toMatchObject({ ok: false, error: 'secret_release_review_invalid' });
  });

  it('keeps protection when the narrowed state cannot be stored', async () => {
    const h = await ready();
    const reviewed = await review(h);
    h.chrome.storage.local.set.mockRejectedValueOnce(new Error(MARKER));
    const reply = await release(h, reviewed);
    expect(reply).toEqual(expect.objectContaining({ ok: false, error: 'secret_release_failed_or_may_have_applied' }));
    expect(JSON.stringify(reply)).not.toContain(MARKER);
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    expect(h.secretTaintedTabs.get('42')).toBe(PROTECTED_ORIGIN);
  });

  it('includes tabs opened from the protected tab and every protected frame in one review', async () => {
    const h = await ready();
    h.tabs.set(43, { id: 43, windowId: 7, url: PUBLIC_ORIGIN + '/child', title: 'Child', openerTabId: 42 });
    await expect(h.secretTaintOriginForTab(h.tabs.get(43)!)).resolves.toBe(PROTECTED_ORIGIN);
    h.chrome.scripting.executeScript.mockImplementation(async (input: { func: { name: string }; target: { tabId: number } }): Promise<ScriptResult[]> => {
      if (input.func.name === 'credentialFrameOriginProbe') {
        return input.target.tabId === 42
          ? [{ frameId: 0, result: { origin: PUBLIC_ORIGIN } }, { frameId: 3, result: { origin: OTHER_ORIGIN } }]
          : [{ frameId: 0, result: { origin: new URL(h.tabs.get(input.target.tabId)!.url).origin } }];
      }
      return [{ frameId: 0, result: { title: MARKER, text: MARKER } }];
    });
    const reviewed = await review(h);
    expect(reviewed.origins).toEqual([OTHER_ORIGIN, PROTECTED_ORIGIN].sort());
    expect(reviewed.affectedTabCount).toBe(3);
    const reply = await release(h, reviewed);
    expect(reply).toMatchObject({ ok: true, result: { clearedTabCount: 3 } });
    expect(h.secretTaintedOrigins.size).toBe(0);
  });

  it('refuses a release when another tab inherited protection after the review', async () => {
    const h = await ready();
    const reviewed = await review(h);
    h.tabs.set(43, { id: 43, windowId: 7, url: PUBLIC_ORIGIN + '/child', title: 'Child', openerTabId: 42 });
    await h.secretTaintOriginForTab(h.tabs.get(43)!);
    expect(await release(h, reviewed)).toMatchObject({ ok: false, error: 'secret_release_state_changed' });
    expect(h.secretTaintedTabs.get('43')).toBe(PROTECTED_ORIGIN);
  });

  it('keeps a mark that another read added while the release was being stored', async () => {
    const h = await ready();
    const reviewed = await review(h);
    const write = h.chrome.storage.local.set.getMockImplementation()!;
    h.chrome.storage.local.set.mockImplementationOnce(async (values: Record<string, unknown>) => {
      // A read outside the shared boundary inherits the other site's protection meanwhile.
      h.secretTaintedTabs.set('44', OTHER_ORIGIN);
      await write(values);
    });
    expect(await release(h, reviewed)).toMatchObject({ ok: true });
    expect(h.secretTaintedTabs.get('44')).toBe(OTHER_ORIGIN);
    expect((h.storage['browserGatewaySecretTaints'] as { tabs: Record<string, string> }).tabs['44']).toBe(OTHER_ORIGIN);
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(false);
  });

  describe('with automatic release in play', () => {
    const VALUE = 'TEST_ONLY_FILLED_VALUE_9c1e';
    interface AutoRelease {
      rememberSecretValueCheck: (origin: string, value: string) => Promise<void>;
      releaseSecretProtectionIfClear: (command: TestCommand) => Promise<void>;
      withheldIfSecretReturned: (command: TestCommand, result: unknown) => Promise<Error | null>;
    }
    async function autoReleasedThenFilledAgain() {
      const h = await ready({ version: 2, origins: [], tabs: {} });
      const auto = h.context as unknown as AutoRelease;
      let pageTexts = [VALUE];
      const realExecute = h.chrome.scripting.executeScript.getMockImplementation()!;
      h.chrome.scripting.executeScript.mockImplementation(async (input: { func: { name: string }; target: { tabId: number } }) => (
        input.func.name === 'secretResidueProbe'
          ? [{ frameId: 0, result: { complete: true, texts: pageTexts } }]
          : realExecute(input as never)));
      h.tabs.set(42, { id: 42, windowId: 7, url: PROTECTED_ORIGIN + '/login', title: 'Sign in' });
      // First sign-in: filled, then the page moves on and protection lifts by itself.
      await auto.rememberSecretValueCheck(PROTECTED_ORIGIN, VALUE);
      await h.markSecretTaint(42, PROTECTED_ORIGIN);
      h.tabs.set(42, { id: 42, windowId: 7, url: PROTECTED_ORIGIN + '/home', title: 'Home' });
      pageTexts = ['Welcome'];
      await auto.releaseSecretProtectionIfClear(command('snapshot'));
      expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(false);
      expect(h.storage['browserGatewaySecretAutoReleasedOrigins']).toContain(PROTECTED_ORIGIN);
      // Second sign-in: filled again, and the page still shows the value.
      h.tabs.set(42, { id: 42, windowId: 7, url: PROTECTED_ORIGIN + '/login', title: 'Sign in' });
      pageTexts = [VALUE];
      await auto.rememberSecretValueCheck(PROTECTED_ORIGIN, VALUE);
      await h.markSecretTaint(42, PROTECTED_ORIGIN);
      return { h, auto };
    }

    it('keeps the user\'s release: a later read is neither withheld nor protected again', async () => {
      const { h, auto } = await autoReleasedThenFilledAgain();
      const reviewed = await review(h);
      expect(await release(h, reviewed)).toMatchObject({ ok: true, result: { released: true } });
      // The site leaves automatic-release tracking in the same write.
      expect(h.storage['browserGatewaySecretAutoReleasedOrigins']).not.toContain(PROTECTED_ORIGIN);
      expect(await auto.withheldIfSecretReturned(command('snapshot'), { text: VALUE })).toBeNull();
      expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(false);
      // Deep reads are covered by the user's consent too, with no popup step.
      await expect(h.assertSecretObservationAllowed(command('evaluate'))).resolves.toBeUndefined();
    });

    it('keeps a site released as a whole after a restart, while a tab kept locked on its own stays locked', async () => {
      // Stored after an automatic release that kept tab 77 locked on its own.
      const h = await ready({ version: 2, origins: [], tabs: { '77': PROTECTED_ORIGIN } });
      h.tabs.set(42, { id: 42, windowId: 7, url: PROTECTED_ORIGIN + '/home', title: 'Home' });
      h.chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0, result: { origin: PROTECTED_ORIGIN } }]);
      await expect(h.assertSecretObservationAllowed(command('snapshot'))).resolves.toBeUndefined();
      await expect(h.assertSecretObservationAllowed(command('snapshot', {}, 77))).rejects.toThrow('blocked_for_tainted_origin');
      expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(false);
    });

    it('lets the user lift the deep-read lock left on a site released automatically before a restart', async () => {
      // After a restart: the site was released automatically, and the written values are forgotten.
      const h = await ready({ version: 2, origins: [], tabs: {} });
      h.storage['browserGatewaySecretAutoReleasedOrigins'] = [PROTECTED_ORIGIN];
      h.tabs.set(42, { id: 42, windowId: 7, url: PROTECTED_ORIGIN + '/documents', title: 'Documents' });
      h.chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0, result: { origin: PROTECTED_ORIGIN } }]);
      await expect(h.assertSecretObservationAllowed(command('snapshot'))).resolves.toBeUndefined();
      const refused = await h.assertSecretObservationAllowed(command('download_file')).catch((error: unknown) => String(error));
      expect(refused).toContain('browser.recover_secret_observation');
      expect(refused).not.toContain('popup');
      const reviewed = await review(h);
      expect(reviewed).toMatchObject({ state: 'protected', origins: [PROTECTED_ORIGIN], affectedTabCount: 0 });
      expect(await release(h, reviewed)).toMatchObject({ ok: true, result: { released: true, clearedTabCount: 0 } });
      await expect(h.assertSecretObservationAllowed(command('download_file'))).resolves.toBeUndefined();
      expect(h.storage['browserGatewaySecretAutoReleasedOrigins']).not.toContain(PROTECTED_ORIGIN);
      // The check afterwards sees nothing left to release.
      expect(await review(h)).toEqual({ state: 'not_protected' });
    });

    it('keeps a Harness review of another site when one site is released automatically', async () => {
      const { h, auto } = await autoReleasedThenFilledAgain();
      await h.markSecretTaint(77, OTHER_ORIGIN);
      const other = await review(h, {}, 77);
      expect(other.origins).toEqual([OTHER_ORIGIN]);
      h.tabs.set(42, { id: 42, windowId: 7, url: PROTECTED_ORIGIN + '/home', title: 'Home' });
      h.chrome.scripting.executeScript.mockImplementation(async (input: { func: { name: string }; target: { tabId: number } }) => (
        input.func.name === 'secretResidueProbe'
          ? [{ frameId: 0, result: { complete: true, texts: ['Welcome'] } }]
          : [{ frameId: 0, result: { origin: new URL(h.tabs.get(input.target.tabId)!.url).origin } }]));
      await auto.releaseSecretProtectionIfClear(command('snapshot'));
      expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(false);
      expect(await release(h, other, {}, 77)).toMatchObject({ ok: true, result: { released: true } });
    });
  });

  it('reports a tab it cannot inspect as unavailable and an unprotected tab as not protected', async () => {
    const h = await ready({ version: 2, origins: [PROTECTED_ORIGIN], tabs: {} });
    h.chrome.scripting.executeScript.mockRejectedValue(new Error(MARKER));
    const unavailable = await review(h);
    expect(unavailable).toEqual({ state: 'inspection_unavailable' });
    h.chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0, result: { origin: PUBLIC_ORIGIN } }]);
    expect(await review(h)).toEqual({ state: 'not_protected' });
  });

  it('reports protection switched off without issuing a review', async () => {
    const h = await ready();
    await h.applySecretObservationProtectionEnabled(false);
    expect(await review(h)).toEqual({ state: 'protection_off' });
  });

  it('rejects malformed release payloads with a fixed code', async () => {
    const h = await ready();
    const reviewed = await review(h);
    for (const overrides of [{ operationId: 'x' }, { origins: [] }, { reviewToken: 7 }, { writeGeneration: null }]) {
      expect(await release(h, reviewed, overrides)).toMatchObject({ ok: false, error: 'secret_release_payload_invalid' });
    }
  });

  it('never lets page-derived exceptions through the recovery commands', () => {
    const h = recoveryHarness();
    const forged = new Error('secret_release_review_invalid ' + MARKER);
    expect(h.browserCommandErrorMessage(command('release_secret_observation'), forged, true))
      .toBe('secret_release_failed_or_may_have_applied');
    expect(h.browserCommandErrorMessage(command('secret_protection_review'), forged, true))
      .toBe('secret_protection_review_failed');
  });

  it('points a blocked read at the Harness recovery tool, not the popup', async () => {
    const h = await ready();
    const error = await h.assertSecretObservationAllowed(command('snapshot')).catch((e: unknown) => e);
    expect(String(error)).toContain('browser.recover_secret_observation');
    expect(String(error)).not.toContain('popup');
  });
});
