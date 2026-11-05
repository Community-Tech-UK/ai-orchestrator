import type { BrowserGatewayResult } from '@contracts/types/browser';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { BrowserGuardedMutationRequest } from './browser-gateway-action-guard.types';
import type { BrowserElementContext } from '@contracts/types/browser';
import {
  classifyBrowserAction,
  ONE_TIME_CODE_ENTRY_TOOLS,
  TWO_FACTOR_CHALLENGE_REASON,
  type BrowserActionClassification,
} from './browser-action-classifier';
import {
  classifyGuardedBrowserAction,
  type BrowserPageChallengeProbe,
  type BrowserProbeInputTargets,
} from './browser-page-challenge-probe';

/**
 * Lets the click that submits a one-time code through, when Harness itself put
 * that code into the page.
 *
 * `browser.fill_credential` can type an emailed code (`email_code`) or a vault
 * TOTP (`totp`) under a standing, human-granted credential authorization, so the
 * model never handles it. The page's own "Verify" / "Validate OTP" button then
 * classifies as a two-factor hard stop, which parks to the escalation queue — and
 * a parked code expires long before anyone can resume it. The British Council
 * supplier registration died exactly there on 2026-10-30.
 *
 * After a successful code fill the ledger holds one entry for that session and
 * tab. A later `browser.click` on the same tab and page origin within the window,
 * that the classifier marks as a two-factor challenge, is classified again with
 * the two-factor words ignored. If that finds nothing else to stop for (password,
 * legal declaration, payment, destructive), the click is what it looks like: the
 * submit of a form the gateway filled, and it is checked as an ordinary submit
 * that still needs a submit grant. The entry is spent only when the guard
 * actually releases the click, so a click that first waits for approval can be
 * retried. Typing into a two-factor field is never affected.
 */

export const ONE_TIME_CODE_SUBMIT_WINDOW_MS = 10 * 60 * 1000;
export const ONE_TIME_CODE_SUBMIT_REASON = 'one_time_code_submit_after_gateway_fill';

export interface OneTimeCodeFillScope {
  instanceId?: string;
  profileId: string;
  targetId: string;
  /** Top-level page origin of the tab, as the action guard sees it. */
  origin: string;
}

