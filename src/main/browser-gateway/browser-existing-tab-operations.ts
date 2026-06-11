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
import { browserExtensionQueueKeyForNode } from './browser-extension-command-store';
import type { BrowserExtensionTabStore } from './browser-extension-tab-store';
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
import {
  allowedOriginFromUrl,
  extractTabPayload,
} from './browser-gateway-service-helpers';
import { providerFromContext } from './browser-gateway-action-guard';
import { findMatchingBrowserGrant } from './browser-grant-policy';
import { redactBrowserText } from './browser-redaction';

interface BrowserExistingTabOperationsDeps {
  extensionCommandStore: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  extensionTabStore: Pick<BrowserExtensionTabStore, 'attachTab'>;
  grantStore: Pick<BrowserGrantStore, 'listGrants' | 'consumeGrant'>;
  approvalStore: Pick<BrowserApprovalStore, 'createRequest'>;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  autoApproveApproval: (approval: BrowserApprovalRequest) => BrowserPermissionGrant | null;
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
          this.deps.extensionTabStore.attachTab(tab);
        } catch {
          // Navigation succeeded; stale metadata is less important than
          // preserving the audited command result.
        }
      }
      if (grant?.mode === 'per_action') {
        this.deps.grantStore.consumeGrant(grant.id);
      }
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

  sendCommand(
    attachment: BrowserExistingTabAttachment,
    command: BrowserExtensionCommandName,
    payload?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
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
      timeoutMs,
    });
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
      const fresh = this.deps.extensionTabStore.attachTab({
        ...tab,
        allowedOrigins: attachment.allowedOrigins,
      });
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
          text: redactBrowserText(fresh.text ?? '').slice(0, 12_000),
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
        text: redactBrowserText(attachment.text ?? '').slice(0, 12_000),
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
