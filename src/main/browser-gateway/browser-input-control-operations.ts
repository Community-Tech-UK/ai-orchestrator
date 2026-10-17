/**
 * Browser Gateway input-control operations: `browser.press_key`,
 * `browser.set_viewport`, `browser.set_zoom`.
 *
 * Extracted from the service (see browser-form-fill-operations pattern) so the
 * service stays a thin delegate. Every mutation routes through the action
 * guard exactly like click/type: classification, grants, approvals, exact
 * approval redemption and audit all apply. Read-back of the focused element
 * never carries input values.
 */

import type { BrowserGatewayResult } from '@contracts/types/browser';
import type {
  BrowserPressKeyRequest,
  BrowserPressKeyResult,
  BrowserPressKeyModifier,
  BrowserSetViewportRequest,
  BrowserSetViewportResult,
  BrowserSetZoomRequest,
  BrowserSetZoomResult,
} from '@contracts/schemas/browser';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserExtensionCommandName } from './browser-extension-command-store';
import type { BrowserGatewayActionGuard } from './browser-gateway-action-guard';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { BrowserMutationEffectVerifier } from './browser-mutation-effect-verifier';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';
import { classifyPressKeyAction } from './browser-action-classifier';
import {
  normalizePressKeyResult,
  normalizeSetViewportResult,
  normalizeSetZoomResult,
} from './browser-extension-result-normalizers';

export interface BrowserInputControlDeps {
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  getExistingTab: (
    profileId: string,
    targetId: string,
  ) => BrowserExistingTabAttachment | undefined;
  sendCommand: (
    attachment: BrowserExistingTabAttachment,
    command: BrowserExtensionCommandName,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    onJournaled?: (seq: number) => void,
  ) => Promise<unknown>;
  recordFinalMutationFailure: (
    attachment: BrowserExistingTabAttachment,
    seq: number | undefined,
    reason: string,
  ) => void;
  actionGuard: Pick<
    BrowserGatewayActionGuard,
    'prepareMutatingAction'
    | 'recheckPreparedGrant'
    | 'recordMutationSucceeded'
    | 'mutationFailed'
  >;
  effectVerifier: Pick<
    BrowserMutationEffectVerifier,
    'expectationFor' | 'capture' | 'failureIfMissing' | 'deadline'
  >;
  driver: Pick<PuppeteerBrowserDriver, 'pressKey' | 'viewport'>;
}

export interface BrowserInputControlOperations {
  pressKey(
    request: BrowserGatewayContext & BrowserPressKeyRequest,
  ): Promise<BrowserGatewayResult<BrowserPressKeyResult | null>>;
  setViewport(
    request: BrowserGatewayContext & BrowserSetViewportRequest,
  ): Promise<BrowserGatewayResult<BrowserSetViewportResult | null>>;
  setZoom(
    request: BrowserGatewayContext & BrowserSetZoomRequest,
  ): Promise<BrowserGatewayResult<BrowserSetZoomResult | null>>;
}

/** Shared-tab (extension) zoom only: managed profiles have no browser-zoom surface. */
export const ZOOM_UNSUPPORTED_MANAGED_REASON = 'browser_zoom_requires_shared_extension_tab';
/** Window resize moves the real Chrome window; shared tabs only. */
export const WINDOW_VIEWPORT_UNSUPPORTED_MANAGED_REASON =
  'browser_window_resize_requires_shared_extension_tab';

function isReadViewportRequest(request: BrowserSetViewportRequest): boolean {
  return request.width === undefined && request.height === undefined && request.reset !== true;
}

/**
 * Retry-dedupe state machine for `idempotencyKey` presses, applied to BOTH
 * execution paths (the shared-tab extension keeps its own memory as
 * defense-in-depth). Once a press with a given key has STARTED, a repeat never
 * presses again — a failed or still-unknown outcome returns `applied: false,
 * deduplicated: true` rather than claiming success, and a deliberate re-press
 * must use a NEW idempotencyKey. The memory is bounded and per service
 * process; the extension-side memory covers coordinator restarts.
 */
