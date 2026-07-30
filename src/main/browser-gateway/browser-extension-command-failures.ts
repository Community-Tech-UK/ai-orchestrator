/**
 * Agent-facing wording for a failed existing-tab extension command.
 *
 * `reason` is the only field the calling agent sees, so each failure has to say
 * what happened, whether the command ran, and what to do next. Getting that
 * wrong has real cost: an undecorated read timeout reads like a refusal, and
 * agents responded by re-requesting a permission grant — which put a fresh
 * approval dialog in front of the user for a site they had just approved.
 */

import type { BrowserExtensionCommandName } from './browser-extension-command-store';

export function isDeliveredCommandTimeout(message: string): boolean {
  return message.startsWith('browser_extension_command_timeout') ||
    // The extension reached its own ceiling on one CDP hop and named it, rather
    // than letting the whole command window expire anonymously.
    message.startsWith('browser_extension_cdp_timeout') ||
    message.startsWith('browser_extension_channel_down');
}

export function isMissingExtensionTabError(message: string): boolean {
  return /\bno tab with id\b/i.test(message);
}

/** The CDP hop the extension reported as stalled, when it named one. */
export function cdpTimeoutStep(message: string): string | undefined {
  return /browser_extension_cdp_timeout:([^\s)]+)/.exec(message)?.[1];
}

/**
 * Removed from the queue before rejection: the extension never received the
 * command, so it certainly did not run — even a mutation is safe to retry.
 */
export function notDeliveredError(channel: string): Error {
  return new Error(
    `browser_extension_command_not_delivered (${channel}; `
    + 'the command never reached the extension and did NOT run — safe to retry)',
  );
}

/**
 * Delivered to the transport, but the extension never acked receiving it — the
 * handoff almost certainly died en route. Weaker guarantee than not_delivered
 * (the ack itself could have been lost), hence the verify-first advice.
 */
export function receiptMissingError(channel: string): Error {
  return new Error(
    `browser_extension_command_receipt_missing (${channel}; `
    + 'the extension never acknowledged receiving this command — it almost certainly did not '
    + 'run, but verify page state before retrying a mutation)',
  );
}

/**
 * A read that timed out is a page or transport failure, never an authorization
 * one. Say so in the words an agent will act on.
 */
export function readTimeoutError(
  message: string,
  command: BrowserExtensionCommandName,
  channel: string,
): Error {
  return new Error(
    `${message} (${channel}; the page did not answer the ${command} command in time. `
    + 'This is a page or transport failure, NOT a permission problem — do not call '
    + 'browser.request_grant. Retry once, or read the page with browser.query_elements '
    + 'or browser.snapshot instead)',
  );
}

/**
 * A mutation that timed out after delivery may already have applied, so the
 * verdict from the post-timeout read-back probe is appended for the caller.
 */
export function mutationTimeoutError(message: string, probe: string): Error {
  return message === 'browser_extension_command_timeout'
    ? new Error(`browser_extension_command_timeout_${probe}`)
    : new Error(`${message}; post-timeout mutation probe: ${probe}`);
}
