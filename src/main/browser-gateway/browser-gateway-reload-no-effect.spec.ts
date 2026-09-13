import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import type { Page } from 'puppeteer-core';
import {
  BrowserClickRequestSchema,
  BrowserEvaluateRequestSchema,
  BrowserReloadRequestSchema,
} from '@contracts/schemas/browser';
import { makeGrant, makeService, makeTarget } from './browser-gateway-service.test-helpers';
import { fingerprintBrowserElementText } from './browser-element-text-fingerprint';
import { validateBrowserRpcPayload } from './browser-rpc-server-support';

const existingTab = {
  profileId: 'existing-tab:7:42',
  targetId: 'existing-tab:7:42:target',
  tabId: 42,
  windowId: 7,
  title: 'Before',
  url: 'https://portal.example.test/opportunity',
  origin: 'https://portal.example.test',
  text: '11:55 Greenwich Mean Time\nBefore text',
  allowedOrigins: [{
    scheme: 'https' as const,
    hostPattern: 'portal.example.test',
    includeSubdomains: false,
  }],
};

const context = {
  instanceId: 'instance-1',
  provider: 'copilot',
  profileId: existingTab.profileId,
  targetId: existingTab.targetId,
};

function navigationGrant() {
  return makeGrant({
    profileId: existingTab.profileId,
    allowedOrigins: existingTab.allowedOrigins,
    allowedActionClasses: ['navigate'],
  });
}

function inputGrant() {
  return makeGrant({
    profileId: existingTab.profileId,
    allowedOrigins: existingTab.allowedOrigins,
  });
}

