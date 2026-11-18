/**
 * `browser.recover_secret_observation`: restore an agent's access to a shared
 * tab after a saved secret was entered there, with one specific approval in
 * Harness instead of the extension popup.
 *
 * The extension stays the only authority on protection. This module
 * 1. asks it to review the tab (`secret_protection_review`): exact protected
 *    origins, the write generation and a one-use review token,
 * 2. turns that review into one approval bound to the session, computer,
 *    extension install, tab, origins and generation (never a grant),
 * 3. after approval, reviews again and sends `release_secret_observation`
 *    with that fresh token,
 * 4. confirms the tab is no longer protected and, separately, whether the
 *    remembered sign-in fingerprint shows the session signed in.
 *
 * It never clicks, types or submits anything. A sign-in that still needs
 * submitting is finished by the agent afterwards, through the ordinary guarded
 * tools: a saved recipe's selector is agent-written, so pressing it here would
 * bypass the action guard.
 *
 * Review tokens never leave this process and are never stored. Nothing
 * page-derived is returned to the agent: only fixed states and codes.
 */

import { randomUUID } from 'node:crypto';
import type {
  BrowserApprovalRequest,
  BrowserGatewayResult,
  BrowserRecoverSecretObservationRequest,
  BrowserSecretRecoveryMetadata,
  BrowserSecretRecoveryOutcome,
  BrowserSecretRecoveryProgress,
  BrowserSecretRecoveryState,
} from '@contracts/types/browser';
import { getLogger } from '../logging/logger';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserExtensionCommandName } from './browser-extension-command-store';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import { allowedOriginFromUrl } from './browser-gateway-service-helpers';
import { statedReason } from './browser-approval-reason';
import { providerFromContext } from './browser-provider';

const logger = getLogger('BrowserSecretRecovery');

const TOOL_NAME = 'browser.recover_secret_observation';
const ACTION = 'recover_secret_observation';
const APPROVAL_TTL_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const FIXED_CODE = /^[a-z][a-z0-9_]{2,120}/;

export type SecretRecoveryApprovalStore = Pick<BrowserApprovalStore,
  'createRequest' | 'getRequest' | 'findReusableSecretRecoveryRequest' | 'setSecretRecoveryProgress'>;

