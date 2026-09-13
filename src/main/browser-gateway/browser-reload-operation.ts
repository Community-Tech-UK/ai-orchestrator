import type {
  BrowserGatewayResult,
  BrowserReloadResult,
} from '@contracts/types/browser';
import { isOriginAllowed } from './browser-origin-policy';
import type { BrowserExtensionTabStore } from './browser-extension-tab-store';
import type { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import type { BrowserGatewayActionGuard } from './browser-gateway-action-guard';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayReloadRequest } from './browser-gateway-service-types';
import { extractTabPayload } from './browser-gateway-service-helpers';
import { redactBrowserText, redactBrowserUrl } from './browser-redaction';
import { classifyBrowserTargetLiveness } from './browser-target-liveness';

interface BrowserReloadOperationDeps {
  extensionTabStore: Pick<BrowserExtensionTabStore, 'getTab' | 'attachTab'>;
  existingTabOperations: Pick<BrowserExistingTabOperations, 'sendCommand'>;
  actionGuard: BrowserGatewayActionGuard;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

export class BrowserReloadOperation {
  constructor(private readonly deps: BrowserReloadOperationDeps) {}

  async run(
    request: BrowserGatewayReloadRequest,
  ): Promise<BrowserGatewayResult<BrowserReloadResult | null>> {
    const attachment = this.deps.extensionTabStore.getTab(request.profileId, request.targetId);
    if (!attachment) {
      return this.deps.result({
        context: request, profileId: request.profileId, targetId: request.targetId,
        action: 'reload', toolName: 'browser.reload', actionClass: 'navigate',
        decision: 'denied', outcome: 'not_run', reason: 'browser_reload_requires_existing_tab',
        summary: 'browser.reload is available only for shared existing Chrome tabs', data: null,
      });
    }

    const currentOrigin = isOriginAllowed(attachment.url, attachment.allowedOrigins);
    if (!currentOrigin.allowed) {
      return this.deps.result({
        context: request, profileId: attachment.profileId, targetId: attachment.targetId,
        action: 'reload', toolName: 'browser.reload', actionClass: 'navigate',
        decision: 'denied', outcome: 'not_run', reason: currentOrigin.reason,
        summary: `Existing Chrome tab reload denied by Browser Gateway origin policy: ${currentOrigin.reason}`,
        url: redactBrowserUrl(attachment.url).slice(0, 2_000), data: null,
      });
    }

    const prepared = await this.deps.actionGuard.prepareMutatingAction(
      request, 'reload', 'browser.reload', ':root', 'Reload the current document in place',
      { actionClass: 'navigate', hardStop: false },
    );
    if (prepared.result) {
      return prepared.result as BrowserGatewayResult<BrowserReloadResult | null>;
    }
    const recheck = this.deps.actionGuard.recheckPreparedGrant(
      request, 'reload', 'browser.reload', prepared,
    );
    if (recheck) {
      return recheck as BrowserGatewayResult<BrowserReloadResult | null>;
    }

    try {
      const raw = await this.deps.existingTabOperations.sendCommand(attachment, 'reload', {
        expectedOrigin: currentOrigin.origin,
      });
      this.deps.actionGuard.recordMutationSucceeded(prepared);
      const tab = extractTabPayload(raw);
      const refreshedOrigin = isOriginAllowed(tab.url, attachment.allowedOrigins);
      if (!refreshedOrigin.allowed) {
        return this.deps.result({
          context: request, profileId: attachment.profileId, targetId: attachment.targetId,
          action: 'reload', toolName: 'browser.reload', actionClass: 'navigate',
          decision: 'allowed', outcome: 'failed', reason: refreshedOrigin.reason,
          summary: `Existing Chrome tab reload crossed the allowed origin policy: ${refreshedOrigin.reason}`,
          origin: refreshedOrigin.origin, url: redactBrowserUrl(tab.url).slice(0, 2_000),
          grantId: prepared.grant.id,
          autonomous: prepared.grant.autonomous, data: null,
        });
      }
      const attachOptions = attachment.nodeId || attachment.nodeName ? {
        ...(attachment.nodeId ? { nodeId: attachment.nodeId } : {}),
        ...(attachment.nodeName ? { nodeName: attachment.nodeName } : {}),
      } : undefined;
      const refreshed = this.deps.extensionTabStore.attachTab(
        { ...tab, allowedOrigins: attachment.allowedOrigins },
        attachOptions,
      );
      const protectedText = redactBrowserText(refreshed.text ?? '');
      const safeText = protectedText.slice(0, 200);
      const safeUrl = redactBrowserUrl(refreshed.url).slice(0, 2_000);
      const liveness = classifyBrowserTargetLiveness({ text: protectedText });
      return this.deps.result({
        context: request, profileId: refreshed.profileId, targetId: refreshed.targetId,
        action: 'reload', toolName: 'browser.reload', actionClass: 'navigate',
        decision: 'allowed', outcome: 'succeeded',
        summary: 'Reloaded the selected existing Chrome tab in place',
        origin: refreshedOrigin.origin, url: safeUrl, grantId: prepared.grant.id,
        autonomous: prepared.grant.autonomous,
        data: {
          url: safeUrl,
          title: redactBrowserText(refreshed.title ?? '').slice(0, 500),
          text: safeText,
          inspectionState: refreshed.inspectionState ?? 'readable',
          ...(refreshed.textUnavailableReason
            ? { textUnavailableReason: redactBrowserText(
              refreshed.textUnavailableReason,
            ).slice(0, 200) }
            : {}),
          ...(liveness.clockText ? { clockText: liveness.clockText } : {}),
        },
      });
    } catch (error) {
      return this.deps.actionGuard.mutationFailed(
        request, 'reload', 'browser.reload', prepared, error,
      ) as BrowserGatewayResult<BrowserReloadResult | null>;
    }
  }
}
