/**
 * OpenCode ACP session markers (A6.5-A6.6, Step 11c).
 *
 * OpenCode 2.x forwards each scheduled retry as a `session_info_update` with
 * `_meta["opencode/retry"] = { attempt, nextRetryAt, error: { type, message } }`
 * and clears it with `null` at the next step. Compaction markers arrive the
 * same way as `_meta["opencode/compaction"]` with a `status` of `started`,
 * `completed` or `failed` (2.0.2x and later). Other ACP agents never send
 * these keys, so the reader returns null for them.
 */

import type { AcpRetryStateUpdate } from '../../../shared/types/cli.types';

export type OpenCodeSessionInfoMarker =
  | { kind: 'retry'; update: AcpRetryStateUpdate }
  | { kind: 'retry-cleared' }
  | { kind: 'compaction'; status: 'started' | 'completed' | 'failed' }
  | null;

export interface OpenCodeMarkerHandlers {
  onRetry: (update: AcpRetryStateUpdate) => void;
  onRetryCleared: () => void;
  onCompactionCompleted: () => void;
}

/**
 * Dispatch one `session_info_update` to its handler; returns true when a
 * marker consumed the update (Step 11c). Keeps the adapter's switch small.
 */
export function dispatchOpenCodeSessionInfoMarker(
  rawUpdate: Record<string, unknown>,
  handlers: OpenCodeMarkerHandlers,
): boolean {
  const marker = readOpenCodeSessionInfoMarker(rawUpdate);
  if (!marker) return false;
  if (marker.kind === 'retry') {
    handlers.onRetry(marker.update);
    return true;
  }
  if (marker.kind === 'retry-cleared') {
    handlers.onRetryCleared();
    return true;
  }
  if (marker.kind === 'compaction' && marker.status === 'completed') {
    handlers.onCompactionCompleted();
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one `session_info_update` payload for OpenCode's `_meta` markers.
 * Returns null when the update carries none of them.
 */
export function readOpenCodeSessionInfoMarker(
  rawUpdate: Record<string, unknown>,
): OpenCodeSessionInfoMarker {
  const meta = rawUpdate['_meta'];
  if (!isRecord(meta)) return null;

  const retry = meta['opencode/retry'];
  if (retry === null) return { kind: 'retry-cleared' };
  if (isRecord(retry)) {
    const error = retry['error'];
    // Provider messages can include prompt text or credentials. Match the
    // current ACP update reader's bounded HTTP-status diagnostic.
    const status = isRecord(error) ? error['status'] : undefined;
    const reason = typeof status === 'number' && Number.isInteger(status)
      ? `Provider returned HTTP ${status}.`
      : undefined;
    const attempt = typeof retry['attempt'] === 'number' ? retry['attempt'] : undefined;
    return {
      kind: 'retry',
      update: {
        sessionUpdate: 'retry_state',
        type: 'retrying',
        ...(attempt !== undefined ? { attempt } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
    };
  }

  const compaction = meta['opencode/compaction'];
  if (isRecord(compaction)) {
    const status = compaction['status'];
    if (status === 'started' || status === 'completed' || status === 'failed') {
      return { kind: 'compaction', status };
    }
  }
  return null;
}
