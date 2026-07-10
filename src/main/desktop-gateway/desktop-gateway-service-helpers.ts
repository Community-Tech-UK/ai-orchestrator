import type {
  DesktopGatewayResult,
  DesktopGrantSummary,
} from '../../shared/types/desktop-gateway.types';
import type { DesktopPermissionGrant } from './desktop-grant-store';

/** Wraps a successful result payload in the standard gateway envelope. */
export function allowed<T>(data: T): DesktopGatewayResult<T> {
  return { decision: 'allowed', outcome: 'ok', data };
}

/** Wraps a denial (default `not_run`) in the standard gateway envelope. */
export function denied(
  reason: string,
  outcome: DesktopGatewayResult['outcome'] = 'not_run',
): DesktopGatewayResult<never> {
  return { decision: 'denied', outcome, reason };
}

/**
 * Extracts a stable error code from a thrown error's `code:detail` message,
 * falling back to `fallback` when the error is empty or unshaped.
 */
export function errorReason(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) {
    return fallback;
  }
  const [code] = error.message.split(':');
  return code || fallback;
}

export function metadataFromObject(value: object): Record<string, unknown> {
  return { ...(value as Record<string, unknown>) };
}

export function randomIdPart(): string {
  return Math.random().toString(36).slice(2, 14);
}

/** Projects a stored grant into the redaction-safe summary shape. */
export function toGrantSummary(grant: DesktopPermissionGrant): DesktopGrantSummary {
  return {
    id: grant.id,
    appId: grant.appId,
    capability: grant.capability,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    scope: grant.scope,
    decidedBy: grant.decidedBy,
    ...(grant.reason ? { reason: grant.reason } : {}),
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
  };
}