export class BrowserOneTimeCodeFillLedger {
  private readonly fills = new Map<string, { origin: string; filledAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  record(scope: OneTimeCodeFillScope): void {
    this.fills.set(fillKey(scope), { origin: scope.origin.toLowerCase(), filledAt: this.now() });
  }

  /** Whether a live fill matches this session, tab and origin. Does not spend it. */
  has(scope: OneTimeCodeFillScope): boolean {
    const key = fillKey(scope);
    const fill = this.fills.get(key);
    if (fill && this.now() - fill.filledAt > ONE_TIME_CODE_SUBMIT_WINDOW_MS) {
      this.fills.delete(key);
      return false;
    }
    return fill?.origin === scope.origin.toLowerCase();
  }

  /** Spend the fill once the click that submits it has been released. */
  consume(scope: OneTimeCodeFillScope): void {
    this.fills.delete(fillKey(scope));
  }
}

/** The gateway-filled code a released submit click spends, set during classification. */
export interface OneTimeCodeFillHolder {
  scope?: OneTimeCodeFillScope;
}

function fillKey(scope: OneTimeCodeFillScope): string {
  return [scope.instanceId ?? '', scope.profileId, scope.targetId].join('\u0000');
}

export interface OneTimeCodeSubmitInput {
  ledger: Pick<BrowserOneTimeCodeFillLedger, 'has'> | undefined;
  classification: BrowserActionClassification;
  /** The same element classified again with the two-factor words ignored. */
  classifyWithoutTwoFactor: () => BrowserActionClassification;
  request: BrowserGatewayContext;
  action: string;
  toolName: string;
  scope: Omit<OneTimeCodeFillScope, 'instanceId'> & { url: string };
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

/**
 * Reclassify a two-factor click that submits a gateway-filled code as an
 * ordinary submit, leaving an audit note. Returns the fill to spend once the
 * click is released; any other classification is returned unchanged.
 */
export function classifyOneTimeCodeSubmit(input: OneTimeCodeSubmitInput): {
  classification: BrowserActionClassification;
  codeFill?: OneTimeCodeFillScope;
} {
  const { classification, scope } = input;
  const codeFill: OneTimeCodeFillScope = {
    ...(input.request.instanceId ? { instanceId: input.request.instanceId } : {}),
    profileId: scope.profileId,
    targetId: scope.targetId,
    origin: scope.origin,
  };
  if (
    input.toolName !== 'browser.click' ||
    classification.reason !== TWO_FACTOR_CHALLENGE_REASON ||
    !input.ledger?.has(codeFill)
  ) {
    return { classification };
  }
  // Release only a click that is otherwise unremarkable: anything the two-factor
  // match was hiding (a hard stop, a destructive action, or conflicting evidence
  // that the classifier marks unknown) keeps the original park.
  const otherwise = input.classifyWithoutTwoFactor();
  if (otherwise.hardStop || otherwise.actionClass === 'destructive' || otherwise.actionClass === 'unknown') {
    return { classification };
  }
  input.result({
    context: input.request,
    profileId: scope.profileId,
    targetId: scope.targetId,
    action: input.action,
    toolName: input.toolName,
    actionClass: 'submit',
    decision: 'allowed',
    outcome: 'not_run',
    reason: ONE_TIME_CODE_SUBMIT_REASON,
    summary: `${input.toolName} submits a one-time code that browser.fill_credential typed on this tab, `
      + 'so it is checked as an ordinary submit and still needs a submit grant',
    origin: scope.origin,
    url: scope.url,
    data: null,
  });
  return { classification: { actionClass: 'submit', hardStop: false }, codeFill };
}

/**
 * The action guard's classification: the guarded (page-challenge aware)
 * classifier, then the one-time-code submit check. Puts the fill a released
 * click would spend into `codeFill`.
 */
export async function classifyGuardedActionWithCodeFill(input: {
  probe?: BrowserPageChallengeProbe;
  ledger: OneTimeCodeSubmitInput['ledger'];
  result: OneTimeCodeSubmitInput['result'];
  request: BrowserGuardedMutationRequest;
  action: string;
  toolName: string;
  actionHint?: string;
  override?: BrowserActionClassification;
  elementContext?: BrowserElementContext;
  elementContextSource: 'inspected' | 'agent_hint';
  scope: OneTimeCodeSubmitInput['scope'];
  codeFill: OneTimeCodeFillHolder;
}): Promise<BrowserActionClassification> {
  const { toolName, actionHint, elementContext, elementContextSource, scope } = input;
  const checked = classifyOneTimeCodeSubmit({
    ledger: input.ledger, request: input.request, action: input.action, toolName, scope, result: input.result,
    classification: await classifyGuardedBrowserAction({
      probe: input.probe, profileId: scope.profileId, targetId: scope.targetId, toolName, actionHint,
      elementContext, elementContextSource, override: input.override,
      ...(ONE_TIME_CODE_ENTRY_TOOLS.has(toolName) ? { inputTargets: probeInputTargets(input.request) } : {}),
    }),
    classifyWithoutTwoFactor: () =>
      classifyBrowserAction({ toolName, actionHint, elementContext, elementContextSource, ignoreTwoFactor: true }),
  });
  input.codeFill.scope = checked.codeFill;
  return checked.classification;
}

/** The fields a browser.type / browser.fill_form request writes to. */
export function probeInputTargets(request: BrowserGuardedMutationRequest): BrowserProbeInputTargets {
  const targets = request.fields ?? [{ selector: request.selector, uid: request.uid }];
  return {
    selectors: targets.flatMap((target) => (target.selector ? [target.selector] : [])),
    hasUidTarget: targets.some((target) => Boolean(target.uid)),
  };
}