interface PressKeyMemoryEntry {
  state: 'started' | 'done' | 'failed';
  payload?: BrowserPressKeyResult;
}

const pressKeyDedupeMemory = new Map<string, PressKeyMemoryEntry>();
const PRESS_KEY_DEDUPE_MAX = 100;

function pressKeyDedupeKey(
  request: BrowserGatewayContext & BrowserPressKeyRequest,
): string | undefined {
  return request.idempotencyKey
    ? `${request.profileId}|${request.targetId}|${request.idempotencyKey}`
    : undefined;
}

function rememberPressKeyOutcome(key: string | undefined, entry: PressKeyMemoryEntry): void {
  if (!key) return;
  pressKeyDedupeMemory.delete(key);
  pressKeyDedupeMemory.set(key, entry);
  while (pressKeyDedupeMemory.size > PRESS_KEY_DEDUPE_MAX) {
    const oldest = pressKeyDedupeMemory.keys().next().value;
    if (oldest === undefined) break;
    pressKeyDedupeMemory.delete(oldest);
  }
}

function deduplicatedPressKeyResult(
  request: BrowserGatewayContext & BrowserPressKeyRequest,
  entry: PressKeyMemoryEntry | undefined,
): BrowserPressKeyResult | null {
  if (!entry) return null;
  if (entry.state === 'done' && entry.payload) {
    return { ...entry.payload, deduplicated: true };
  }
  // Started-but-unfinished or failed: never press again, never claim success.
  return {
    applied: false,
    key: request.key,
    modifiers: request.modifiers ?? [],
    deduplicated: true,
  };
}

export function createBrowserInputControlOperations(
  deps: BrowserInputControlDeps,
): BrowserInputControlOperations {
  return {
    pressKey: (request) => pressKey(deps, request),
    setViewport: (request) => setViewport(deps, request),
    setZoom: (request) => setZoom(deps, request),
  };
}

function targetLabel(key: string, modifiers?: readonly BrowserPressKeyModifier[]): string {
  return `key:${modifiers && modifiers.length > 0 ? `${modifiers.join('+')}+` : ''}${key}`;
}

