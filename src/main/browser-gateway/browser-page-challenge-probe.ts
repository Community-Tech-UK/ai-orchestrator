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
 *
 * Sign-in code box evidence (browser-one-time-code-field-probe.ts) rides the
 * same probe: the extension's boolean-only `probe_one_time_code` command on
 * shared tabs (from bundle 0.2.50; older bundles are not asked) and the same
 * page function on managed tabs.
 */

import type { BrowserElementContext } from '@contracts/types/browser';
import {
  classifyBrowserAction,
  ONE_TIME_CODE_ENTRY_TOOLS,
  PAGE_ACTING_TOOLS,
  withPageChallengeEvidence,
  type BrowserActionClassification,
  type BrowserPageChallengeEvidence,
} from './browser-action-classifier';
import type { BrowserExtensionContactStateReader } from './browser-extension-contact-state';
import { supportsBrowserExtensionOneTimeCodeProbe } from './browser-extension-credential-compatibility';
import { credentialScopeForProfile } from './browser-grant-scope';
import {
  managedOneTimeCodeProbeExpression,
  parseOneTimeCodeEvidence,
  type BrowserOneTimeCodeEvidence,
} from './browser-one-time-code-field-probe';
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

/** Fields a type/fill_form writes to: CSS selectors, plus whether any is an accessibility uid. */
export interface BrowserProbeInputTargets {
  selectors: string[];
  hasUidTarget: boolean;
}

export type BrowserPageChallengeProbe = (target: {
  profileId: string;
  targetId: string;
  toolName: string;
  inputTargets?: BrowserProbeInputTargets;
}) => Promise<BrowserPageChallengeEvidence>;

/** Every tool the probe has evidence for. */
export const PAGE_PROBED_TOOLS: ReadonlySet<string> = new Set([
  ...PAGE_ACTING_TOOLS,
  ...ONE_TIME_CODE_ENTRY_TOOLS,
]);

export function createBrowserPageChallengeProbe(deps: BrowserPageChallengeProbeDeps): BrowserPageChallengeProbe {
  return async ({ profileId, targetId, toolName, inputTargets }) => {
    const attachment = deps.extensionTabStore.getTab(profileId, targetId);
    // CAPTCHA matters only to page-acting tools; code boxes to those and to field entry.
    const wantsChallenge = PAGE_ACTING_TOOLS.has(toolName);
    const wantsCode = PAGE_PROBED_TOOLS.has(toolName);
    const targetSelector = inputTargets?.selectors.join(', ') || undefined;
    try {
      if (!attachment) {
        const evidence: BrowserPageChallengeEvidence = wantsChallenge
          ? parseManagedEvidence(
            await deps.driver.evaluate(profileId, targetId, MANAGED_CHALLENGE_PROBE_EXPRESSION, false),
          )
          : { detected: false };
        if (!wantsCode) return evidence;
        return await withCodeEvidence(evidence, inputTargets, async () => parseManagedJson(
          await deps.driver.evaluate(profileId, targetId, managedOneTimeCodeProbeExpression(targetSelector), false),
        ));
      }
      if (
        attachment.nodeId
        && !isRemoteExtensionContactFresh(
          attachment.nodeId,
          { extensionContactState: deps.extensionContactState },
          attachment.extensionInstanceId,
        )
      ) {
        return { detected: false, unavailable: 'extension_channel_not_fresh' };
      }
      // A refused CAPTCHA read (read_control is blocked on an origin a password
      // fill protected) must not stop the code box check, which still answers there.
      const evidence: BrowserPageChallengeEvidence = wantsChallenge
        ? await readChallenge(deps, attachment).catch((error: unknown) => unavailableEvidence(error))
        : { detected: false };
      if (
        !wantsCode
        || !supportsBrowserExtensionOneTimeCodeProbe(
          deps.extensionContactState,
          credentialScopeForProfile(profileId),
          attachment.extensionInstanceId,
        )
      ) {
        return evidence;
      }
      return await withCodeEvidence(evidence, inputTargets, () => deps.existingTabOperations.sendCommand(
        attachment,
        'probe_one_time_code',
        targetSelector ? { selector: targetSelector } : {},
        EXTENSION_PROBE_TIMEOUT_MS,
      ));
    } catch (error) {
      return unavailableEvidence(error);
    }
  };
}

function unavailableEvidence(error: unknown): BrowserPageChallengeEvidence {
  return { detected: false, unavailable: error instanceof Error ? error.message.slice(0, 200) : 'probe_failed' };
}

async function readChallenge(
  deps: BrowserPageChallengeProbeDeps,
  attachment: BrowserExistingTabAttachment,
): Promise<BrowserPageChallengeEvidence> {
  const widget = await readControl(deps, attachment, CHALLENGE_WIDGET_SELECTOR);
  if (!widget.found) {
    return { detected: false };
  }
  const response = await readControl(deps, attachment, CHALLENGE_RESPONSE_SELECTOR);
  return { detected: !response.found || !response.value };
}

/**
 * Read and attach code box evidence. An accessibility-uid target cannot be
 * resolved in the page, so it counts as a code box whenever one is visible
 * (fails closed). A failed or malformed read adds nothing and is reported as
 * unavailable, without discarding the CAPTCHA evidence already gathered.
 */
async function withCodeEvidence(
  evidence: BrowserPageChallengeEvidence,
  inputTargets: BrowserProbeInputTargets | undefined,
  read: () => Promise<unknown>,
): Promise<BrowserPageChallengeEvidence> {
  let code: BrowserOneTimeCodeEvidence | undefined;
  try {
    code = parseOneTimeCodeEvidence(await read());
  } catch (error) {
    return { ...evidence, unavailable: evidence.unavailable ?? unavailableEvidence(error).unavailable };
  }
  if (!code) {
    return { ...evidence, unavailable: evidence.unavailable ?? 'one_time_code_probe_result_invalid' };
  }
  return {
    ...evidence,
    oneTimeCode: {
      ...code,
      targetIsCodeField: code.targetIsCodeField || (Boolean(inputTargets?.hasUidTarget) && code.codeField),
    },
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
  inputTargets?: BrowserProbeInputTargets;
}): Promise<BrowserActionClassification> {
  const base = input.override ?? classifyBrowserAction({
    toolName: input.toolName,
    actionHint: input.actionHint,
    elementContext: input.elementContext,
    elementContextSource: input.elementContextSource,
  });
  if (!input.probe || !PAGE_PROBED_TOOLS.has(input.toolName)) {
    return base;
  }
  const evidence = await input.probe({
    profileId: input.profileId,
    targetId: input.targetId,
    toolName: input.toolName,
    ...(input.inputTargets ? { inputTargets: input.inputTargets } : {}),
  });
  return withPageChallengeEvidence(base, evidence, input.toolName);
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
function parseManagedJson(raw: unknown): unknown {
  const json = raw && typeof raw === 'object' ? (raw as { json?: unknown }).json : undefined;
  try {
    return typeof json === 'string' ? JSON.parse(json) as unknown : undefined;
  } catch {
    return undefined;
  }
}

function parseManagedEvidence(raw: unknown): BrowserPageChallengeEvidence {
  const parsed = parseManagedJson(raw);
  if (parsed && typeof parsed === 'object' && typeof (parsed as { detected?: unknown }).detected === 'boolean') {
    return { detected: (parsed as { detected: boolean }).detected };
  }
  return { detected: false, unavailable: 'probe_result_invalid' };
}
