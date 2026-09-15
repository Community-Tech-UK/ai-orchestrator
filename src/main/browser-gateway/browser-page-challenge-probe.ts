/**
 * Page-level CAPTCHA evidence for the action guard (plan
 * 2026-09-15-worker-stale-socket-close-loop §3.4). The classifier used to see
 * only the agent's own actionHint on shared tabs, so a descriptive hint such as
 * "Enable the reCAPTCHA Enterprise API" parked ordinary clicks, while
 * `browser.evaluate` skipped the CAPTCHA rules entirely.
 *
 * A LIVE challenge is a visible interactive widget (reCAPTCHA v2 checkbox,
 * hCaptcha checkbox, Turnstile) whose response token is still empty. The
 * invisible v3 badge and a widget the human already solved do not count.
 *
 * Read-only: shared tabs use the existing `read_control` extension command
 * (no extension rebuild needed); managed tabs evaluate a fixed expression.
 */

import type { BrowserElementContext } from '@contracts/types/browser';
import {
  classifyBrowserAction,
  withPageChallengeEvidence,
  type BrowserActionClassification,
  type BrowserPageChallengeEvidence,
} from './browser-action-classifier';
import type { BrowserExtensionContactStateReader } from './browser-extension-contact-state';
import { isRemoteExtensionContactFresh } from './browser-extension-node-contact';
import type { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import type { BrowserExistingTabAttachment, BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';

export const CHALLENGE_WIDGET_SELECTOR = [
  'iframe[src*="/recaptcha/api2/anchor"]:not([src*="size=invisible"])',
  'iframe[src*="/recaptcha/enterprise/anchor"]:not([src*="size=invisible"])',
  'iframe[src*="hcaptcha.com"][src*="frame=checkbox"]',
  'iframe[src*="challenges.cloudflare.com"]',
].join(', ');

export const CHALLENGE_RESPONSE_SELECTOR = [
  'textarea[name="g-recaptcha-response"]',
  'textarea[name="h-captcha-response"]',
  'input[name="cf-turnstile-response"]',
].join(', ');

/** Tools that act on the page and therefore must not act on a live challenge. */
export const PAGE_CHALLENGE_GATED_TOOLS: ReadonlySet<string> = new Set(['browser.click', 'browser.evaluate']);

// Under 5s so the command store treats it as a fast probe (no 90s undelivered wait).
const EXTENSION_PROBE_TIMEOUT_MS = 4_000;
const NOT_FOUND_MESSAGE = 'No element matches selector';

export const MANAGED_CHALLENGE_PROBE_EXPRESSION = `(() => {
  const widget = Array.from(document.querySelectorAll(${JSON.stringify(CHALLENGE_WIDGET_SELECTOR)}))
    .find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!widget) return { detected: false };
  const response = document.querySelector(${JSON.stringify(CHALLENGE_RESPONSE_SELECTOR)});
  return { detected: !response || !response.value };
})()`;

export interface BrowserPageChallengeProbeDeps {
  extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab'>;
  driver: Pick<PuppeteerBrowserDriver, 'evaluate'>;
  existingTabOperations: Pick<BrowserExistingTabOperations, 'sendCommand'>;
  extensionContactState: BrowserExtensionContactStateReader;
}

export type BrowserPageChallengeProbe = (target: {
  profileId: string;
  targetId: string;
}) => Promise<BrowserPageChallengeEvidence>;

export function createBrowserPageChallengeProbe(deps: BrowserPageChallengeProbeDeps): BrowserPageChallengeProbe {
  return async ({ profileId, targetId }) => {
    const attachment = deps.extensionTabStore.getTab(profileId, targetId);
    try {
      if (!attachment) {
        return parseManagedEvidence(
          await deps.driver.evaluate(profileId, targetId, MANAGED_CHALLENGE_PROBE_EXPRESSION, false),
        );
      }
      if (
        attachment.nodeId
        && !isRemoteExtensionContactFresh(attachment.nodeId, { extensionContactState: deps.extensionContactState })
      ) {
        return { detected: false, unavailable: 'extension_channel_not_fresh' };
      }
      const widget = await readControl(deps, attachment, CHALLENGE_WIDGET_SELECTOR);
      if (!widget.found) {
        return { detected: false };
      }
      const response = await readControl(deps, attachment, CHALLENGE_RESPONSE_SELECTOR);
      return { detected: !response.found || !response.value };
    } catch (error) {
      return { detected: false, unavailable: error instanceof Error ? error.message.slice(0, 200) : 'probe_failed' };
    }
  };
}

/**
 * The action guard's classification step: element classification (or the
 * caller's fixed override, e.g. browser.evaluate), then page challenge
 * evidence for the tools that act on the page.
 */
export async function classifyGuardedBrowserAction(input: {
  probe?: BrowserPageChallengeProbe;
  profileId: string;
  targetId: string;
  toolName: string;
  actionHint?: string;
  elementContext?: BrowserElementContext;
  elementContextSource: 'inspected' | 'agent_hint';
  override?: BrowserActionClassification;
}): Promise<BrowserActionClassification> {
  const base = input.override ?? classifyBrowserAction({
    toolName: input.toolName,
    actionHint: input.actionHint,
    elementContext: input.elementContext,
    elementContextSource: input.elementContextSource,
  });
  if (!input.probe || !PAGE_CHALLENGE_GATED_TOOLS.has(input.toolName)) {
    return base;
  }
  return withPageChallengeEvidence(base, await input.probe({ profileId: input.profileId, targetId: input.targetId }));
}

async function readControl(
  deps: BrowserPageChallengeProbeDeps,
  attachment: BrowserExistingTabAttachment,
  selector: string,
): Promise<{ found: boolean; value?: string }> {
  try {
    const raw = await deps.existingTabOperations.sendCommand(
      attachment,
      'read_control',
      { selector },
      EXTENSION_PROBE_TIMEOUT_MS,
    );
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['value'] : undefined;
    return { found: true, ...(typeof value === 'string' ? { value } : {}) };
  } catch (error) {
    if (error instanceof Error && error.message.includes(NOT_FOUND_MESSAGE)) {
      return { found: false };
    }
    throw error;
  }
}

/** The managed driver returns `{ type, json }` (JSON-serialized return value). */
function parseManagedEvidence(raw: unknown): BrowserPageChallengeEvidence {
  const json = raw && typeof raw === 'object' ? (raw as { json?: unknown }).json : undefined;
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) as unknown : undefined;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { detected?: unknown }).detected === 'boolean') {
      return { detected: (parsed as { detected: boolean }).detected };
    }
  } catch {
    // fall through
  }
  return { detected: false, unavailable: 'probe_result_invalid' };
}