async function pressKey(
  deps: BrowserInputControlDeps,
  request: BrowserGatewayContext & BrowserPressKeyRequest,
): Promise<BrowserGatewayResult<BrowserPressKeyResult | null>> {
  const classification = classifyPressKeyAction({
    key: request.key,
    ...(request.modifiers ? { modifiers: request.modifiers } : {}),
    ...(request.actionHint ? { actionHint: request.actionHint } : {}),
  });
  const prepared = await deps.actionGuard.prepareMutatingAction(
    request,
    'press_key',
    'browser.press_key',
    targetLabel(request.key, request.modifiers),
    request.actionHint,
    classification,
  );
  if (prepared.result) {
    return prepared.result as BrowserGatewayResult<BrowserPressKeyResult | null>;
  }
  const recheck = deps.actionGuard.recheckPreparedGrant(
    request, 'press_key', 'browser.press_key', prepared,
  );
  if (recheck) {
    return recheck as BrowserGatewayResult<BrowserPressKeyResult | null>;
  }

  // Idempotent-activation dedupe (both paths): a repeat with the same
  // idempotencyKey settles the request WITHOUT pressing again. Checked after
  // the guard so a retry can never bypass the approval rules.
  const dedupeKey = pressKeyDedupeKey(request);
  const prior = dedupeKey ? pressKeyDedupeMemory.get(dedupeKey) : undefined;
  if (prior) {
    const data = deduplicatedPressKeyResult(request, prior)!;
    deps.actionGuard.recordMutationSucceeded(prepared);
    return deps.result<BrowserPressKeyResult>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'press_key',
      toolName: 'browser.press_key',
      actionClass: prepared.actionClass,
      decision: 'allowed',
      outcome: data.applied ? 'succeeded' : 'failed',
      ...(data.applied ? {} : { reason: 'press_key_prior_attempt_outcome_unknown' }),
      summary: data.applied
        ? 'browser.press_key duplicate suppressed by idempotencyKey (original press reused)'
        : 'browser.press_key duplicate suppressed by idempotencyKey; the original attempt has no confirmed success (failed or never completed) — this call pressed NOTHING and does not claim it succeeded. Use a NEW idempotencyKey to deliberately press again.',
      origin: prepared.origin,
      url: prepared.url,
      grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data,
    });
  }
  rememberPressKeyOutcome(dedupeKey, { state: 'started' });

  try {
    const existingTab = deps.getExistingTab(request.profileId, request.targetId);
    const effectExpectation = deps.effectVerifier.expectationFor(request);
    const effectBefore = effectExpectation
      ? await deps.effectVerifier.capture(
        request, existingTab, effectExpectation,
        prepared.grant.allowedOrigins, deps.effectVerifier.deadline(),
      )
      : null;
    let journalSeq: number | undefined;
    let data: BrowserPressKeyResult;
    if (existingTab) {
      const raw = await deps.sendCommand(existingTab, 'press_key', {
        key: request.key,
        ...(request.modifiers?.length ? { modifiers: request.modifiers } : {}),
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      }, undefined, (seq) => { journalSeq = seq; });
      data = normalizePressKeyResult(raw);
    } else {
      data = await deps.driver.pressKey(
        request.profileId,
        request.targetId,
        request.key,
        request.modifiers ?? [],
      );
    }
    // A suppression reported by the EXECUTING side (extension memory hit after
    // a coordinator restart) carries the same guarantee as the coordinator
    // dedupe branch: no press happened, and an unfinished/failed original must
    // never be reported as success.
    if (data.deduplicated === true) {
      // This dispatch fired no key: its journal row must not claim a second
      // write (or a write at all) — the write journal is recovery evidence.
      if (existingTab) {
        deps.recordFinalMutationFailure(
          existingTab, journalSeq, 'press_key_deduplicated_no_op',
        );
      }
      if (data.applied !== true) {
        rememberPressKeyOutcome(dedupeKey, { state: 'failed' });
        deps.actionGuard.recordMutationSucceeded(prepared);
        return deps.result<BrowserPressKeyResult>({
          context: request,
          profileId: request.profileId,
          targetId: request.targetId,
          action: 'press_key',
          toolName: 'browser.press_key',
          actionClass: prepared.actionClass,
          decision: 'allowed',
          outcome: 'failed',
          reason: 'press_key_prior_attempt_outcome_unknown',
          summary:
            'browser.press_key duplicate suppressed by idempotencyKey; the original attempt has '
            + 'no confirmed success (failed or never completed) — this call pressed NOTHING and '
            + 'does not claim it succeeded. Use a NEW idempotencyKey to deliberately press again.',
          origin: prepared.origin,
          url: prepared.url,
          grantId: prepared.grant.id,
          autonomous: prepared.grant.autonomous,
          data,
        });
      }
    }
    rememberPressKeyOutcome(dedupeKey, { state: 'done', payload: data });
    const noEffect = await deps.effectVerifier.failureIfMissing(
      request, existingTab, effectExpectation, effectBefore,
      'press_key', 'browser.press_key', prepared,
    );
    if (noEffect) {
      // The call FAILED its effect check: a same-key retry must neither
      // re-press nor upgrade this failure to success.
      rememberPressKeyOutcome(dedupeKey, { state: 'failed' });
      if (existingTab) {
        deps.recordFinalMutationFailure(
          existingTab, journalSeq, noEffect.reason ?? 'browser_press_key_no_effect',
        );
      }
      deps.actionGuard.recordMutationSucceeded(prepared);
      return noEffect as BrowserGatewayResult<BrowserPressKeyResult | null>;
    }
    deps.actionGuard.recordMutationSucceeded(prepared);
    return deps.result<BrowserPressKeyResult>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'press_key',
      toolName: 'browser.press_key',
      actionClass: prepared.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: data.deduplicated
        ? 'browser.press_key duplicate suppressed by idempotencyKey (original press reused)'
        : `browser.press_key pressed ${targetLabel(request.key, request.modifiers)} under approved grant`,
      origin: prepared.origin,
      url: prepared.url,
      grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data,
    });
  } catch (error) {
    // The key is burned even on failure: the press may have partially
    // dispatched, so a same-key retry must not re-fire it.
    rememberPressKeyOutcome(dedupeKey, { state: 'failed' });
    return deps.actionGuard.mutationFailed(
      request, 'press_key', 'browser.press_key', prepared, error,
    ) as BrowserGatewayResult<BrowserPressKeyResult | null>;
  }
}

