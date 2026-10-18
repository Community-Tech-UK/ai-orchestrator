import type { BrowserExtensionCommandQueueKey, BrowserExtensionQueuedCommand, BrowserExtensionCommandChannelState } from './browser-extension-command-store';

export interface PendingCommand {
  queueKey: BrowserExtensionCommandQueueKey;
  command: BrowserExtensionQueuedCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  /** Full execution window granted once a poller picks the command up. */
  executionWindowMs: number;
  /** Absolute limit for safe delivery/re-delivery before extension execution. */
  undeliveredDeadlineAt: number;
  /** Set when a poller takes the command; undefined while still queued. */
  dequeuedAt?: number;
  /** The install (Chrome profile) whose poll took the command, when it reported one. */
  deliveredToInstanceId?: string;
  /** Set when the extension acknowledges receiving the command. */
  receivedAt?: number;
  describeChannelState?: () => BrowserExtensionCommandChannelState;
  beforeDelivery?: () => void;
  onDelivered?: (delivery: BrowserExtensionCommandDelivery) => void;
}

/** Which extension install (Chrome profile) a poll handed a command to. */
export interface BrowserExtensionCommandDelivery {
  extensionInstanceId?: string;
}

export interface CommandPoller {
  /** The polling extension install; absent for builds before instance ids. */
  extensionInstanceId?: string;
  deferHandoffConfirmation: boolean;
  allowBrowserCommands: boolean;
  denyBrowserCommandsReason?: string;
  allowSecureCredentialCommands: boolean;
  resolve: (command: BrowserExtensionQueuedCommand | null) => void;
}

/**
 * A command bound to one extension install (it targets that profile's tab)
 * may only go to a poll from that install. Unbound commands go to any poll.
 */
export function pollerServesCommandInstance(
  poller: Pick<CommandPoller, 'extensionInstanceId'>,
  command: BrowserExtensionQueuedCommand,
): boolean {
  const wanted = command.target?.extensionInstanceId;
  return !wanted || poller.extensionInstanceId === wanted;
}

export function isOriginBoundCredentialCommand(command: BrowserExtensionQueuedCommand): boolean {
  // http_auth_navigate always carries a vault credential (username + password
  // staged for Chrome's HTTP auth prompt), so it needs the same secure-runtime
  // poller capability as an origin-bound credential write.
  if (command.command === 'http_auth_navigate') {
    return true;
  }
  if (command.command !== 'type') {
    return false;
  }
  const credentialOrigin = command.payload?.['credentialOrigin'];
  return typeof credentialOrigin === 'string';
}

export function formatDeliveredCommandTimeout(
  channelState: BrowserExtensionCommandChannelState | undefined,
): string {
  if (!channelState) {
    return 'browser_extension_command_timeout';
  }
  if (!channelState.active) {
    return `browser_extension_channel_down (${channelState.summary})`;
  }
  return `browser_extension_command_timeout (channel active - command not answered; ${channelState.summary})`;
}