describe('browser.reload and effect verification', () => {
  it('keeps reload target-only and rejects a URL', () => {
    expect(BrowserReloadRequestSchema.safeParse({ profileId: 'p', targetId: 't' }).success).toBe(true);
    expect(BrowserReloadRequestSchema.safeParse({
      profileId: 'p', targetId: 't', url: 'https://other.example.test',
    }).success).toBe(false);
    expect(() => validateBrowserRpcPayload('browser.reload', {
      profileId: 'p', targetId: 't', url: 'https://other.example.test',
    })).toThrow('Invalid browser gateway RPC payload');
  });

  it('accepts explicit click/evaluate effect expectations and rejects an empty expectChange', () => {
    expect(BrowserClickRequestSchema.safeParse({
      profileId: 'p', targetId: 't', selector: '#save', expectUrlChange: true,
      expectChange: { selector: '#status', urlContains: '/done' },
    }).success).toBe(true);
    expect(BrowserEvaluateRequestSchema.safeParse({
      profileId: 'p', targetId: 't', expression: 'save()', expectChange: { selector: '#status' },
    }).success).toBe(true);
    expect(BrowserClickRequestSchema.safeParse({
      profileId: 'p', targetId: 't', selector: '#save', expectChange: {},
    }).success).toBe(false);
  });

  it('uses navigate-class approval and does not dispatch reload without it', async () => {
    const sendCommand = vi.fn();
    const { service, approvalRequests } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.reload(context);

    expect(result).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.reload', action: 'reload', actionClass: 'navigate',
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('reloads the existing tab in place and returns refreshed bounded evidence', async () => {
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      url: existingTab.url,
      title: 'After',
      text: `12:03 Greenwich Mean Time\n${'safe '.repeat(80)}`,
      inspectionState: 'readable',
    }));
    const { service } = makeService({
      existingTab,
      grants: [navigationGrant()],
      extensionCommandStore: { sendCommand },
    });

    const result = await service.reload(context);

    expect(result).toMatchObject({
      decision: 'allowed', outcome: 'succeeded',
      data: {
        url: existingTab.url,
        title: 'After',
        clockText: '12:03 Greenwich Mean Time',
      },
    });
    expect((result.data as { text?: string }).text?.length).toBeLessThanOrEqual(200);
    expect(sendCommand).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'reload',
      target: expect.objectContaining({ tabId: 42 }),
      payload: { expectedOrigin: existingTab.origin },
    }));
  });

  it.each([
    {
      inspectionState: 'inspection_unavailable' as const,
      textUnavailableReason: 'browser_secret_inspection_unavailable',
      title: 'Tab inspection unavailable',
    },
    {
      inspectionState: 'secret_tainted' as const,
      textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin',
      title: 'Secret-filled tab',
    },
  ])('exposes a successful reload with $inspectionState observation state', async ({
    inspectionState, textUnavailableReason, title,
  }) => {
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      url: `${existingTab.origin}/`,
      title,
      text: '',
      inspectionState,
      textUnavailableReason,
    }));
    const { service } = makeService({
      existingTab,
      grants: [navigationGrant()],
      extensionCommandStore: { sendCommand },
    });

    const result = await service.reload(context);

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { inspectionState, textUnavailableReason },
    });
  });

  it('redacts the refreshed URL and finds the clock from full text before bounding its preview', async () => {
    const marker = 'TEST_ONLY_RELOAD_URL_SECRET';
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      url: `${existingTab.url}?token=${marker}#${marker}`,
      title: 'After',
      text: `${'safe '.repeat(60)}\n12:03 Greenwich Mean Time`,
      inspectionState: 'readable',
    }));
    const { service } = makeService({
      existingTab,
      grants: [navigationGrant()],
      extensionCommandStore: { sendCommand },
    });

    const result = await service.reload(context);

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { clockText: '12:03 Greenwich Mean Time' },
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect((result.data as { text: string }).text.length).toBeLessThanOrEqual(200);
  });

  it('denies a reload whose fresh payload crosses the allowed origin', async () => {
    const sendCommand = vi.fn(async () => ({
      tabId: 42, windowId: 7, url: 'https://evil.example.test/', title: 'Moved', text: 'moved',
    }));
    const { service } = makeService({
      existingTab,
      grants: [navigationGrant()],
      extensionCommandStore: { sendCommand },
    });

    const result = await service.reload(context);

    // The reload was dispatched, so post-origin enforcement must report an
    // allowed-but-failed action rather than falsely claiming it did not run.
    expect(result).toMatchObject({ decision: 'allowed', outcome: 'failed' });
  });

  it('fails a no-effect click with before/after URL, title and text evidence after one dispatch', async () => {
    const snapshot = {
      tabId: 42, windowId: 7, url: existingTab.url, title: 'Before', text: 'Before text',
      inspectionState: 'readable',
    };
    const sendCommand = vi.fn(async (request: { command: string }) => (
      request.command === 'click' ? { clicked: true } : snapshot
    ));
    const { service } = makeService({
      existingTab,
      grants: [inputGrant()],
      extensionCommandStore: { sendCommand },
    });

    const result = await service.click({
      ...context,
      selector: '#save',
      expectUrlChange: true,
    });

    expect(result).toMatchObject({
      decision: 'allowed', outcome: 'failed', reason: 'browser_click_no_effect',
      data: {
        before: { url: existingTab.url, title: 'Before', text: 'Before text' },
        after: { url: existingTab.url, title: 'Before', text: 'Before text' },
        suggestedAction: 'browser.reload',
      },
    });
    expect(sendCommand.mock.calls.filter(([request]) => request.command === 'click')).toHaveLength(1);
  });

  it('never uses or exposes a post-dispatch shared-tab observation outside allowed origins', async () => {
    const marker = 'TEST_ONLY_OUTSIDE_ORIGIN_MARKER';
    const safeSnapshot = {
      tabId: 42, windowId: 7, url: existingTab.url, title: 'Before', text: 'Before text',
      inspectionState: 'readable',
    };
    let snapshots = 0;
    const sendCommand = vi.fn(async (request: { command: string }) => {
      if (request.command === 'click') return { clicked: true };
      snapshots += 1;
      return snapshots === 1 ? safeSnapshot : {
        ...safeSnapshot,
        url: 'https://evil.example.test/private?token=' + marker,
        title: marker,
        text: marker,
      };
    });
    const { service } = makeService({
      existingTab,
      grants: [inputGrant()],
      extensionCommandStore: { sendCommand },
    });

    const result = await service.click({ ...context, selector: '#save', expectUrlChange: true });

    expect(result).toMatchObject({
      decision: 'allowed', outcome: 'failed',
      reason: 'browser_effect_observation_origin_not_allowed',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(sendCommand.mock.calls.filter(([request]) => request.command === 'click')).toHaveLength(1);
  });

  it('cannot treat a secret-taint URL substitution as a verified URL change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(600_000);
    try {
      let snapshots = 0;
      const sendCommand = vi.fn(async (request: { command: string }) => {
        if (request.command === 'click') return { clicked: true };
        snapshots += 1;
        return snapshots === 1 ? {
          tabId: 42, windowId: 7, url: `${existingTab.origin}/page#edit`,
          title: 'Portal', text: 'Page', inspectionState: 'readable',
        } : {
          tabId: 42, windowId: 7, url: `${existingTab.origin}/`,
          title: 'Secret-filled tab', text: '', inspectionState: 'secret_tainted',
          textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin',
        };
      });
      const { service } = makeService({
        existingTab: { ...existingTab, url: `${existingTab.origin}/page#edit` },
        grants: [inputGrant()], extensionCommandStore: { sendCommand },
        mutationEffectDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });

      const result = await service.click({
        ...context, selector: '#save', expectUrlChange: true,
      });

      expect(result).toMatchObject({
        outcome: 'failed', reason: 'browser_effect_observation_unverified',
      });
      expect(result.reason).not.toBe('browser_click_no_effect');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports selector verification as unverified when page text is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(700_000);
    try {
      let snapshots = 0;
      const sendCommand = vi.fn(async (request: { command: string }) => {
        if (request.command === 'click') return { clicked: true };
        snapshots += 1;
        return snapshots === 1 ? {
          tabId: 42, windowId: 7, url: existingTab.url, title: 'Portal', text: 'Ready',
          selectorText: 'Ready', selectorFingerprint: 'a'.repeat(64),
          inspectionState: 'readable',
        } : {
          tabId: 42, windowId: 7, url: existingTab.url, title: 'Portal', text: '',
          inspectionState: 'readable', textUnavailableReason: 'host_permission_denied',
        };
      });
      const { service } = makeService({
        existingTab, grants: [inputGrant()], extensionCommandStore: { sendCommand },
        mutationEffectDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });

      const result = await service.click({
        ...context, selector: '#save', expectChange: { selector: '#status' },
      });

      expect(result).toMatchObject({
        outcome: 'failed', reason: 'browser_effect_observation_unverified',
      });
      expect(result.reason).not.toBe('browser_click_no_effect');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a managed mutation when its baseline snapshot is outside allowed origins', async () => {
    const marker = 'TEST_ONLY_MANAGED_OUTSIDE_ORIGIN';
    const { service, driver } = makeService({
      grants: [makeGrant()],
      snapshot: async () => ({
        url: `https://evil.example.test/private?token=${marker}`,
        title: marker,
        text: marker,
      }),
    });

    const result = await service.click({
      instanceId: 'instance-1', provider: 'copilot',
      profileId: 'profile-1', targetId: 'target-1', selector: '#save', expectUrlChange: true,
    });

    expect(result).toMatchObject({
      decision: 'allowed', outcome: 'failed',
      reason: 'browser_effect_observation_origin_not_allowed',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('bounds the post-dispatch no-effect window by elapsed time including slow observations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const snapshot = {
        tabId: 42, windowId: 7, url: existingTab.url, title: 'Before', text: 'Before text',
        inspectionState: 'readable',
      };
      let dispatchedAt: number | undefined;
      const sendCommand = vi.fn(async (request: { command: string }) => {
        if (request.command === 'click') {
          dispatchedAt = Date.now();
          return { clicked: true };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 110));
        return snapshot;
      });
      const { service } = makeService({
        existingTab,
        grants: [inputGrant()],
        extensionCommandStore: { sendCommand },
        mutationEffectDelay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      const startedAt = Date.now();
      let settledAt: number | undefined;
      const pending = service.click({
        ...context, selector: '#save', expectUrlChange: true,
      }).then((result) => {
        settledAt = Date.now();
        return result;
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toMatchObject({ reason: 'browser_click_no_effect' });
      expect(settledAt! - dispatchedAt!).toBeLessThanOrEqual(2_100);
      expect(settledAt! - startedAt).toBeLessThanOrEqual(2_200);
      expect(sendCommand.mock.calls.filter(([request]) => request.command === 'click')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reserves a fresh post-dispatch observation window after a slow successful mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    try {
      let url = `${existingTab.origin}/edit`;
      let snapshotCount = 0;
      const sendCommand = vi.fn(async (request: { command: string }) => {
        if (request.command === 'click') {
          await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
          url = `${existingTab.origin}/done`;
          return { clicked: true };
        }
        snapshotCount += 1;
        return {
          tabId: 42, windowId: 7, url, title: 'Portal', text: 'Page',
          inspectionState: 'readable',
        };
      });
      const { service } = makeService({
        existingTab: { ...existingTab, url },
        grants: [inputGrant()],
        extensionCommandStore: { sendCommand },
        mutationEffectDelay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      const pending = service.click({
        ...context, selector: '#save', expectUrlChange: true,
      });

      await vi.advanceTimersByTimeAsync(2_100);
      const result = await pending;

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(snapshotCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports observation as unverified when no fresh post-dispatch snapshot settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300_000);
    try {
      let snapshotCount = 0;
      const writeJournal = {
        recordIntent: vi.fn().mockResolvedValue(9),
        recordOutcome: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      };
      const persistenceSentinel = {
        needsPreWriteCheck: vi.fn(() => false),
        scan: vi.fn().mockResolvedValue({ state: 'ok', checkedAt: 1 }),
        forgetTarget: vi.fn(),
      };
      const sendCommand = vi.fn(async (request: { command: string }) => {
        if (request.command === 'click') return { clicked: true };
        snapshotCount += 1;
        if (snapshotCount > 1) return new Promise(() => undefined);
        return {
          tabId: 42, windowId: 7, url: existingTab.url, title: 'Portal', text: 'Page',
          inspectionState: 'readable',
        };
      });
      const { service } = makeService({
        existingTab,
        grants: [inputGrant()],
        extensionCommandStore: { sendCommand },
        mutationEffectDelay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        persistenceSentinel,
        writeJournal,
      });
      const pending = service.click({
        ...context, selector: '#save', expectUrlChange: true,
      });

      await vi.advanceTimersByTimeAsync(2_100);
      const result = await pending;

      expect(result).toMatchObject({
        decision: 'allowed', outcome: 'failed',
        reason: 'browser_effect_observation_unverified',
      });
      expect(result.reason).not.toBe('browser_click_no_effect');
      expect(writeJournal.recordOutcome).toHaveBeenLastCalledWith(expect.objectContaining({
        seq: 9, outcome: 'failed', reason: 'browser_effect_observation_unverified',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects a URL fragment change even when both evidence URLs redact identically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(400_000);
    try {
      let url = `${existingTab.origin}/page#edit`;
      const sendCommand = vi.fn(async (request: { command: string }) => {
        if (request.command === 'click') {
          url = `${existingTab.origin}/page#done`;
          return { clicked: true };
        }
        return {
          tabId: 42, windowId: 7, url, title: 'Portal', text: 'Page',
          inspectionState: 'readable',
        };
      });
      const { service } = makeService({
        existingTab: { ...existingTab, url },
        grants: [inputGrant()],
        extensionCommandStore: { sendCommand },
        mutationEffectDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });

      const result = await service.click({
        ...context, selector: '#save', expectUrlChange: true,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(JSON.stringify(result)).not.toContain('#edit');
      expect(JSON.stringify(result)).not.toContain('#done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects selector changes beyond the bounded preview using only fingerprints', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(500_000);
    try {
      const selectorText = 'x'.repeat(1_000);
      let snapshotCount = 0;
      const sendCommand = vi.fn(async (request: { command: string }) => {
        if (request.command === 'click') return { clicked: true };
        snapshotCount += 1;
        return {
          tabId: 42, windowId: 7, url: existingTab.url, title: 'Portal', text: 'Page',
          selectorText,
          selectorFingerprint: snapshotCount === 1 ? 'a'.repeat(64) : 'b'.repeat(64),
          inspectionState: 'readable',
        };
      });
      const { service } = makeService({
        existingTab,
        grants: [inputGrant()],
        extensionCommandStore: { sendCommand },
        mutationEffectDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });

      const result = await service.click({
        ...context, selector: '#save', expectChange: { selector: '#status' },
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
      expect(JSON.stringify(result)).not.toContain('b'.repeat(64));
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the managed pre-redaction full-text fingerprint for selector effects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(800_000);
    try {
      let fingerprints = 0;
      const { service } = makeService({
        grants: [makeGrant()],
        snapshot: async () => ({
          title: 'Local', url: 'http://localhost:4567', text: 'Page',
        }),
        inspectElement: async () => ({ visibleText: 'x'.repeat(2_000) }),
        fingerprintElementText: async () => (
          fingerprints++ === 0 ? 'a'.repeat(64) : 'b'.repeat(64)
        ),
        mutationEffectDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });

      const result = await service.click({
        instanceId: 'instance-1', provider: 'copilot',
        profileId: 'profile-1', targetId: 'target-1', selector: '#save',
        expectChange: { selector: '#status' },
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
      expect(JSON.stringify(result)).not.toContain('b'.repeat(64));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { baselineSubtle: true, observationSubtle: false, direction: 'secure to insecure' },
    { baselineSubtle: false, observationSubtle: true, direction: 'insecure to secure' },
  ])('does not report a selector effect for unchanged text across $direction contexts', async ({
    baselineSubtle, observationSubtle,
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(900_000);
    try {
      let fingerprintCalls = 0;
      const page = {
        $eval: async (
          _selector: string,
          evaluate: (element: { textContent: string }) => unknown,
        ) => {
          const subtleAvailable = fingerprintCalls++ === 0
            ? baselineSubtle
            : observationSubtle;
          return runInNewContext(
            `(${evaluate.toString()})({ textContent: 'unchanged' })`,
            {
              crypto: subtleAvailable ? globalThis.crypto : {},
              TextEncoder: globalThis.TextEncoder,
            },
          );
        },
      };
      const { service } = makeService({
        grants: [makeGrant()],
        snapshot: async () => ({
          title: 'Local', url: 'http://localhost:4567', text: 'Page',
        }),
        inspectElement: async () => ({ visibleText: 'unchanged' }),
        fingerprintElementText: () => fingerprintBrowserElementText(
          page as unknown as Pick<Page, '$eval'>, '#status',
        ),
        mutationEffectDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });

      const result = await service.click({
        instanceId: 'instance-1', provider: 'copilot',
        profileId: 'profile-1', targetId: 'target-1', selector: '#save',
        expectChange: { selector: '#status' },
      });

      expect(result).toMatchObject({
        decision: 'allowed', outcome: 'failed', reason: 'browser_click_no_effect',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report a selector effect when only hidden managed text changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      let fingerprintCalls = 0;
      const page = {
        $eval: async (
          _selector: string,
          evaluate: (element: { innerText: string; textContent: string }) => unknown,
        ) => evaluate({
          innerText: 'Visible',
          textContent: fingerprintCalls++ === 0
            ? 'VisibleHidden child before'
            : 'VisibleHidden child after',
        }),
      };
      const { service } = makeService({
        grants: [makeGrant()],
        snapshot: async () => ({
          title: 'Local', url: 'http://localhost:4567', text: 'Page',
        }),
        inspectElement: async () => ({ visibleText: 'Visible' }),
        fingerprintElementText: () => fingerprintBrowserElementText(
          page as unknown as Pick<Page, '$eval'>, '#status',
        ),
        mutationEffectDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
      });

      const result = await service.click({
        instanceId: 'instance-1', provider: 'copilot',
        profileId: 'profile-1', targetId: 'target-1', selector: '#save',
        expectChange: { selector: '#status' },
      });

      expect(result).toMatchObject({
        decision: 'allowed', outcome: 'failed', reason: 'browser_click_no_effect',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('revises the same durable journal entry when effect verification fails', async () => {
    const snapshot = {
      tabId: 42, windowId: 7, url: existingTab.url, title: 'Before', text: 'Before text',
      inspectionState: 'readable',
    };
    const sendCommand = vi.fn(async (request: { command: string }) => (
      request.command === 'click' ? { clicked: true } : snapshot
    ));
    const writeJournal = {
      recordIntent: vi.fn().mockResolvedValue(7),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };
    const persistenceSentinel = {
      needsPreWriteCheck: vi.fn(() => false),
      scan: vi.fn().mockResolvedValue({ state: 'ok', checkedAt: 1 }),
      forgetTarget: vi.fn(),
    };
    const { service } = makeService({
      existingTab,
      grants: [inputGrant()],
      extensionCommandStore: { sendCommand },
      writeJournal,
      persistenceSentinel,
    });

    const result = await service.click({
      ...context, selector: '#save', expectUrlChange: true,
    });
    await Promise.resolve();

    expect(result).toMatchObject({ reason: 'browser_click_no_effect' });
    expect(writeJournal.recordOutcome).toHaveBeenLastCalledWith(expect.objectContaining({
      seq: 7,
      outcome: 'failed',
      reason: 'browser_click_no_effect',
    }));
  });

  it('waits for a delayed selector-text effect without redispatching the click', async () => {
    const states = ['Pending', 'Pending', 'Saved'];
    const sendCommand = vi.fn(async (request: { command: string }) => {
      if (request.command === 'click') return { clicked: true };
      const selectorText = states.shift() ?? 'Saved';
      return {
        tabId: 42, windowId: 7, url: existingTab.url, title: 'Portal', text: selectorText,
        selectorText, inspectionState: 'readable',
      };
    });
    const { service } = makeService({
      existingTab,
      grants: [inputGrant()],
      extensionCommandStore: { sendCommand },
    });

    const result = await service.click({
      ...context,
      selector: '#save',
      expectChange: { selector: '#status' },
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(sendCommand.mock.calls.filter(([request]) => request.command === 'click')).toHaveLength(1);
  });

  it('applies the same no-effect reason to evaluate and dispatches the expression once', async () => {
    const snapshot = {
      tabId: 42, windowId: 7, url: existingTab.url, title: 'Before', text: 'Before text',
      inspectionState: 'readable',
    };
    const sendCommand = vi.fn(async (request: { command: string }) => (
      request.command === 'evaluate' ? { type: 'undefined' } : snapshot
    ));
    const { service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
      autoApproveRequests: () => true,
    });

    const result = await service.evaluate({
      ...context,
      expression: 'window.save()',
      expectChange: { urlContains: '/done' },
    });

    expect(result).toMatchObject({
      decision: 'allowed', outcome: 'failed', reason: 'browser_click_no_effect',
      data: { suggestedAction: 'browser.reload' },
    });
    expect(sendCommand.mock.calls.filter(([request]) => request.command === 'evaluate')).toHaveLength(1);
  });

  it('flags a managed snapshot when the renderer heartbeat has wedged', async () => {
    const { service } = makeService({ listWedgedTargets: () => ['target-1'] });

    const result = await service.snapshot({ profileId: 'profile-1', targetId: 'target-1' });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { renderer: 'wedged', suggestedAction: 'browser.reload' },
    });
  });

  it('preserves safe wedge recovery metadata when managed snapshot capture fails', async () => {
    const marker = 'TEST_ONLY_FAILED_SNAPSHOT_PAGE_MARKER';
    const target = makeTarget({
      url: `http://localhost:4567/private?token=${marker}#${marker}`,
    });
    const { service } = makeService({
      target,
      listWedgedTargets: () => [target.id],
      snapshot: async () => { throw new Error('renderer_snapshot_timeout'); },
    });

    const result = await service.snapshot({ profileId: 'profile-1', targetId: target.id });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'renderer_snapshot_timeout',
      data: {
        title: 'Snapshot unavailable',
        url: 'http://localhost:4567/',
        text: '',
        renderer: 'wedged',
        suggestedAction: 'browser.reload',
      },
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('keeps a non-wedged managed snapshot failure data-free', async () => {
    const { service } = makeService({
      listWedgedTargets: () => [],
      snapshot: async () => { throw new Error('snapshot_failed'); },
    });

    const result = await service.snapshot({ profileId: 'profile-1', targetId: 'target-1' });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'snapshot_failed',
      data: null,
    });
  });

  it('preserves safe wedge recovery metadata when managed target refresh fails', async () => {
    const marker = 'TEST_ONLY_FAILED_REFRESH_PAGE_MARKER';
    const target = makeTarget({
      url: `http://localhost:4567/private?token=${marker}#${marker}`,
    });
    const { service } = makeService({
      target,
      listWedgedTargets: () => [target.id],
      refreshTarget: async () => { throw new Error('target_refresh_timeout'); },
    });

    const result = await service.snapshot({ profileId: 'profile-1', targetId: target.id });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'target_refresh_timeout',
      data: {
        title: 'Snapshot unavailable',
        url: 'https://redacted.invalid/',
        text: '',
        renderer: 'wedged',
        suggestedAction: 'browser.reload',
      },
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('keeps a non-wedged managed target refresh failure data-free', async () => {
    const { service } = makeService({
      listWedgedTargets: () => [],
      refreshTarget: async () => { throw new Error('target_refresh_failed'); },
    });

    const result = await service.snapshot({ profileId: 'profile-1', targetId: 'target-1' });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'target_refresh_failed',
      data: null,
    });
  });
});
