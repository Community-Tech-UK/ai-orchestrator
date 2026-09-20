import { describe, expect, it, vi } from 'vitest';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import {
  CHALLENGE_RESPONSE_SELECTOR,
  CHALLENGE_WIDGET_SELECTOR,
  createBrowserPageChallengeProbe,
  type BrowserPageChallengeProbeDeps,
} from './browser-page-challenge-probe';

const TARGET = { profileId: 'existing-tab:1:2', targetId: 'existing-tab:1:2:target' };
const ATTACHMENT = { ...TARGET, tabId: 2, windowId: 1, nodeId: 'node-1' } as unknown as BrowserExistingTabAttachment;

function deps(options: {
  attachment?: BrowserExistingTabAttachment | null;
  controls?: Record<string, { value?: string } | 'missing' | Error>;
  coordinatorFresh?: boolean;
  evaluate?: () => Promise<unknown>;
}) {
  const sendCommand = vi.fn(async (_tab: unknown, _command: string, payload?: Record<string, unknown>) => {
    const control = options.controls?.[String(payload?.['selector'])] ?? 'missing';
    if (control === 'missing') throw new Error(`No element matches selector: ${String(payload?.['selector'])}`);
    if (control instanceof Error) throw control;
    return control;
  });
  const evaluate = vi.fn(options.evaluate ?? (async () => ({ type: 'object', json: '{"detected":false}' })));
  const probeDeps = {
    extensionTabStore: { getTab: () => options.attachment ?? null },
    driver: { evaluate },
    existingTabOperations: { sendCommand },
    extensionContactState: {
      // Both reads derive from one timestamp, as the real contact state does.
      // They used to disagree here (no contact recorded, yet "fresh"), which
      // only went unnoticed while freshness had a fast path on the boolean.
      getLastExtensionContactAt: () =>
        (options.coordinatorFresh ?? true) ? Date.now() : Date.now() - 10 * 60_000,
      isExtensionContactFresh: () => options.coordinatorFresh ?? true,
      describeExtensionContact: (nodeId: string) => ({ nodeId, silent: false }),
      getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
    },
  } as unknown as BrowserPageChallengeProbeDeps;
  return { probe: createBrowserPageChallengeProbe(probeDeps), sendCommand, evaluate };
}

describe('browser page challenge probe', () => {
  it('costs one read-only command on a shared tab without a challenge widget', async () => {
    const { probe, sendCommand } = deps({ attachment: ATTACHMENT });
    await expect(probe(TARGET)).resolves.toEqual({ detected: false });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(ATTACHMENT, 'read_control', { selector: CHALLENGE_WIDGET_SELECTOR }, 4_000);
  });

  it('detects a visible widget whose response token is empty, and clears once solved', async () => {
    const unsolved = deps({ attachment: ATTACHMENT, controls: { [CHALLENGE_WIDGET_SELECTOR]: {}, [CHALLENGE_RESPONSE_SELECTOR]: { value: '' } } });
    await expect(unsolved.probe(TARGET)).resolves.toEqual({ detected: true });

    const solved = deps({ attachment: ATTACHMENT, controls: { [CHALLENGE_WIDGET_SELECTOR]: {}, [CHALLENGE_RESPONSE_SELECTOR]: { value: 'token-placeholder' } } });
    await expect(solved.probe(TARGET)).resolves.toEqual({ detected: false });
  });

  it('excludes the invisible reCAPTCHA badge from the widget selector', () => {
    expect(CHALLENGE_WIDGET_SELECTOR).toContain(':not([src*="size=invisible"])');
  });

  it('skips a remote channel that is already down and reports other failures as unavailable', async () => {
    const down = deps({ attachment: ATTACHMENT, coordinatorFresh: false });
    await expect(down.probe(TARGET)).resolves.toEqual({ detected: false, unavailable: 'extension_channel_not_fresh' });
    expect(down.sendCommand).not.toHaveBeenCalled();

    const failing = deps({ attachment: ATTACHMENT, controls: { [CHALLENGE_WIDGET_SELECTOR]: new Error('browser_extension_command_not_delivered') } });
    await expect(failing.probe(TARGET)).resolves.toEqual({ detected: false, unavailable: 'browser_extension_command_not_delivered' });
  });

  it('evaluates a fixed read-only expression on managed tabs', async () => {
    const { probe, evaluate, sendCommand } = deps({ evaluate: async () => ({ type: 'object', json: '{"detected":true}' }) });
    await expect(probe(TARGET)).resolves.toEqual({ detected: true });
    expect(evaluate).toHaveBeenCalledWith(TARGET.profileId, TARGET.targetId, expect.stringContaining('g-recaptcha-response'), false);
    expect(sendCommand).not.toHaveBeenCalled();

    const invalid = deps({ evaluate: async () => ({ type: 'undefined' }) });
    await expect(invalid.probe(TARGET)).resolves.toEqual({ detected: false, unavailable: 'probe_result_invalid' });
  });
});
