/**
 * Browser Gateway `browser.handle_dialog`: answer a Chrome page pop-up (alert,
 * confirm, prompt, "Leave site?") on a shared Chrome tab.
 *
 * The extension can see a pop-up only if it opened while one of the gateway's
 * own commands was running on the tab; that command then fails with
 * `browser_dialog_open` and the pop-up waits here to be answered. Routed
 * through the action guard like a click on the pop-up's button.
 */

import type { BrowserGatewayResult } from '@contracts/types/browser';
import type { BrowserHandleDialogRequest, BrowserHandleDialogResult } from '@contracts/schemas/browser';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserExtensionCommandName } from './browser-extension-command-store';
import type { BrowserGatewayActionGuard } from './browser-gateway-action-guard';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import { classifyHandleDialogAction } from './browser-action-classifier';
import { normalizeHandleDialogResult } from './browser-extension-result-normalizers';

export interface BrowserDialogDeps {
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  getExistingTab: (
    profileId: string,
    targetId: string,
  ) => BrowserExistingTabAttachment | undefined;
  sendCommand: (
    attachment: BrowserExistingTabAttachment,
    command: BrowserExtensionCommandName,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
  actionGuard: Pick<
    BrowserGatewayActionGuard,
    'prepareMutatingAction' | 'recheckPreparedGrant' | 'recordMutationSucceeded' | 'mutationFailed'
  >;
}

/** Managed profiles run on Puppeteer, which has no pop-up watch. */
export const DIALOG_UNSUPPORTED_MANAGED_REASON = 'browser_dialog_handling_requires_shared_extension_tab';

export async function handleBrowserDialog(
  deps: BrowserDialogDeps,
  request: BrowserGatewayContext & BrowserHandleDialogRequest,
): Promise<BrowserGatewayResult<BrowserHandleDialogResult | null>> {
  const existingTab = deps.getExistingTab(request.profileId, request.targetId);
  if (!existingTab) {
    return deps.result<BrowserHandleDialogResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'handle_dialog',
      toolName: 'browser.handle_dialog',
      actionClass: 'input',
      decision: 'denied',
      outcome: 'not_run',
      reason: DIALOG_UNSUPPORTED_MANAGED_REASON,
      summary:
        'browser.handle_dialog answers pop-ups on shared Chrome tabs only (browser.find_or_open). '
        + 'Managed browser profiles cannot answer page pop-ups.',
      data: null,
    });
  }

  const label = request.accept ? 'dialog:accept' : 'dialog:dismiss';
  const prepared = await deps.actionGuard.prepareMutatingAction(
    request,
    'handle_dialog',
    'browser.handle_dialog',
    label,
    request.actionHint,
    classifyHandleDialogAction({
      accept: request.accept,
      ...(request.actionHint ? { actionHint: request.actionHint } : {}),
    }),
  );
  if (prepared.result) {
    return prepared.result as BrowserGatewayResult<BrowserHandleDialogResult | null>;
  }
  const recheck = deps.actionGuard.recheckPreparedGrant(
    request, 'handle_dialog', 'browser.handle_dialog', prepared,
  );
  if (recheck) {
    return recheck as BrowserGatewayResult<BrowserHandleDialogResult | null>;
  }

  try {
    const data = normalizeHandleDialogResult(
      await deps.sendCommand(existingTab, 'handle_dialog', { accept: request.accept }),
      request.accept,
    );
    deps.actionGuard.recordMutationSucceeded(prepared);
    return deps.result<BrowserHandleDialogResult | null>({
      context: request,
      profileId: request.profileId,
      targetId: request.targetId,
      action: 'handle_dialog',
      toolName: 'browser.handle_dialog',
      actionClass: prepared.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: request.accept
        ? 'browser.handle_dialog accepted the pop-up (Leave / OK). Check the page before carrying on.'
        : 'browser.handle_dialog dismissed the pop-up (Stay / Cancel). Check the page before carrying on.',
      origin: prepared.origin,
      url: prepared.url,
      grantId: prepared.grant.id,
      autonomous: prepared.grant.autonomous,
      data,
    });
  } catch (error) {
    return deps.actionGuard.mutationFailed(
      request, 'handle_dialog', 'browser.handle_dialog', prepared, error,
    ) as BrowserGatewayResult<BrowserHandleDialogResult | null>;
  }
}