async function setViewport(
  deps: BrowserInputControlDeps,
  request: BrowserGatewayContext & BrowserSetViewportRequest,
): Promise<BrowserGatewayResult<BrowserSetViewportResult | null>> {
  const existingTab = deps.getExistingTab(request.profileId, request.targetId);
  const scope = request.scope === 'window' ? 'window' : 'tab';
  const readMode = isReadViewportRequest(request);

  if (!existingTab && scope === 'window') {
    return deps.result<BrowserSetViewportResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'set_viewport',
      toolName: 'browser.set_viewport',
      actionClass: 'input',
      decision: 'denied',
      outcome: 'not_run',
      reason: WINDOW_VIEWPORT_UNSUPPORTED_MANAGED_REASON,
      summary:
        'browser.set_viewport window scope resizes the real Chrome window and is only '
        + 'available on shared existing Chrome tabs. Use scope "tab" for per-tab viewport '
        + 'emulation on managed profiles, or a shared tab (browser.find_or_open).',
      data: null,
    });
  }

  if (readMode) {
    return readViewportState(deps, request, existingTab);
  }

  const actionLabel = request.reset === true
    ? `viewport:${scope}:reset`
    : `viewport:${scope}:${request.width}x${request.height}`;
  const prepared = await deps.actionGuard.prepareMutatingAction(
    request,
    'set_viewport',
    'browser.set_viewport',
    actionLabel,
    undefined,
    { actionClass: 'input', hardStop: false },
  );
  if (prepared.result) {
    return prepared.result as BrowserGatewayResult<BrowserSetViewportResult | null>;
  }
  const recheck = deps.actionGuard.recheckPreparedGrant(
    request, 'set_viewport', 'browser.set_viewport', prepared,
  );
  if (recheck) {
    return recheck as BrowserGatewayResult<BrowserSetViewportResult | null>;
  }

  try {
    let data: BrowserSetViewportResult;
    if (existingTab) {
      const raw = await deps.sendCommand(existingTab, 'set_viewport', {
        ...(request.width !== undefined ? { width: request.width } : {}),
        ...(request.height !== undefined ? { height: request.height } : {}),
        scope,
        ...(request.reset === true ? { reset: true } : {}),
      });
      data = normalizeSetViewportResult(raw);
    } else {
      data = await deps.driver.viewport(
        request.profileId,
        request.targetId,
        request.reset === true
          ? { reset: true }
          : { width: request.width!, height: request.height! },
      );
    }
    deps.actionGuard.recordMutationSucceeded(prepared);
    return deps.result<BrowserSetViewportResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'set_viewport',
      toolName: 'browser.set_viewport',
      actionClass: prepared.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: request.reset === true
        ? `browser.set_viewport restored the previous ${scope} viewport state`
        : `browser.set_viewport applied ${scope} viewport via ${data.mode}`,
      origin: prepared.origin,
      url: prepared.url,
      grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data,
    });
  } catch (error) {
    return deps.actionGuard.mutationFailed(
      request, 'set_viewport', 'browser.set_viewport', prepared, error,
    ) as BrowserGatewayResult<BrowserSetViewportResult | null>;
  }
}

async function readViewportState(
  deps: BrowserInputControlDeps,
  request: BrowserGatewayContext & BrowserSetViewportRequest,
  existingTab: BrowserExistingTabAttachment | undefined,
): Promise<BrowserGatewayResult<BrowserSetViewportResult | null>> {
  try {
    let data: BrowserSetViewportResult;
    if (existingTab) {
      data = normalizeSetViewportResult(
        await deps.sendCommand(existingTab, 'set_viewport', { scope: request.scope === 'window' ? 'window' : 'tab' }),
      );
    } else {
      data = await deps.driver.viewport(request.profileId, request.targetId, {});
    }
    return deps.result<BrowserSetViewportResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'set_viewport',
      toolName: 'browser.set_viewport',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read current viewport dimensions (window.innerWidth/innerHeight)',
      data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deps.result<BrowserSetViewportResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'set_viewport',
      toolName: 'browser.set_viewport',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'failed',
      reason: message,
      summary: `Reading viewport dimensions failed: ${message}`,
      data: null,
    });
  }
}

