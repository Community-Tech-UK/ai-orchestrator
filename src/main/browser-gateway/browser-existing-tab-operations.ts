import type {
  BrowserApprovalRequest,
  BrowserGatewayResult,
  BrowserPermissionGrant,
  BrowserDownloadFileResult,
} from '@contracts/types/browser';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type {
  BrowserExtensionCommandName,
  BrowserExtensionCommandStore,
} from './browser-extension-command-store';
import {
  BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS,
  browserExtensionQueueKeyForNode,
} from './browser-extension-command-store';
import type {
  BrowserExtensionTabAttachOptions,
  BrowserExtensionTabStore,
} from './browser-extension-tab-store';
import type { BrowserGrantStore } from './browser-grant-store';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type {
  BrowserGatewayNavigateRequest,
  BrowserGatewayScreenshotRequest,
  BrowserGatewayTargetRequest,
} from './browser-gateway-service-types';
import type { BrowserSnapshot } from './puppeteer-browser-driver';
import { isOriginAllowed } from './browser-origin-policy';
import { isMutatingBrowserCommand } from './browser-mutation-safety';
import {
  allowedOriginFromUrl,
  extractTabPayload,
} from './browser-gateway-service-helpers';
import { providerFromContext } from './browser-gateway-action-guard';
import { findMatchingBrowserGrant } from './browser-grant-policy';
import { boundBrowserText } from './browser-redaction';
import { postTimeoutMutationProbe } from './browser-existing-tab-timeout-probe';
import type { BrowserReliabilityEvents } from './browser-reliability-events';
import { guardAppStateMutation } from './browser-app-write-guard';
import {
  isAppStateMutatingCommand,
  type BrowserTargetPersistenceSentinel,
} from './browser-target-persistence-sentinel';
import type { BrowserWriteJournal } from './browser-write-journal';

const EXTENSION_COMMAND_RESULT_GRACE_MS = 5_000;
const SHORT_EXTENSION_COMMAND_RESULT_GRACE_MS = 500;

interface BrowserExistingTabOperationsDeps {
  extensionCommandStore: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  extensionTabStore: Pick<BrowserExtensionTabStore, 'attachTab' | 'detachTab'>;
  isRemoteExtensionContactFresh: (nodeId: string) => boolean;
  describeRemoteExtensionContact: (nodeId: string) => string;
  grantStore: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant'>;
  approvalStore: Pick<BrowserApprovalStore, 'createRequest'>;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  autoApproveApproval: (approval: BrowserApprovalRequest) => BrowserPermissionGrant | null;
  onNavigateSucceeded?: (request: BrowserGatewayNavigateRequest) => void;
  /** Reliability hardening: app-signal scan around app-state mutations. */
  persistenceSentinel?: Pick<
    BrowserTargetPersistenceSentinel,
    'scan' | 'needsPreWriteCheck'
  >;
  /** Reliability hardening: durable per-target mutation journal. */
  writeJournal?: Pick<BrowserWriteJournal, 'recordIntent' | 'recordOutcome'>;
  /** Last channel disconnect for this attachment's node ('local' when none). */
  getLastChannelDisconnectAt?: (nodeId: string | undefined) => number | undefined;
  reliabilityEvents?: Pick<BrowserReliabilityEvents, 'record'>;
}

export class BrowserExistingTabOperations {
  constructor(private readonly deps: BrowserExistingTabOperationsDeps) {}

