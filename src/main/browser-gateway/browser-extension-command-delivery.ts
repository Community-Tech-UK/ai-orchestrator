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
  /** Set when the extension acknowledges receiving the command. */
  receivedAt?: number;
  describeChannelState?: () => BrowserExtensionCommandChannelState;
  beforeDelivery?: () => void;
}

export interface CommandPoller {
  deferHandoffConfirmation: boolean;
  allowBrowserCommands: boolean;
  denyBrowserCommandsReason?: string;
  allowSecureCredentialCommands: boolean;
  resolve: (command: BrowserExtensionQueuedCommand | null) => void;
}

export function isOriginBoundCredentialCommand(command: BrowserExtensionQueuedCommand): boolean {
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