async function setZoom(
  deps: BrowserInputControlDeps,
  request: BrowserGatewayContext & BrowserSetZoomRequest,
): Promise<BrowserGatewayResult<BrowserSetZoomResult | null>> {
  const existingTab = deps.getExistingTab(request.profileId, request.targetId);
  const readMode = request.zoomFactor === undefined && request.reset !== true;

  if (!existingTab) {
    return deps.result<BrowserSetZoomResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'set_zoom',
      toolName: 'browser.set_zoom',
      actionClass: readMode ? 'read' : 'input',
      decision: 'denied',
      outcome: 'not_run',
      reason: ZOOM_UNSUPPORTED_MANAGED_REASON,
      summary:
        'browser.set_zoom changes real Chrome browser zoom and is only available on shared '
        + 'existing Chrome tabs (chrome.tabs.setZoom). CSS zoom, transforms and device-scale '
        + 'emulation are not substitutes and are not used. Use a shared tab '
        + '(browser.find_or_open) on the target computer.',
      data: null,
    });
  }

  if (readMode) {
    return readZoomState(deps, request, existingTab);
  }

  const actionLabel = request.reset === true ? 'zoom:reset' : `zoom:${request.zoomFactor}`;
  const prepared = await deps.actionGuard.prepareMutatingAction(
    request,
    'set_zoom',
    'browser.set_zoom',
    actionLabel,
    undefined,
    { actionClass: 'input', hardStop: false },
  );
  if (prepared.result) {
    return prepared.result as BrowserGatewayResult<BrowserSetZoomResult | null>;
  }
  const recheck = deps.actionGuard.recheckPreparedGrant(
    request, 'set_zoom', 'browser.set_zoom', prepared,
  );
  if (recheck) {
    return recheck as BrowserGatewayResult<BrowserSetZoomResult | null>;
  }

  try {
    const raw = await deps.sendCommand(existingTab, 'set_zoom', {
      ...(request.zoomFactor !== undefined ? { zoomFactor: request.zoomFactor } : {}),
      ...(request.reset === true ? { reset: true } : {}),
    });
    const data = normalizeSetZoomResult(raw);
    deps.actionGuard.recordMutationSucceeded(prepared);
    return deps.result<BrowserSetZoomResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'set_zoom',
      toolName: 'browser.set_zoom',
      actionClass: prepared.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: request.reset === true
        ? 'browser.set_zoom restored the recorded original browser zoom'
        : `browser.set_zoom set real Chrome zoom to ${data.zoomPercent}%`,
      origin: prepared.origin,
      url: prepared.url,
      grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data,
    });
  } catch (error) {
    return deps.actionGuard.mutationFailed(
      request, 'set_zoom', 'browser.set_zoom', prepared, error,
    ) as BrowserGatewayResult<BrowserSetZoomResult | null>;
  }
}

async function readZoomState(
  deps: BrowserInputControlDeps,
  request: BrowserGatewayContext & BrowserSetZoomRequest,
  existingTab: BrowserExistingTabAttachment,
): Promise<BrowserGatewayResult<BrowserSetZoomResult | null>> {
  try {
    const data = normalizeSetZoomResult(
      await deps.sendCommand(existingTab, 'set_zoom', undefined),
    );
    return deps.result<BrowserSetZoomResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'set_zoom',
      toolName: 'browser.set_zoom',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Read real Chrome browser zoom: ${data.zoomPercent}%`,
      data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deps.result<BrowserSetZoomResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'set_zoom',
      toolName: 'browser.set_zoom',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'failed',
      reason: message,
      summary: `Reading browser zoom failed: ${message}`,
      data: null,
    });
  }
}