  async navigate(
    request: BrowserGatewayNavigateRequest,
    attachment: BrowserExistingTabAttachment,
  ): Promise<BrowserGatewayResult<null>> {
    const originDecision = isOriginAllowed(request.url, attachment.allowedOrigins);
    let grant: BrowserPermissionGrant | undefined;
    let origin = originDecision.origin;
    if (!originDecision.allowed) {
      if (!originDecision.origin) {
        return this.deps.result({
          context: request,
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          action: 'navigate',
          toolName: 'browser.navigate',
          actionClass: 'navigate',
          decision: 'denied',
          outcome: 'not_run',
          reason: originDecision.reason,
          summary: `Existing Chrome tab navigation denied by Browser Gateway origin policy: ${originDecision.reason}`,
          url: request.url,
          data: null,
        });
      }
      origin = originDecision.origin;
      const grants = this.deps.grantStore.listGrants({
        instanceId: request.instanceId,
        profileId: attachment.profileId,
      });
      const match = findMatchingBrowserGrant({
        grants,
        instanceId: request.instanceId ?? '',
        provider: providerFromContext(request.provider),
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        origin,
        actionClass: 'navigate',
      });
      grant = match.grant?.allowExternalNavigation ? match.grant : undefined;
      if (!grant) {
        const allowedOrigin = allowedOriginFromUrl(request.url);
        if (!allowedOrigin) {
          return this.deps.result({
            context: request,
            profileId: attachment.profileId,
            targetId: attachment.targetId,
            action: 'navigate',
            toolName: 'browser.navigate',
            actionClass: 'navigate',
            decision: 'denied',
            outcome: 'not_run',
            reason: 'invalid_url',
            summary: 'Existing Chrome tab navigation denied because the destination URL is invalid',
            url: request.url,
            data: null,
          });
        }
        const approval = this.deps.approvalStore.createRequest({
          instanceId: request.instanceId ?? 'unknown',
          provider: providerFromContext(request.provider),
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          toolName: 'browser.navigate',
          action: 'navigate',
          actionClass: 'navigate',
          origin,
          url: request.url,
          proposedGrant: {
            mode: 'per_action',
            allowedOrigins: [allowedOrigin],
            allowedActionClasses: ['navigate'],
            allowExternalNavigation: true,
            autonomous: false,
          },
          expiresAt: Date.now() + 30 * 60 * 1000,
        });
        const autoGrant = this.deps.autoApproveApproval(approval);
        if (autoGrant?.allowExternalNavigation) {
          grant = autoGrant;
        } else {
          return this.deps.result({
            context: request,
            profileId: attachment.profileId,
            targetId: attachment.targetId,
            action: 'navigate',
            toolName: 'browser.navigate',
            actionClass: 'navigate',
            decision: 'requires_user',
            outcome: 'not_run',
            requestId: approval.requestId,
            reason: 'cross_origin_navigation_requires_user_approval',
            summary: `Existing Chrome tab navigation to ${origin} requires user approval`,
            origin,
            url: request.url,
            data: null,
          });
        }
      }
    }

    try {
      const result = await this.sendCommand(attachment, 'navigate', {
        url: request.url,
      });
      if (result) {
        try {
          const tab = extractTabPayload(result);
          this.attachRefreshedTab(tab, attachment);
        } catch {
          // Navigation succeeded; stale metadata is less important than
          // preserving the audited command result.
        }
      }
      if (grant?.mode === 'per_action') {
        this.deps.grantStore.consumeGrant(grant.id);
      }
      this.deps.onNavigateSucceeded?.(request);
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: grant
          ? 'Navigated existing Chrome tab using an approved cross-origin grant'
          : 'Navigated existing Chrome tab within allowed origin',
        origin,
        url: request.url,
        grantId: grant?.id,
        autonomous: grant?.autonomous,
        data: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'navigate',
        toolName: 'browser.navigate',
        actionClass: 'navigate',
        decision: 'allowed',
        outcome: 'failed',
        reason: message,
        summary: `Existing Chrome tab navigation failed: ${message}`,
        origin,
        url: request.url,
        grantId: grant?.id,
        autonomous: grant?.autonomous,
        data: null,
      });
    }
  }

  async sendCommand(
    attachment: BrowserExistingTabAttachment,
    command: BrowserExtensionCommandName,
    payload?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const sentinel = this.deps.persistenceSentinel;
    if (!sentinel || !isAppStateMutatingCommand(command)) {
      return this.dispatchCommand(attachment, command, payload, timeoutMs);
    }
    // Channel first: an unreachable node fails fast with the channel error —
    // scanning a dead channel would only add a slow, misleading timeout.
    this.ensureChannelReachable(attachment);
    return guardAppStateMutation(
      {
        sentinel,
        rawSendCommand: this.rawSendCommand,
        ...(this.deps.writeJournal ? { writeJournal: this.deps.writeJournal } : {}),
        ...(this.deps.getLastChannelDisconnectAt
          ? { getLastChannelDisconnectAt: this.deps.getLastChannelDisconnectAt }
          : {}),
        ...(this.deps.reliabilityEvents
          ? { reliabilityEvents: this.deps.reliabilityEvents }
          : {}),
      },
      attachment,
      command,
      payload,
      () => this.dispatchCommand(attachment, command, payload, timeoutMs),
    );
  }

  private readonly rawSendCommand = (
    request: Parameters<BrowserExtensionCommandStore['sendCommand']>[0],
  ): Promise<unknown> => this.deps.extensionCommandStore.sendCommand(request);

  private ensureChannelReachable(attachment: BrowserExistingTabAttachment): void {
    if (attachment.nodeId && !this.deps.isRemoteExtensionContactFresh(attachment.nodeId)) {
      throw new Error(
        `browser_extension_unreachable (${this.describeChannel(attachment.nodeId)})`,
      );
    }
  }

  private dispatchCommand(
    attachment: BrowserExistingTabAttachment,
    command: BrowserExtensionCommandName,
    payload?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    try {
      this.ensureChannelReachable(attachment);
    } catch (error) {
      return Promise.reject(error);
    }
    // Short caller timeouts are deliberate cache-freshness probes (e.g. the 1s
    // snapshot probe backed by a cached copy) — they must stay fast. Everything
    // else gets an undelivered-wait long enough to ride out one extension
    // service-worker recovery cycle: while a command is still queued it has
    // provably not run, so waiting longer is safe even for mutations.
    const callerTimeoutMs = extensionCommandCallerTimeoutMs(timeoutMs);
    const undeliveredWaitMs = timeoutMs >= 5_000
      ? Math.max(callerTimeoutMs, BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS)
      : callerTimeoutMs;
    return this.deps.extensionCommandStore.sendCommand({
      ...(attachment.nodeId ? { queueKey: browserExtensionQueueKeyForNode(attachment.nodeId) } : {}),
      command,
      target: {
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        tabId: attachment.tabId,
        windowId: attachment.windowId,
      },
      ...(payload ? { payload } : {}),
      timeoutMs: callerTimeoutMs,
      executionTimeoutMs: timeoutMs,
      undeliveredWaitMs,
      describeChannelState: () => ({
        active: attachment.nodeId ? this.deps.isRemoteExtensionContactFresh(attachment.nodeId) : true,
        summary: this.describeChannel(attachment.nodeId),
      }),
    }).catch(async (error: unknown) => {
      // A delivered mutation that times out in the user's real Chrome may have
      // already applied. Before surfacing the failure, re-read any control state
      // the command describes so callers get a concrete applied/not-applied/unknown
      // result instead of a duplicate-prone bare timeout. Reads stay a plain
      // timeout (safe to retry).
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingExtensionTabError(message)) {
        this.deps.extensionTabStore.detachTab(attachment.profileId, attachment.targetId);
        throw error instanceof Error ? error : new Error(message);
      }
      if (message.startsWith('browser_extension_command_not_delivered')) {
        // Removed from the queue before rejection: the extension never received
        // it, so it certainly did not run — even a mutation is safe to retry.
        throw new Error(
          `browser_extension_command_not_delivered (${this.describeChannel(attachment.nodeId)}; `
          + 'the command never reached the extension and did NOT run — safe to retry)',
        );
      }
      if (message.startsWith('browser_extension_command_receipt_missing')) {
        // Delivered to the transport, but the extension never acked receiving
        // it — the handoff almost certainly died en route. Weaker guarantee
        // than not_delivered (the ack itself could have been lost), hence the
        // verify-first advice for mutations.
        throw new Error(
          `browser_extension_command_receipt_missing (${this.describeChannel(attachment.nodeId)}; `
          + 'the extension never acknowledged receiving this command — it almost certainly did not '
          + 'run, but verify page state before retrying a mutation)',
        );
      }
      if (isDeliveredCommandTimeout(message) && isMutatingBrowserCommand(command)) {
        const probe = await postTimeoutMutationProbe(
          command,
          payload,
          attachment,
          (request) => this.deps.extensionCommandStore.sendCommand(request),
        );
        if (message === 'browser_extension_command_timeout') {
          throw new Error(`browser_extension_command_timeout_${probe}`);
        }
        throw new Error(
          `${message}; post-timeout mutation probe: ${probe}`,
        );
      }
      throw error instanceof Error ? error : new Error(message);
    });
  }

  private describeChannel(nodeId: string | undefined): string {
    // Local wording stays neutral: not_delivered usually means the extension
    // is not polling, but receipt_missing means a live handoff died — do not
    // assert a channel state we cannot observe locally.
    return nodeId
      ? `node ${nodeId}: ${this.deps.describeRemoteExtensionContact(nodeId)}`
      : 'local extension channel — check Chrome is running with the Harness extension';
  }

  async snapshot(
    request: BrowserGatewayTargetRequest,
    attachment: BrowserExistingTabAttachment,
  ): Promise<BrowserGatewayResult<(BrowserSnapshot & { text: string }) | null>> {
    const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Existing-tab snapshot denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: attachment.url,
        data: null,
      });
    }

    try {
      const result = await this.sendCommand(
        attachment,
        'snapshot',
        undefined,
        attachment.text ? 1_000 : 30_000,
      );
      const tab = extractTabPayload(result);
      const fresh = this.attachRefreshedTab({
        ...tab,
        allowedOrigins: attachment.allowedOrigins,
      }, attachment);
      const freshOriginDecision = isOriginAllowed(fresh.url, fresh.allowedOrigins);
      if (!freshOriginDecision.allowed) {
        return this.deps.result({
          context: request,
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          action: 'snapshot',
          toolName: 'browser.snapshot',
          actionClass: 'read',
          decision: 'denied',
          outcome: 'not_run',
          reason: freshOriginDecision.reason,
          summary: `Existing-tab snapshot denied after live refresh by Browser Gateway origin policy: ${freshOriginDecision.reason}`,
          origin: freshOriginDecision.origin,
          url: fresh.url,
          data: null,
        });
      }
      return this.deps.result({
        context: request,
        profileId: fresh.profileId,
        targetId: fresh.targetId,
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Captured fresh snapshot from selected existing Chrome tab',
        origin: freshOriginDecision.origin,
        url: fresh.url,
        data: {
          title: fresh.title ?? '',
          url: fresh.url,
          text: boundBrowserText(fresh.text ?? ''),
        },
      });
    } catch (error) {
      if (!attachment.text) {
        const message = error instanceof Error ? error.message : String(error);
        return this.deps.result({
          context: request,
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          action: 'snapshot',
          toolName: 'browser.snapshot',
          actionClass: 'read',
          decision: 'allowed',
          outcome: 'failed',
          reason: message,
          summary: `Existing-tab live snapshot failed and no cached snapshot is available: ${message}`,
          origin: originDecision.origin,
          url: attachment.url,
          data: null,
        });
      }
    }

    return this.deps.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: 'snapshot',
      toolName: 'browser.snapshot',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read cached snapshot from selected existing Chrome tab',
      origin: originDecision.origin,
      url: attachment.url,
      data: {
        title: attachment.title ?? '',
        url: attachment.url,
        text: boundBrowserText(attachment.text ?? ''),
      },
    });
  }

  async screenshot(
    request: BrowserGatewayScreenshotRequest,
    attachment: BrowserExistingTabAttachment,
  ): Promise<BrowserGatewayResult<string | null>> {
    const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!originDecision.allowed) {
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: originDecision.reason,
        summary: `Existing-tab screenshot denied by Browser Gateway origin policy: ${originDecision.reason}`,
        url: attachment.url,
        data: null,
      });
    }

    try {
      const screenshotPayload: Record<string, unknown> = {};
      if (typeof request.maxWidth === 'number') {
        screenshotPayload['maxWidth'] = request.maxWidth;
      }
      if (typeof request.maxHeight === 'number') {
        screenshotPayload['maxHeight'] = request.maxHeight;
      }
      if (typeof request.fullPage === 'boolean') {
        screenshotPayload['fullPage'] = request.fullPage;
      }
      const result = await this.sendCommand(
        attachment,
        'screenshot',
        Object.keys(screenshotPayload).length > 0 ? screenshotPayload : undefined,
        attachment.screenshotBase64 ? 1_000 : 30_000,
      );
      const value = extractScreenshotBase64(result);
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'succeeded',
        summary: 'Captured fresh screenshot from selected existing Chrome tab',
        origin: originDecision.origin,
        url: attachment.url,
        data: value,
      });
    } catch (error) {
      if (!attachment.screenshotBase64) {
        const message = error instanceof Error ? error.message : String(error);
        return this.deps.result({
          context: request,
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          action: 'screenshot',
          toolName: 'browser.screenshot',
          actionClass: 'read',
          decision: 'allowed',
          outcome: 'failed',
          reason: message === 'browser_extension_screenshot_result_invalid'
            ? 'existing_tab_screenshot_unavailable'
            : message,
          summary: `Existing-tab live screenshot failed and no cached screenshot is available: ${message}`,
          origin: originDecision.origin,
          url: attachment.url,
          data: null,
        });
      }
    }

    if (!attachment.screenshotBase64) {
      return this.deps.result({
        context: request,
        profileId: attachment.profileId,
        targetId: attachment.targetId,
        action: 'screenshot',
        toolName: 'browser.screenshot',
        actionClass: 'read',
        decision: 'allowed',
        outcome: 'failed',
        reason: 'existing_tab_screenshot_unavailable',
        summary: 'Selected existing Chrome tab has no cached screenshot',
        origin: originDecision.origin,
        url: attachment.url,
        data: null,
      });
    }

    return this.deps.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: 'screenshot',
      toolName: 'browser.screenshot',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read cached screenshot from selected existing Chrome tab',
      origin: originDecision.origin,
      url: attachment.url,
      data: attachment.screenshotBase64,
    });
  }

  private attachRefreshedTab(
    input: Parameters<BrowserExtensionTabStore['attachTab']>[0],
    source: BrowserExistingTabAttachment,
  ): BrowserExistingTabAttachment {
    const options = remoteTabAttachOptions(source);
    return options
      ? this.deps.extensionTabStore.attachTab(input, options)
      : this.deps.extensionTabStore.attachTab(input);
  }
}