export interface BrowserSecretRecoveryDeps {
  approvalStore: SecretRecoveryApprovalStore;
  getExistingTab: (profileId: string, targetId: string) => BrowserExistingTabAttachment | undefined;
  sendCommand: (
    attachment: BrowserExistingTabAttachment,
    command: BrowserExtensionCommandName,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<unknown>;
  /** Whether this tab's extension install is 0.2.55 or newer and in fresh contact. */
  supportsRecovery: (attachment: BrowserExistingTabAttachment, profileId: string) => boolean;
  /** true signed in, false signed out, null unknown. Never throws for a page reason. */
  checkLogin: (approval: BrowserApprovalRequest) => Promise<boolean | null>;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  /**
   * Runs the approved work as the requesting session's browser owner. The
   * approval arrives from the Harness window, not the agent's RPC call, and the
   * extension refuses an owner-less command on a tab the session holds.
   */
  inSession: <T>(instanceId: string, work: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

type Review =
  | { state: 'protection_off' | 'not_protected' | 'inspection_unavailable' }
  | {
    state: 'protected';
    origins: string[];
    affectedTabCount: number;
    writeGeneration: string;
    reviewToken: string;
  };

class RecoveryStop extends Error {
  constructor(readonly state: BrowserSecretRecoveryProgress['state'], readonly reasonCode: string) {
    super(reasonCode);
  }
}

export class BrowserSecretRecoveryOperations {
  private readonly inFlight = new Map<string, Promise<BrowserApprovalRequest | null>>();

  constructor(private readonly deps: BrowserSecretRecoveryDeps) {}

  async recover(
    request: BrowserGatewayContext & BrowserRecoverSecretObservationRequest,
  ): Promise<BrowserGatewayResult<BrowserSecretRecoveryOutcome | null>> {
    if (!request.instanceId) {
      return this.refused(request, 'secret_recovery_requires_agent_session',
        'Only an agent session can ask to recover browser access');
    }
    if (request.requestId) {
      return this.resume(request, request.instanceId, request.requestId);
    }
    const attachment = this.deps.getExistingTab(request.profileId, request.targetId);
    if (!attachment) {
      return this.refused(request, 'secret_recovery_requires_shared_extension_tab',
        'browser.recover_secret_observation works on shared Chrome tabs (browser.find_or_open) only');
    }
    if (!this.deps.supportsRecovery(attachment, request.profileId)) {
      return this.answer(request, outcome('unsupported_extension', 'extension_older_than_0_2_55'));
    }
    let review: Review;
    try {
      review = await this.review(attachment);
    } catch (error) {
      // No request exists yet, so the usual "call again with this requestId" does not apply.
      return this.answer(request, { ...outcome('failed', fixedCode(error, 'secret_protection_review_failed')),
        nextAction: 'Harness could not check this tab, and nothing changed. Retry the read once; if it is still refused, call this tool again.' });
    }
    if (review.state !== 'protected') {
      return this.answer(request, review.state === 'inspection_unavailable'
        ? outcome('manual_security_review_required', 'tab_isolation_unavailable')
        : outcome('not_protected', review.state));
    }
    const nodeId = attachment.nodeId ?? 'local';
    const binding = {
      ownerSessionId: request.instanceId,
      nodeId,
      targetId: request.targetId,
      origins: review.origins,
      writeGeneration: review.writeGeneration,
    };
    const reusable = this.deps.approvalStore.findReusableSecretRecoveryRequest(binding);
    if (reusable && reusable.profileId === request.profileId
      && reusable.secretRecovery?.affectedTabCount === review.affectedTabCount) {
      return this.resume(request, request.instanceId, reusable.requestId);
    }
    const expiresAt = this.now() + APPROVAL_TTL_MS;
    const metadata: BrowserSecretRecoveryMetadata = {
      operationId: randomUUID(),
      ...binding,
      computerName: attachment.nodeName?.trim().slice(0, 500) || (nodeId === 'local' ? 'this computer' : nodeId),
      ...(attachment.extensionInstanceId ? { extensionInstanceId: attachment.extensionInstanceId } : {}),
      affectedTabCount: review.affectedTabCount,
      expiresAt,
    };
    const allowedOrigins = review.origins.map((origin) => allowedOriginFromUrl(origin));
    if (allowedOrigins.some((origin) => !origin)) {
      return this.answer(request, outcome('manual_security_review_required', 'protected_origin_unrecognised'));
    }
    const approval = this.deps.approvalStore.createRequest({
      instanceId: request.instanceId,
      provider: providerFromContext(request.provider),
      profileId: request.profileId,
      targetId: request.targetId,
      toolName: TOOL_NAME,
      action: ACTION,
      actionClass: 'credential',
      origin: review.origins[0],
      ...(statedReason(request.reason) ? { requestReason: statedReason(request.reason) } : {}),
      proposedGrant: {
        mode: 'per_action',
        allowedOrigins: allowedOrigins.filter((origin) => origin !== null),
        allowedActionClasses: ['read'],
        allowExternalNavigation: false,
        autonomous: false,
      },
      secretRecovery: metadata,
      expiresAt,
    });
    return this.answer(request, outcomeForApproval(approval, false));
  }

  /** Starts (or joins) the approved recovery. Called when the user approves it. */
  start(approval: BrowserApprovalRequest): Promise<BrowserApprovalRequest | null> {
    const running = this.inFlight.get(approval.requestId);
    if (running) return running;
    const work = this.deps.inSession(approval.instanceId, () => this.execute(approval))
      .catch((error: unknown) => {
        logger.warn('Secret recovery stopped unexpectedly', { requestId: approval.requestId,
          error: error instanceof Error ? error.message : String(error) });
        return this.progress(approval, { state: 'failed', reasonCode: 'secret_recovery_unexpected_error', loginVerified: null });
      })
      .then((finished) => {
        // The run Harness does after approval is audited on its own, not only when the agent calls back.
        if (finished?.secretRecovery && approval.targetId) {
          this.answer({ instanceId: approval.instanceId, provider: approval.provider, profileId: approval.profileId,
            targetId: approval.targetId }, outcomeForApproval(finished, false, this.now()));
        }
        return finished;
      })
      .finally(() => this.inFlight.delete(approval.requestId));
    this.inFlight.set(approval.requestId, work);
    return work;
  }

  /**
   * The recovery for this request, running or already finished, so a caller
   * can report its end. A recovery that stopped before the caller asked (the
   * tab was already gone, say) is read back from the store.
   */
  completion(requestId: string): Promise<BrowserApprovalRequest | null> | undefined {
    const running = this.inFlight.get(requestId);
    if (running) return running;
    const approval = this.deps.approvalStore.getRequest(requestId);
    const state = approval?.secretRecoveryProgress?.state;
    return state && state !== 'running' ? Promise.resolve(approval) : undefined;
  }

  private async resume(
    request: BrowserGatewayContext & BrowserRecoverSecretObservationRequest,
    instanceId: string,
    requestId: string,
  ): Promise<BrowserGatewayResult<BrowserSecretRecoveryOutcome | null>> {
    let approval = this.deps.approvalStore.getRequest(requestId, instanceId);
    if (!approval?.secretRecovery || approval.profileId !== request.profileId || approval.targetId !== request.targetId) {
      return this.refused(request, 'secret_recovery_request_not_found',
        'No browser access recovery with that request id belongs to this session and tab');
    }
    const progress = approval.secretRecoveryProgress;
    const terminal = progress?.state;
    // A receipt means the release happened: report it, never run the recovery again.
    const retryable = !progress?.receiptId
      && (!terminal || terminal === 'failed' || terminal === 'indeterminate' || terminal === 'running');
    if (approval.status === 'approved' && retryable && approval.expiresAt > this.now()) {
      approval = await this.start(approval) ?? this.deps.approvalStore.getRequest(requestId, instanceId) ?? approval;
    }
    return this.answer(request, outcomeForApproval(approval, this.inFlight.has(requestId), this.now()));
  }

  private async execute(approval: BrowserApprovalRequest): Promise<BrowserApprovalRequest | null> {
    const meta = approval.secretRecovery;
    if (!meta) return null;
    // An earlier attempt whose release outcome is unknown (lost reply, or a
    // Harness restart mid-run) may have released. Its receipt is settled first;
    // until then nothing this attempt sees may be reported as "unchanged".
    const previous = this.deps.approvalStore.getRequest(approval.requestId)?.secretRecoveryProgress?.state;
    const mayHaveReleased = previous === 'indeterminate' || previous === 'running';
    if (!this.progress(approval, { state: 'running', reasonCode: 'secret_recovery_running', loginVerified: null })) {
      return this.deps.approvalStore.getRequest(approval.requestId);
    }
    let releaseConfirmed = false;
    try {
      const attachment = this.deps.getExistingTab(approval.profileId, meta.targetId);
      const moved = attachment && ((attachment.nodeId ?? 'local') !== meta.nodeId
        || (meta.extensionInstanceId && attachment.extensionInstanceId !== meta.extensionInstanceId));
      if (!attachment || moved) {
        throw mayHaveReleased
          ? new RecoveryStop('indeterminate', 'release_outcome_unknown')
          : new RecoveryStop('stale_review', attachment ? 'target_tab_moved' : 'target_tab_gone');
      }
      if (mayHaveReleased) {
        const receipt = await this.releaseReceipt(attachment, meta);
        if (receipt === 'found') {
          releaseConfirmed = true;
          return await this.finish(approval, attachment, meta, undefined);
        }
        if (receipt === 'unknown') throw new RecoveryStop('indeterminate', 'release_outcome_unknown');
      }
      const review = await this.review(attachment);
      if (review.state !== 'protected') {
        // An earlier attempt may already have released this operation and lost the reply.
        const receipt = await this.releaseReceipt(attachment, meta);
        if (receipt === 'found') return await this.finish(approval, attachment, meta, undefined);
        if (receipt === 'unknown') throw new RecoveryStop('indeterminate', 'release_outcome_unknown');
        throw new RecoveryStop('stale_review', `protection_${review.state}`);
      }
      this.assertSameReview(review, meta);
      this.assertStillApproved(approval);
      let released: unknown;
      try {
        released = await this.deps.sendCommand(attachment, 'release_secret_observation', {
          operationId: meta.operationId,
          reviewToken: review.reviewToken,
          origins: meta.origins,
          writeGeneration: meta.writeGeneration,
        }, COMMAND_TIMEOUT_MS);
      } catch (error) {
        const code = fixedCode(error, 'release_outcome_unknown');
        if (code === 'secret_release_review_invalid' || code === 'secret_release_state_changed') {
          // Refused, so nothing was released. Say why from what the tab shows now:
          // protection may have been switched off or cleared meanwhile.
          throw new RecoveryStop('stale_review', await this.refusalReason(attachment));
        }
        if (code === 'secret_release_protection_off') throw new RecoveryStop('stale_review', 'protection_protection_off');
        throw new RecoveryStop('indeterminate', 'release_outcome_unknown');
      }
      if (!released || typeof released !== 'object' || (released as Record<string, unknown>)['released'] !== true) {
        throw new RecoveryStop('indeterminate', 'release_not_confirmed');
      }
      releaseConfirmed = true;
      return await this.finish(approval, attachment, meta, released);
    } catch (error) {
      if (releaseConfirmed) {
        // Something failed after the extension confirmed the release: it happened.
        return this.progress(approval, {
          state: 'indeterminate', reasonCode: 'released_check_unavailable', loginVerified: null, receiptId: meta.operationId,
        });
      }
      const stopped = error instanceof RecoveryStop
        ? { state: error.state, reasonCode: error.reasonCode }
        : { state: 'failed' as const, reasonCode: fixedCode(error, 'secret_recovery_failed') };
      return this.progress(approval, { ...stopped, loginVerified: null });
    }
  }

  /**
   * Called only once the release is confirmed (a confirming reply, or the
   * extension's stored receipt). Verifies it and records the receipt. From here on protection for
   * the reviewed sites IS lifted, so every outcome carries the receipt and none
   * may say it is unchanged. Login is reported separately.
   */
  private async finish(
    approval: BrowserApprovalRequest,
    attachment: BrowserExistingTabAttachment,
    meta: BrowserSecretRecoveryMetadata,
    released: unknown,
  ): Promise<BrowserApprovalRequest | null> {
    const record = released && typeof released === 'object' ? released as Record<string, unknown> : {};
    const clearedTabCount = typeof record['clearedTabCount'] === 'number' && Number.isInteger(record['clearedTabCount'])
      ? record['clearedTabCount'] : undefined;
    const receipt = { receiptId: meta.operationId, ...(clearedTabCount !== undefined ? { clearedTabCount } : {}) };
    let after: Review;
    try {
      after = await this.review(attachment);
    } catch {
      return this.progress(approval, {
        state: 'indeterminate', reasonCode: 'released_check_unavailable', loginVerified: null, ...receipt,
      });
    }
    if (after.state === 'protected' && after.origins.some((origin) => meta.origins.includes(origin))) {
      // Released, then a new password entry on the same site protected it again:
      // a fresh recovery (new review) is the way on, not "do not ask again".
      return this.progress(approval, {
        state: 'stale_review', reasonCode: PROTECTED_AGAIN, loginVerified: null, ...receipt,
      });
    }
    if (after.state === 'protected' || after.state === 'inspection_unavailable') {
      // Released, but this tab still holds another protected site, or its
      // frames could not be checked: a decision for the user, not a retry.
      return this.progress(approval, {
        state: 'manual_security_review_required',
        reasonCode: after.state === 'protected' ? 'released_tab_still_protected_by_another_site' : 'released_tab_isolation_unavailable',
        loginVerified: null,
        ...receipt,
      });
    }
    const loginVerified = await this.deps.checkLogin(approval).catch(() => null);
    return this.progress(approval, {
      state: 'recovered', reasonCode: 'protection_released_and_verified', loginVerified, ...receipt,
    });
  }

  /** Why the extension refused a release, from a fresh look at the tab. */
  private async refusalReason(attachment: BrowserExistingTabAttachment): Promise<string> {
    const now = await this.review(attachment).catch(() => null);
    if (now?.state === 'protection_off') return 'protection_protection_off';
    if (now?.state === 'not_protected') return 'protection_not_protected';
    return 'protected_state_changed';
  }

  /** Whether the extension holds this operation's release receipt. Transport trouble is 'unknown', never 'missing'. */
  private async releaseReceipt(
    attachment: BrowserExistingTabAttachment,
    meta: BrowserSecretRecoveryMetadata,
  ): Promise<'found' | 'missing' | 'unknown'> {
    try {
      const replay = await this.deps.sendCommand(attachment, 'release_secret_observation', {
        operationId: meta.operationId,
        // Never a real token: only a stored receipt for this operation can answer yes.
        reviewToken: 'receipt-check-only',
        origins: meta.origins,
        writeGeneration: meta.writeGeneration,
      }, COMMAND_TIMEOUT_MS) as Record<string, unknown> | null;
      return replay?.['alreadyApplied'] === true ? 'found' : 'unknown';
    } catch (error) {
      const code = fixedCode(error, 'unknown');
      return code === 'secret_release_review_invalid' || code === 'secret_release_protection_off' ? 'missing' : 'unknown';
    }
  }

  private async review(attachment: BrowserExistingTabAttachment): Promise<Review> {
    return parseReview(await this.deps.sendCommand(attachment, 'secret_protection_review', {}, COMMAND_TIMEOUT_MS));
  }

  private assertSameReview(review: Extract<Review, { state: 'protected' }>, meta: BrowserSecretRecoveryMetadata): void {
    // The tab count is part of what the user approved: a tab that inherited
    // protection since then needs a fresh approval.
    if (review.writeGeneration !== meta.writeGeneration
      || review.affectedTabCount !== meta.affectedTabCount
      || JSON.stringify(review.origins) !== JSON.stringify(meta.origins)) {
      throw new RecoveryStop('stale_review', 'protected_state_changed');
    }
  }

  /** Denial, expiry, Stop or a discarded session ends the operation before it touches the browser. */
  private assertStillApproved(approval: BrowserApprovalRequest): void {
    const current = this.deps.approvalStore.getRequest(approval.requestId);
    if (!current || current.status !== 'approved' || current.expiresAt <= this.now()) {
      throw new RecoveryStop('stale_review', 'approval_no_longer_current');
    }
  }

  private progress(
    approval: BrowserApprovalRequest,
    progress: Omit<BrowserSecretRecoveryProgress, 'updatedAt'>,
  ): BrowserApprovalRequest | null {
    return this.deps.approvalStore.setSecretRecoveryProgress(approval.requestId, { ...progress, updatedAt: this.now() });
  }

  private answer(
    request: BrowserGatewayContext & BrowserRecoverSecretObservationRequest,
    data: BrowserSecretRecoveryOutcome,
  ): BrowserGatewayResult<BrowserSecretRecoveryOutcome | null> {
    const waiting = data.state === 'approval_pending';
    // A receipt means protection was released, even when readability is unconfirmed.
    const done = data.state === 'recovered' || Boolean(data.receiptId);
    const failed = data.state === 'failed' || data.state === 'indeterminate';
    return this.deps.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: ACTION,
      toolName: TOOL_NAME,
      actionClass: 'credential',
      decision: waiting ? 'requires_user' : 'allowed',
      outcome: done ? 'succeeded' : failed ? 'failed' : 'not_run',
      ...(data.requestId ? { requestId: data.requestId } : {}),
      reason: data.reasonCode,
      summary: `Browser access recovery: ${data.state}`,
      data,
    });
  }

  private refused(
    request: BrowserGatewayContext & BrowserRecoverSecretObservationRequest,
    reason: string,
    summary: string,
  ): BrowserGatewayResult<BrowserSecretRecoveryOutcome | null> {
    return this.deps.result({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: ACTION,
      toolName: TOOL_NAME,
      actionClass: 'credential',
      decision: 'denied',
      outcome: 'not_run',
      reason,
      summary,
      data: null,
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function parseReview(raw: unknown): Review {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const state = record['state'];
  if (state === 'protection_off' || state === 'not_protected' || state === 'inspection_unavailable') {
    return { state };
  }
  const origins = record['origins'];
  const count = record['affectedTabCount'];
  const generation = record['writeGeneration'];
  const token = record['reviewToken'];
  if (state !== 'protected' || !Array.isArray(origins) || origins.length === 0
    || !origins.every((origin) => typeof origin === 'string')
    || typeof count !== 'number' || !Number.isInteger(count) || count < 0
    || typeof generation !== 'string' || !ID_PATTERN.test(generation)
    || typeof token !== 'string' || !ID_PATTERN.test(token)) {
    // An answer of the wrong shape proves nothing about isolation.
    return { state: 'inspection_unavailable' };
  }
  return {
    state,
    origins: [...new Set(origins as string[])].sort(),
    affectedTabCount: count,
    writeGeneration: generation,
    reviewToken: token,
  };
}

/** The leading fixed code of an extension/transport error; never free text. */
function fixedCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = FIXED_CODE.exec(message);
  return match && match[0].length === message.length ? match[0] : fallback;
}

const NEXT_ACTION: Record<BrowserSecretRecoveryState, string> = {
  approval_pending: 'Wait. The user has been asked in Harness; you will be resumed. Then call again with this requestId.',
  approved: 'Harness is recovering access now. Call again with this requestId in a few seconds.',
  running: 'Harness is recovering access now. Call again with this requestId in a few seconds.',
  recovered: 'Access is restored. Read the page again and continue; if it still needs signing in, finish that with the usual browser tools. If loginVerified is not true, check the sign-in yourself before relying on it.',
  stale_review: 'The protected state changed or the approval ended. Call again without requestId to ask for a fresh approval if access is still needed.',
  manual_security_review_required: 'Harness cannot release this safely on its own. Tell the user why (reasonCode) and do not retry.',
  not_protected: 'This tab is not protected. Retry the read; if it is still refused, check browser.health.',
  denied: 'The user kept this site protected. Do not retry; continue without reading this tab.',
  unsupported_extension: 'The browser extension on that computer is older than 0.2.55 and cannot do this. Tell the user it needs updating; do not retry.',
  failed: 'Recovery did not finish and protection is unchanged. You may call again with this requestId once; if it fails again, tell the user.',
  indeterminate: 'Harness could not confirm whether protection was released. Call again with this requestId to check; never repeat a sign-in meanwhile.',
};

const PROTECTED_AGAIN = 'released_then_protected_again';
const RELEASED_THEN_PROTECTED = 'Protection for the reviewed site was lifted, then a new password entry protected it again. '
  + 'If access is still needed, call this tool again without requestId to ask for a fresh approval.';
const RELEASED_UNCONFIRMED = 'Protection for the reviewed site was lifted, but Harness could not confirm this tab is readable. '
  + 'Retry the read once; if it is still refused, tell the user why (reasonCode). Do not ask for another recovery for the same site.';

function outcome(
  state: BrowserSecretRecoveryState,
  reasonCode: string,
  extra: Partial<BrowserSecretRecoveryOutcome> = {},
): BrowserSecretRecoveryOutcome {
  return { state, reasonCode, loginVerified: null, ...extra, nextAction: NEXT_ACTION[state] };
}

export function outcomeForApproval(
  approval: BrowserApprovalRequest,
  running: boolean,
  now = Date.now(),
): BrowserSecretRecoveryOutcome {
  const meta = approval.secretRecovery;
  const extra = {
    requestId: approval.requestId,
    ...(meta ? { origins: meta.origins, affectedTabCount: meta.affectedTabCount } : {}),
  };
  const progress = approval.secretRecoveryProgress;
  // A receipt means protection for the reviewed sites was lifted, whatever came
  // after (an unconfirmed check, Stop, expiry): never tell anyone otherwise.
  if (progress?.receiptId) {
    const released = outcome(progress.state === 'running' ? 'indeterminate' : progress.state, progress.reasonCode, {
      ...extra, loginVerified: progress.loginVerified, receiptId: progress.receiptId,
    });
    if (progress.state === 'recovered') return released;
    return { ...released, nextAction: progress.reasonCode === PROTECTED_AGAIN ? RELEASED_THEN_PROTECTED : RELEASED_UNCONFIRMED };
  }
  if (approval.status === 'denied') return outcome('denied', 'user_kept_protection', extra);
  if (approval.status === 'expired') return outcome('stale_review', 'approval_expired', extra);
  if (approval.status === 'pending') {
    return approval.expiresAt > now
      ? outcome('approval_pending', 'awaiting_user', extra)
      : outcome('stale_review', 'approval_expired', extra);
  }
  if (running) return outcome('running', 'secret_recovery_running', extra);
  if (approval.expiresAt <= now) return outcome('stale_review', 'approval_expired', extra);
  if (progress?.state === 'running') return outcome('running', progress.reasonCode, extra);
  if (!progress) return outcome('approved', 'approved_not_started', extra);
  return outcome(progress.state, progress.reasonCode, { ...extra, loginVerified: progress.loginVerified });
}
