import type { BrowserExtensionCommandQueueKey, BrowserExtensionQueuedCommand, BrowserExtensionCommandName, BrowserExtensionCommandTarget } from './browser-extension-command-store';

/** Coordinator-generated UUIDs only: peer strings must never become log content. */
export function isBrowserExtensionCommandId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export interface BrowserExtensionSendCommandRequest {
  queueKey?: BrowserExtensionCommandQueueKey;
  command: BrowserExtensionCommandName;
  target?: BrowserExtensionCommandTarget;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  executionTimeoutMs?: number;
  /**
   * How long the command may wait in the queue for an extension poller before
   * failing as `browser_extension_command_not_delivered`. Defaults to
   * `timeoutMs`. Set LARGER than `timeoutMs` to ride out a transient extension
   * channel gap (MV3 service-worker suspension recovers via a ≤60s alarm
   * cycle): while undelivered the command has provably not run, so waiting —
   * or retrying after `not_delivered` — is safe even for mutating commands.
   * Once delivered, the command gets its full `timeoutMs` execution window.
   */
  undeliveredWaitMs?: number;
  describeChannelState?: () => BrowserExtensionCommandChannelState;
  /** Main-process only; retained through queue waits and safe redelivery, never serialized. */
  beforeDelivery?: () => void;
  /** Main-process audit correlation; called once, before the command can be polled. */
  onQueued?: (commandId: string) => void;
  /** Names the install (Chrome profile) each poll that takes the command came from;
   * after a requeue the last call wins. Lets `open_tab` learn the new tab's profile. */
  onDelivered?: (delivery: BrowserExtensionCommandDelivery) => void;
}

export interface BrowserExtensionCommandChannelState {
  active: boolean;
  summary: string;
}

export interface BrowserExtensionQueueSnapshot {
  queueKey: BrowserExtensionCommandQueueKey;
  queuedCount: number;
  inFlightCount: number;
  waitingPollerCount: number;
}

export interface BrowserExtensionPollRequest {
  timeoutMs?: number;
  /** The polling extension install (Chrome profile), when the build reports one. */
  extensionInstanceId?: string;
  /** Remote relay polls wait for the RPC transport to confirm socket handoff. */
  deferHandoffConfirmation?: boolean;
  /** False when this exact authenticated runtime is too old to enforce observation taint. */
  allowBrowserCommands?: boolean;
  /** Distinct fail-closed reason when `allowBrowserCommands` is false. */
  denyBrowserCommandsReason?: string;
  /** True only when this exact authenticated poll can enforce origin-bound credential writes. */
  allowSecureCredentialCommands?: boolean;
}

export interface BrowserExtensionCommandResult {
  queueKey?: BrowserExtensionCommandQueueKey;
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

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
  /** Counts coordinator dispatches, including handoffs proven unsent. Not executions. */
  deliveryAttempt: number;
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