function isDeliveredCommandTimeout(message: string): boolean {
  return message.startsWith('browser_extension_command_timeout') ||
    message.startsWith('browser_extension_channel_down');
}

function remoteTabAttachOptions(
  attachment: BrowserExistingTabAttachment,
): BrowserExtensionTabAttachOptions | undefined {
  if (!attachment.nodeId && !attachment.nodeName) {
    return undefined;
  }
  return {
    ...(attachment.nodeId ? { nodeId: attachment.nodeId } : {}),
    ...(attachment.nodeName ? { nodeName: attachment.nodeName } : {}),
  };
}

function extensionCommandCallerTimeoutMs(executionTimeoutMs: number): number {
  const graceMs = executionTimeoutMs >= 5_000
    ? EXTENSION_COMMAND_RESULT_GRACE_MS
    : SHORT_EXTENSION_COMMAND_RESULT_GRACE_MS;
  return executionTimeoutMs + graceMs;
}

function isMissingExtensionTabError(message: string): boolean {
  return /\bno tab with id\b/i.test(message);
}

function extractScreenshotBase64(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('browser_extension_screenshot_result_invalid');
  }
  const value = (result as Record<string, unknown>)['screenshotBase64'];
  if (typeof value !== 'string' || !value) {
    throw new Error('browser_extension_screenshot_result_invalid');
  }
  // The extension now returns raw base64 (CDP), but tolerate a data: URL prefix
  // for any image mime type for backwards/forwards compatibility.
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').slice(0, 2_000_000);
}

