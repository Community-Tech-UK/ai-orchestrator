import { describe, expect, it, vi } from 'vitest';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import {
  CHALLENGE_RESPONSE_SELECTOR,
  CHALLENGE_WIDGET_SELECTOR,
  createBrowserPageChallengeProbe,
  type BrowserPageChallengeProbeDeps,
} from './browser-page-challenge-probe';

const TARGET = { profileId: 'existing-tab:1:2', targetId: 'existing-tab:1:2:target' };
const CLICK = { ...TARGET, toolName: 'browser.click' };
const ATTACHMENT = { ...TARGET, tabId: 2, windowId: 1, nodeId: 'node-1' } as unknown as BrowserExistingTabAttachment;

function deps(options: {
  attachment?: BrowserExistingTabAttachment | null;
  controls?: Record<string, { value?: string } | 'missing' | Error>;
  coordinatorFresh?: boolean;
  evaluate?: (expression: string) => Promise<unknown>;
  /** Extension bundle on the channel; absent = no runtime evidence (pre-0.2.50 behaviour). */
  extensionVersion?: string;
  codeProbe?: unknown;
}) {
  const sendCommand = vi.fn(async (_tab: unknown, command: string, payload?: Record<string, unknown>) => {
    if (command === 'probe_one_time_code') {
      if (options.codeProbe instanceof Error) throw options.codeProbe;
      return options.codeProbe ?? { codeField: false, filled: false, targetIsCodeField: false };
    }
    const control = options.controls?.[String(payload?.['selector'])] ?? 'missing';
    if (control === 'missing') throw new Error(`No element matches selector: ${String(payload?.['selector'])}`);
    if (control instanceof Error) throw control;
    return control;
  });
  const evaluate = vi.fn(async (_profileId: string, _targetId: string, expression: string, _await: boolean) =>
    (options.evaluate ?? (async () => ({ type: 'object', json: '{"detected":false}' })))(expression));
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
      getExtensionRuntime: () => (options.extensionVersion
        ? { extensionVersion: options.extensionVersion, extensionStartedAt: 1 }
        : undefined),
    },
  } as unknown as BrowserPageChallengeProbeDeps;
  return { probe: createBrowserPageChallengeProbe(probeDeps), sendCommand, evaluate };
}

describe('browser page challenge probe', () => {
  it('costs one read-only command on a shared tab without a challenge widget', async () => {
    const { probe, sendCommand } = deps({ attachment: ATTACHMENT });
    await expect(probe(CLICK)).resolves.toEqual({ detected: false });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(ATTACHMENT, 'read_control', { selector: CHALLENGE_WIDGET_SELECTOR }, 4_000);
  });

  it('detects a visible widget whose response token is empty, and clears once solved', async () => {
    const unsolved = deps({ attachment: ATTACHMENT, controls: { [CHALLENGE_WIDGET_SELECTOR]: {}, [CHALLENGE_RESPONSE_SELECTOR]: { value: '' } } });
    await expect(unsolved.probe(CLICK)).resolves.toEqual({ detected: true });

    const solved = deps({ attachment: ATTACHMENT, controls: { [CHALLENGE_WIDGET_SELECTOR]: {}, [CHALLENGE_RESPONSE_SELECTOR]: { value: 'token-placeholder' } } });
    await expect(solved.probe(CLICK)).resolves.toEqual({ detected: false });
  });

  it('excludes the invisible reCAPTCHA badge from the widget selector', () => {
    expect(CHALLENGE_WIDGET_SELECTOR).toContain(':not([src*="size=invisible"])');
  });

  it('skips a remote channel that is already down and reports other failures as unavailable', async () => {
    const down = deps({ attachment: ATTACHMENT, coordinatorFresh: false });
    await expect(down.probe(CLICK)).resolves.toEqual({ detected: false, unavailable: 'extension_channel_not_fresh' });
    expect(down.sendCommand).not.toHaveBeenCalled();

    const failing = deps({ attachment: ATTACHMENT, controls: { [CHALLENGE_WIDGET_SELECTOR]: new Error('browser_extension_command_not_delivered') } });
    await expect(failing.probe(CLICK)).resolves.toEqual({ detected: false, unavailable: 'browser_extension_command_not_delivered' });
  });

  it('evaluates a fixed read-only expression on managed tabs', async () => {
    const managed = (captcha: unknown) => deps({
      evaluate: async (expression) => expression.includes('oneTimeCodeFieldProbe')
        ? { type: 'object', json: '{"codeField":false,"filled":false,"targetIsCodeField":false}' }
        : captcha,
    });
    const { probe, evaluate, sendCommand } = managed({ type: 'object', json: '{"detected":true}' });
    await expect(probe(CLICK)).resolves.toEqual({
      detected: true,
      oneTimeCode: { codeField: false, filled: false, targetIsCodeField: false },
    });
    expect(evaluate).toHaveBeenCalledWith(TARGET.profileId, TARGET.targetId, expect.stringContaining('g-recaptcha-response'), false);
    expect(sendCommand).not.toHaveBeenCalled();

    const invalid = managed({ type: 'undefined' });
    await expect(invalid.probe(CLICK)).resolves.toMatchObject({ detected: false, unavailable: 'probe_result_invalid' });
  });
});

