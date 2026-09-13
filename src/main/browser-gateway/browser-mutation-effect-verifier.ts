import { createHash } from 'node:crypto';
import type {
  BrowserAllowedOrigin,
  BrowserClickRequest,
  BrowserEvaluateRequest,
  BrowserGatewayResult,
  BrowserMutationEffectExpectation,
  BrowserMutationEffectState,
  BrowserMutationNoEffectEvidence,
} from '@contracts/types/browser';
import { isOriginAllowed } from './browser-origin-policy';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import type { BrowserGatewayPreparedMutation } from './browser-gateway-action-guard';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext, BrowserGatewayTargetRequest } from './browser-gateway-service-types';
import { extractTabPayload } from './browser-gateway-service-helpers';
import { redactBrowserText, redactBrowserUrl } from './browser-redaction';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';

export type BrowserRequestedMutationEffect = BrowserMutationEffectExpectation & {
  expectUrlChange?: boolean;
};

const EFFECT_POLL_TIMEOUT_MS = 2_000;
const EFFECT_POLL_INTERVAL_MS = 100;
const EFFECT_DEADLINE_ERROR = 'browser_effect_observation_deadline_exceeded';
const EFFECT_ORIGIN_ERROR = 'browser_effect_observation_origin_not_allowed';
const EFFECT_UNVERIFIED_ERROR = 'browser_effect_observation_unverified';

interface BrowserMutationEffectObservation {
  evidence: BrowserMutationEffectState;
  comparison: {
    url: BrowserMutationEffectDimension;
    selector: BrowserMutationEffectDimension;
  };
}

interface BrowserMutationEffectDimension {
  available: boolean;
  fingerprint?: string;
  matched?: boolean;
}

interface BrowserMutationEffectVerifierDeps {
  driver: Pick<
    PuppeteerBrowserDriver,
    'snapshot' | 'inspectElement' | 'fingerprintElementText'
  >;
  existingTabOperations: Pick<BrowserExistingTabOperations, 'sendCommand'>;
  delay: (ms: number) => Promise<void>;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

export class BrowserMutationEffectVerifier {
  constructor(private readonly deps: BrowserMutationEffectVerifierDeps) {}

  deadline(): number {
    return Date.now() + EFFECT_POLL_TIMEOUT_MS;
  }

  expectationFor(
    request: Pick<BrowserClickRequest | BrowserEvaluateRequest, 'expectUrlChange' | 'expectChange'>,
  ): BrowserRequestedMutationEffect | null {
    if (request.expectUrlChange !== true && !request.expectChange) return null;
    return {
      ...(request.expectUrlChange === true ? { expectUrlChange: true } : {}),
      ...(request.expectChange?.selector ? { selector: request.expectChange.selector } : {}),
      ...(request.expectChange?.urlContains ? { urlContains: request.expectChange.urlContains } : {}),
    };
  }

  async capture(
    request: BrowserGatewayTargetRequest,
    attachment: BrowserExistingTabAttachment | undefined,
    expectation: BrowserRequestedMutationEffect,
    allowedOrigins: BrowserAllowedOrigin[],
    deadlineAt?: number,
  ): Promise<BrowserMutationEffectObservation> {
    if (attachment) {
      const raw = await this.withDeadline(
        this.deps.existingTabOperations.sendCommand(
          attachment, 'snapshot', expectation.selector
            ? { selector: expectation.selector }
            : undefined,
          this.remainingTimeout(deadlineAt, 1_000),
        ),
        deadlineAt,
      );
      const tab = extractTabPayload(raw);
      assertAllowedObservationOrigin(tab.url, allowedOrigins);
      const selectorText = raw && typeof raw === 'object' && !Array.isArray(raw)
        && typeof (raw as Record<string, unknown>)['selectorText'] === 'string'
        ? (raw as Record<string, string>)['selectorText']
        : undefined;
      const selectorFingerprint = readSelectorFingerprint(raw);
      const urlAvailable = tab.inspectionState !== 'secret_tainted'
        && tab.inspectionState !== 'inspection_unavailable';
      const selectorAvailable = urlAvailable
        && !tab.textUnavailableReason
        && (selectorFingerprint !== undefined || selectorText !== undefined);
      return observation(
        tab.url, tab.title ?? '', tab.text ?? '', selectorText, expectation, selectorFingerprint,
        { url: urlAvailable, selector: selectorAvailable },
      );
    }
    let snapshot = await this.withDeadline(
      this.deps.driver.snapshot(request.profileId, request.targetId),
      deadlineAt,
    );
    assertAllowedObservationOrigin(snapshot.url, allowedOrigins);
    let selectorText: string | undefined;
    let selectorFingerprint: string | undefined;
    if (expectation.selector) {
      selectorFingerprint = await this.withDeadline(
        this.deps.driver.fingerprintElementText(
          request.profileId, request.targetId, expectation.selector,
        ),
        deadlineAt,
      );
      const inspected = await this.withDeadline(
        this.deps.driver.inspectElement(
          request.profileId, request.targetId, expectation.selector,
        ),
        deadlineAt,
      );
      selectorText = inspected.visibleText ?? inspected.accessibleName;
      snapshot = await this.withDeadline(
        this.deps.driver.snapshot(request.profileId, request.targetId),
        deadlineAt,
      );
      assertAllowedObservationOrigin(snapshot.url, allowedOrigins);
    }
    return observation(
      snapshot.url, snapshot.title, snapshot.text, selectorText, expectation, selectorFingerprint,
      { url: true, selector: selectorFingerprint !== undefined },
    );
  }