export function normalizeDownloadFileResult(result: unknown): BrowserDownloadFileResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('browser_download_result_invalid');
  }
  const value = result as Record<string, unknown>;
  const download: BrowserDownloadFileResult = {};
  if (typeof value['id'] === 'number' || typeof value['id'] === 'string') {
    download.id = value['id'];
  }
  if (typeof value['url'] === 'string') {
    download.url = value['url'];
  }
  if (typeof value['finalUrl'] === 'string') {
    download.finalUrl = value['finalUrl'];
  }
  if (typeof value['filename'] === 'string') {
    download.filename = value['filename'];
  }
  if (typeof value['mime'] === 'string') {
    download.mime = value['mime'];
  }
  if (typeof value['bytesReceived'] === 'number') {
    download.bytesReceived = value['bytesReceived'];
  }
  if (typeof value['totalBytes'] === 'number') {
    download.totalBytes = value['totalBytes'];
  }
  if (typeof value['state'] === 'string') {
    download.state = value['state'];
  }
  if (typeof value['startedAt'] === 'string') {
    download.startedAt = value['startedAt'];
  }
  if (typeof value['endedAt'] === 'string') {
    download.endedAt = value['endedAt'];
  }
  if (!download.filename && !download.url) {
    throw new Error('browser_download_result_invalid');
  }
  return download;
}
