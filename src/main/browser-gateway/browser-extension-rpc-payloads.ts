import type {
  BrowserExtensionCommandResult,
  BrowserExtensionPollRequest,
} from './browser-extension-command-store';
import { normalizeBrowserExtensionInstanceId } from './browser-extension-contact-state';

// Validation for the local extension native-host RPC payloads. The remote
// relay path validates the same messages with Zod in remote-node/rpc-schemas.

/**
 * A worker can briefly run a native host newer than its relay process (bundle
 * rebuilt, relay not yet restarted). That relay leaves the install id inside
 * the tab payload, which the strict tab schema would reject. Drop it there:
 * the relay's polls carry no id either, so the node stays consistently on the
 * pre-id behaviour until the relay restarts and sends the id beside the payload.
 */
export function withoutNestedExtensionInstanceId(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const { extensionInstanceId: _extensionInstanceId, ...rest } = payload as Record<string, unknown>;
  return rest;
}

/** The reporting install (Chrome profile), or undefined for pre-id builds. */
export function browserExtensionInstanceIdFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  return normalizeBrowserExtensionInstanceId(payload['extensionInstanceId']);
}

export function validateExtensionPollPayload(
  payload: Record<string, unknown>,
): BrowserExtensionPollRequest {
  const timeoutMs = payload['timeoutMs'];
  if (timeoutMs === undefined) {
    return {};
  }
  if (
    typeof timeoutMs !== 'number'
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 0
    || timeoutMs > 25_000
  ) {
    throw new Error('Invalid browser gateway extension command payload');
  }
  return { timeoutMs };
}

export function validateExtensionCommandResultPayload(
  payload: Record<string, unknown>,
): BrowserExtensionCommandResult {
  const commandId = payload['commandId'];
  const ok = payload['ok'];
  if (typeof commandId !== 'string' || !commandId) {
    throw new Error('Invalid browser gateway extension command payload');
  }
  if (typeof ok !== 'boolean') {
    throw new Error('Invalid browser gateway extension command payload');
  }
  const result: BrowserExtensionCommandResult = {
    commandId,
    ok,
  };
  if ('result' in payload) {
    result.result = payload['result'];
  }
  const error = payload['error'];
  if (error !== undefined) {
    if (typeof error !== 'string' || !error) {
      throw new Error('Invalid browser gateway extension command payload');
    }
    result.error = error;
  }
  return result;
}