  async wait(
    request: BrowserGatewayTargetRequest,
    attachment: BrowserExistingTabAttachment | undefined,
    expectation: BrowserRequestedMutationEffect,
    before: BrowserMutationEffectObservation,
    allowedOrigins: BrowserAllowedOrigin[],
    deadlineAt: number,
  ): Promise<BrowserMutationEffectObservation> {
    let latest: BrowserMutationEffectObservation | undefined;
    while (Date.now() < deadlineAt) {
      try {
        latest = await this.capture(
          request, attachment, expectation, allowedOrigins, deadlineAt,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === EFFECT_ORIGIN_ERROR) throw error;
        if (message === EFFECT_DEADLINE_ERROR && latest) return latest;
        throw new Error(EFFECT_UNVERIFIED_ERROR);
      }
      if (this.occurred(expectation, before, latest)) return latest;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return latest;
      await this.deps.delay(Math.min(EFFECT_POLL_INTERVAL_MS, remainingMs));
    }
    if (!latest) throw new Error(EFFECT_UNVERIFIED_ERROR);
    return latest;
  }

  occurred(
    expectation: BrowserRequestedMutationEffect,
    before: BrowserMutationEffectObservation,
    after: BrowserMutationEffectObservation,
  ): boolean {
    return Boolean(
      (expectation.expectUrlChange
        && dimensionChanged(before.comparison.url, after.comparison.url))
      || (expectation.selector
        && dimensionChanged(before.comparison.selector, after.comparison.selector))
      || (expectation.urlContains
        && before.comparison.url.available && after.comparison.url.available
        && before.comparison.url.matched === false && after.comparison.url.matched === true),
    );
  }