describe('browser page challenge probe: sign-in code boxes', () => {
  const FILLED = { codeField: true, filled: true, targetIsCodeField: false };

  it('asks a 0.2.50+ extension for code box evidence on a click, beside the CAPTCHA read', async () => {
    const { probe, sendCommand } = deps({ attachment: ATTACHMENT, extensionVersion: '0.2.50', codeProbe: FILLED });

    await expect(probe(CLICK)).resolves.toEqual({ detected: false, oneTimeCode: FILLED });
    expect(sendCommand).toHaveBeenCalledWith(ATTACHMENT, 'probe_one_time_code', {}, 4_000);
  });

  it('never sends the command to an older extension, which would reject it', async () => {
    for (const extensionVersion of [undefined, '0.2.49']) {
      const { probe, sendCommand } = deps({ attachment: ATTACHMENT, extensionVersion, codeProbe: FILLED });

      await expect(probe(CLICK)).resolves.toEqual({ detected: false });
      expect(sendCommand.mock.calls.map(([, command]) => command)).not.toContain('probe_one_time_code');
    }
  });

  it('still checks for a code box when the CAPTCHA read is refused on a password-protected origin', async () => {
    const { probe } = deps({
      attachment: ATTACHMENT,
      extensionVersion: '0.2.50',
      codeProbe: FILLED,
      controls: { [CHALLENGE_WIDGET_SELECTOR]: new Error('browser_secret_observation_blocked_for_tainted_origin: command not run.') },
    });

    await expect(probe(CLICK)).resolves.toEqual({
      detected: false,
      unavailable: 'browser_secret_observation_blocked_for_tainted_origin: command not run.',
      oneTimeCode: FILLED,
    });
  });

  it('keeps a live CAPTCHA when the code box read fails or answers in the wrong shape', async () => {
    const live = { [CHALLENGE_WIDGET_SELECTOR]: {}, [CHALLENGE_RESPONSE_SELECTOR]: { value: '' } };
    const failing = deps({ attachment: ATTACHMENT, extensionVersion: '0.2.50', controls: live, codeProbe: new Error('browser_extension_command_timeout') });
    await expect(failing.probe(CLICK)).resolves.toEqual({ detected: true, unavailable: 'browser_extension_command_timeout' });

    for (const codeProbe of [{ codeField: 'yes', filled: true, targetIsCodeField: false }, { ...FILLED, value: 'x' }, null]) {
      const odd = deps({ attachment: ATTACHMENT, extensionVersion: '0.2.50', controls: live, codeProbe: codeProbe ?? 'null' });
      await expect(odd.probe(CLICK)).resolves.toEqual({ detected: true, unavailable: 'one_time_code_probe_result_invalid' });
    }
  });

  it('sends a typed or filled field\'s selectors and skips the CAPTCHA read for field entry', async () => {
    const { probe, sendCommand } = deps({
      attachment: ATTACHMENT,
      extensionVersion: '0.2.50',
      codeProbe: { codeField: true, filled: false, targetIsCodeField: true },
    });

    await expect(probe({ ...TARGET, toolName: 'browser.fill_form', inputTargets: { selectors: ['#email', '#code'], uids: [] } }))
      .resolves.toEqual({ detected: false, oneTimeCode: { codeField: true, filled: false, targetIsCodeField: true } });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(ATTACHMENT, 'probe_one_time_code', { selector: '#email, #code' }, 4_000);
  });

  it('treats an accessibility uid target as a code box while one is visible', async () => {
    const visible = deps({ attachment: ATTACHMENT, extensionVersion: '0.2.50', codeProbe: { codeField: true, filled: false, targetIsCodeField: false } });
    await expect(visible.probe({ ...TARGET, toolName: 'browser.type', inputTargets: { selectors: [], uids: ['41'] } }))
      .resolves.toMatchObject({ oneTimeCode: { targetIsCodeField: true } });

    const none = deps({ attachment: ATTACHMENT, extensionVersion: '0.2.50' });
    await expect(none.probe({ ...TARGET, toolName: 'browser.type', inputTargets: { selectors: [], uids: ['41'] } }))
      .resolves.toMatchObject({ oneTimeCode: { targetIsCodeField: false } });
  });

  it('sends uid targets to the extension, which answers the password box question for them', async () => {
    const { probe, sendCommand } = deps({
      attachment: ATTACHMENT,
      extensionVersion: '0.2.51',
      codeProbe: { codeField: false, filled: false, targetIsCodeField: false, targetIsPasswordField: true },
    });

    await expect(probe({ ...TARGET, toolName: 'browser.fill_form', inputTargets: { selectors: ['#user'], uids: ['41'] } }))
      .resolves.toEqual({
        detected: false,
        oneTimeCode: { codeField: false, filled: false, targetIsCodeField: false },
        passwordField: true,
      });
    expect(sendCommand).toHaveBeenCalledWith(ATTACHMENT, 'probe_one_time_code', { selector: '#user', uids: ['41'] }, 4_000);
  });

  it('leaves the password box unknown when an 0.2.50 extension answers only the code box', async () => {
    const { probe } = deps({ attachment: ATTACHMENT, extensionVersion: '0.2.50' });
    const evidence = await probe({ ...TARGET, toolName: 'browser.type', inputTargets: { selectors: ['#p'], uids: [] } });
    expect(evidence).not.toHaveProperty('passwordField');
  });

  it('takes the managed page function\'s password answer for selector targets only', async () => {
    const answer = async () => ({ type: 'object', json: '{"codeField":false,"filled":false,"targetIsCodeField":false,"targetIsPasswordField":false}' });
    const { probe } = deps({ evaluate: answer });

    await expect(probe({ ...TARGET, toolName: 'browser.type', inputTargets: { selectors: ['#user'], uids: [] } }))
      .resolves.toMatchObject({ passwordField: false });
    // The page function cannot resolve a uid, so "false" would be a guess.
    expect(await probe({ ...TARGET, toolName: 'browser.type', inputTargets: { selectors: ['#user'], uids: ['41'] } }))
      .not.toHaveProperty('passwordField');
  });

  it('probes nothing for tools that neither act on the page nor write fields', async () => {
    const { probe, sendCommand, evaluate } = deps({ attachment: ATTACHMENT, extensionVersion: '0.2.50', codeProbe: FILLED });
    await expect(probe({ ...TARGET, toolName: 'browser.select' })).resolves.toEqual({ detected: false });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('runs the same page function on managed tabs with the target selector', async () => {
    const { probe, evaluate } = deps({
      evaluate: async () => ({ type: 'object', json: '{"codeField":true,"filled":false,"targetIsCodeField":true}' }),
    });

    await expect(probe({ ...TARGET, toolName: 'browser.type', inputTargets: { selectors: ['#code'], uids: [] } }))
      .resolves.toEqual({ detected: false, oneTimeCode: { codeField: true, filled: false, targetIsCodeField: true } });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(TARGET.profileId, TARGET.targetId, expect.stringMatching(/oneTimeCodeFieldProbe[\s\S]*\("#code"\)$/), false);
  });
});
