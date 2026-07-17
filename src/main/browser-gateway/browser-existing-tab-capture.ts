import type { BrowserGatewayResult } from '@contracts/types/browser';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserExtensionCommandName } from './browser-extension-command-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayTargetRequest } from './browser-gateway-service-types';
import { isOriginAllowed } from './browser-origin-policy';
import {
  CONSOLE_CAPTURE_UNSUPPORTED_REASON,
  NETWORK_CAPTURE_UNSUPPORTED_REASON,
  captureReportedNotInstalled,
  isUnsupportedCaptureCommandError,
  normalizeCapturedConsoleEntries,
  normalizeCapturedNetworkEntries,
  type BrowserCapturedConsoleEntry,
  type BrowserCapturedNetworkEntry,
} from './browser-console-network-capture';

/** Read timeout for a capture buffer fetch (fast in-page read + glow install). */
const CAPTURE_READ_TIMEOUT_MS = 15_000;

interface ExistingTabCaptureDeps {
  result: <R>(input: BrowserGatewayResultInput<R>) => BrowserGatewayResult<R>;
  sendCommand: (
    attachment: BrowserExistingTabAttachment,
    command: BrowserExtensionCommandName,
    payload: Record<string, unknown> | undefined,
    timeoutMs: number,
  ) => Promise<unknown>;
}

interface ExistingTabCaptureSpec<T> {
  command: BrowserExtensionCommandName;
  toolName: string;
  label: string;
  unsupportedReason: string;
  normalize: (result: unknown) => T[];
}

/**
 * Shared console/network capture read for extension-driven (shared Chrome) tabs.
 *
 * Parity with snapshot/screenshot: any tab the gateway can drive it can also
 * read the console/network buffer from — the target is resolved through the same
 * extension attachment, not the managed-profile store (console-read prompt, req
 * #1). The read is lazy: the extension (re)installs the capture buffer as part
 * of `startControlledTab` inside the command, so no re-share is needed (req #5).
 * An extension too old to know the command yields a distinct capability error,
 * never `profile_target_or_url_not_found` (req #4).
 */
async function readExistingTabCapture<T>(
  deps: ExistingTabCaptureDeps,
  request: BrowserGatewayTargetRequest,
  attachment: BrowserExistingTabAttachment,
  spec: ExistingTabCaptureSpec<T>,
): Promise<BrowserGatewayResult<T[] | null>> {
  const { command, toolName, label, unsupportedReason, normalize } = spec;
  const originDecision = isOriginAllowed(attachment.url, attachment.allowedOrigins);
  if (!originDecision.allowed) {
    return deps.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: command,
      toolName,
      actionClass: 'read',
      decision: 'denied',
      outcome: 'not_run',
      reason: originDecision.reason,
      summary: `Existing-tab ${label} denied by Browser Gateway origin policy: ${originDecision.reason}`,
      url: attachment.url,
      data: null,
    });
  }

  try {
    const result = await deps.sendCommand(attachment, command, undefined, CAPTURE_READ_TIMEOUT_MS);
    const entries = normalize(result);
    const notInstalled = captureReportedNotInstalled(result);
    return deps.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: command,
      toolName,
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: notInstalled
        ? `Read ${label} from selected existing Chrome tab (capture just installed; entries populate on next activity)`
        : `Read ${entries.length} ${label} from selected existing Chrome tab`,
      origin: originDecision.origin,
      url: attachment.url,
      data: entries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = isUnsupportedCaptureCommandError(message) ? unsupportedReason : message;
    return deps.result({
      context: request,
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      action: command,
      toolName,
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'failed',
      reason,
      summary: reason === unsupportedReason
        ? `Existing-tab ${label} unsupported: the Harness browser extension on this tab does not support `
          + 'console/network capture (update the extension)'
        : `Existing-tab ${label} failed: ${message}`,
      origin: originDecision.origin,
      url: attachment.url,
      data: null,
    });
  }
}

export function readExistingTabConsoleMessages(
  deps: ExistingTabCaptureDeps,
  request: BrowserGatewayTargetRequest,
  attachment: BrowserExistingTabAttachment,
): Promise<BrowserGatewayResult<BrowserCapturedConsoleEntry[] | null>> {
  return readExistingTabCapture(deps, request, attachment, {
    command: 'console_messages',
    toolName: 'browser.console_messages',
    label: 'console messages',
    unsupportedReason: CONSOLE_CAPTURE_UNSUPPORTED_REASON,
    normalize: normalizeCapturedConsoleEntries,
  });
}

export function readExistingTabNetworkRequests(
  deps: ExistingTabCaptureDeps,
  request: BrowserGatewayTargetRequest,
  attachment: BrowserExistingTabAttachment,
): Promise<BrowserGatewayResult<BrowserCapturedNetworkEntry[] | null>> {
  return readExistingTabCapture(deps, request, attachment, {
    command: 'network_requests',
    toolName: 'browser.network_requests',
    label: 'network requests',
    unsupportedReason: NETWORK_CAPTURE_UNSUPPORTED_REASON,
    normalize: normalizeCapturedNetworkEntries,
  });
}