  async failureIfMissing(
    request: BrowserGatewayContext & BrowserGatewayTargetRequest,
    attachment: BrowserExistingTabAttachment | undefined,
    expectation: BrowserRequestedMutationEffect | null,
    before: BrowserMutationEffectObservation | null,
    action: 'click' | 'evaluate',
    toolName: 'browser.click' | 'browser.evaluate',
    prepared: BrowserGatewayPreparedMutation,
  ): Promise<BrowserGatewayResult<BrowserMutationNoEffectEvidence | null> | null> {
    if (!expectation || !before) return null;
    let after: BrowserMutationEffectObservation;
    try {
      after = await this.wait(
        request, attachment, expectation, before, prepared.grant.allowedOrigins,
        this.deadline(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = message === EFFECT_ORIGIN_ERROR ? EFFECT_ORIGIN_ERROR : EFFECT_UNVERIFIED_ERROR;
      return this.unverifiedResult(request, action, toolName, prepared, before, reason);
    }
    if (this.occurred(expectation, before, after)) return null;
    if (!allRequestedDimensionsObservable(expectation, before, after)) {
      return this.unverifiedResult(
        request, action, toolName, prepared, before, EFFECT_UNVERIFIED_ERROR,
      );
    }
    return this.noEffectResult(
      request, action, toolName, prepared, before.evidence, after.evidence,
    );
  }

  private unverifiedResult(
    request: BrowserGatewayContext & BrowserGatewayTargetRequest,
    action: 'click' | 'evaluate',
    toolName: 'browser.click' | 'browser.evaluate',
    prepared: BrowserGatewayPreparedMutation,
    before: BrowserMutationEffectObservation,
    reason: typeof EFFECT_ORIGIN_ERROR | typeof EFFECT_UNVERIFIED_ERROR,
  ): BrowserGatewayResult<BrowserMutationNoEffectEvidence | null> {
    return this.deps.result<BrowserMutationNoEffectEvidence | null>({
      context: request, profileId: request.profileId, targetId: request.targetId,
      action, toolName, actionClass: prepared.actionClass,
      decision: 'allowed', outcome: 'failed', reason,
      summary: `${toolName} dispatched but its post-action effect could not be verified`,
      origin: prepared.origin, url: before.evidence.url, grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous, data: null,
    });
  }

  noEffectResult(
    request: BrowserGatewayContext & BrowserGatewayTargetRequest,
    action: 'click' | 'evaluate',
    toolName: 'browser.click' | 'browser.evaluate',
    prepared: BrowserGatewayPreparedMutation,
    before: BrowserMutationEffectState,
    after: BrowserMutationEffectState,
  ): BrowserGatewayResult<BrowserMutationNoEffectEvidence> {
    return this.deps.result({
      context: request, profileId: request.profileId, targetId: request.targetId,
      action, toolName, actionClass: prepared.actionClass,
      decision: 'allowed', outcome: 'failed', reason: 'browser_click_no_effect',
      summary: `${toolName} dispatched exactly once but none of the requested effects occurred`,
      origin: prepared.origin, url: after.url, grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data: { before, after, suggestedAction: 'browser.reload' },
    });
  }

  private remainingTimeout(deadlineAt: number | undefined, fallbackMs: number): number {
    return deadlineAt === undefined
      ? fallbackMs
      : Math.max(1, Math.min(fallbackMs, deadlineAt - Date.now()));
  }

  private withDeadline<T>(operation: Promise<T>, deadlineAt: number | undefined): Promise<T> {
    if (deadlineAt === undefined) return operation;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return Promise.reject(new Error(EFFECT_DEADLINE_ERROR));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(EFFECT_DEADLINE_ERROR)), remainingMs);
    });
    return Promise.race([operation, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}

function assertAllowedObservationOrigin(url: string, allowedOrigins: BrowserAllowedOrigin[]): void {
  if (!isOriginAllowed(url, allowedOrigins).allowed) throw new Error(EFFECT_ORIGIN_ERROR);
}

function safeState(
  url: string,
  title: string,
  text: string,
  selectorText?: string,
): BrowserMutationEffectState {
  return {
    url: redactBrowserUrl(url).slice(0, 2_000),
    title: redactBrowserText(title).slice(0, 500),
    text: redactBrowserText(text).slice(0, 200),
    ...(selectorText !== undefined
      ? { selectorText: redactBrowserText(selectorText).slice(0, 1_000) }
      : {}),
  };
}

function observation(
  url: string,
  title: string,
  text: string,
  selectorText: string | undefined,
  expectation: BrowserRequestedMutationEffect,
  providedSelectorFingerprint?: string,
  availability: { url: boolean; selector: boolean } = { url: true, selector: true },
): BrowserMutationEffectObservation {
  return {
    evidence: safeState(url, title, text, selectorText),
    comparison: {
      url: {
        available: availability.url,
        ...(availability.url ? {
          fingerprint: fingerprint(url),
          matched: Boolean(expectation.urlContains && url.includes(expectation.urlContains)),
        } : {}),
      },
      selector: {
        available: availability.selector,
        ...(availability.selector
          && (providedSelectorFingerprint !== undefined || selectorText !== undefined)
          ? { fingerprint: providedSelectorFingerprint ?? fingerprint(selectorText!) }
          : {}),
      },
    },
  };
}

function dimensionChanged(
  before: BrowserMutationEffectDimension,
  after: BrowserMutationEffectDimension,
): boolean {
  return before.available && after.available
    && before.fingerprint !== undefined && after.fingerprint !== undefined
    && before.fingerprint !== after.fingerprint;
}

function allRequestedDimensionsObservable(
  expectation: BrowserRequestedMutationEffect,
  before: BrowserMutationEffectObservation,
  after: BrowserMutationEffectObservation,
): boolean {
  const dimensions = [
    ...(expectation.expectUrlChange || expectation.urlContains
      ? [before.comparison.url.available && after.comparison.url.available]
      : []),
    ...(expectation.selector
      ? [before.comparison.selector.available && after.comparison.selector.available]
      : []),
  ];
  return dimensions.length > 0 && dimensions.every(Boolean);
}

function readSelectorFingerprint(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = (raw as Record<string, unknown>)['selectorFingerprint'];
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate)
    ? candidate
    : undefined;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
