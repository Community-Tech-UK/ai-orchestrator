/**
 * Structured routing, binding and failover events for provider account pools.
 *
 * Like `copilot-account-events.ts`, the payload is a CLOSED set of fields:
 * this feature sits next to OAuth credentials, profile homes and child
 * environments, so there is no free-form metadata bag that a later edit could
 * fill with a token, a path, an environment value or prompt content.
 */

import type {
  AccountBindingState,
  AccountHandoffKind,
  AccountInvocationOrigin,
  AccountRouteFailureCode,
  AccountRouteSource,
  PooledProvider,
} from '../../../shared/types/provider-account.types';
import { getLogger } from '../../logging/logger';
import { recordLifecycleTrace } from '../../observability/lifecycle-trace';

const logger = getLogger('ProviderAccountEvents');

export type ProviderAccountEventName =
  | 'account_route_resolved'
  | 'account_route_blocked'
  | 'account_binding_checked'
  | 'account_login_launched'
  | 'account_login_command_copied'
  | 'account_failover_performed'
  | 'account_failover_offered'
  | 'account_pool_exhausted';

export interface ProviderAccountEvent {
  event: ProviderAccountEventName;
  provider: PooledProvider;
  /** Safe slug. */
  profileId?: string;
  /** Failover source profile. */
  fromProfileId?: string;
  nodeId?: string;
  origin?: AccountInvocationOrigin;
  routingSource?: AccountRouteSource;
  failureCode?: AccountRouteFailureCode;
  state?: AccountBindingState;
  handoffKind?: AccountHandoffKind;
  /** Epoch ms. */
  resumeAt?: number;
  instanceId?: string;
}

type EventSink = (event: ProviderAccountEvent) => void;

let sink: EventSink | null = null;

/** Test seam. Production writes to the lifecycle trace and the subsystem log. */
export function _setProviderAccountEventSinkForTesting(next: EventSink | null): void {
  sink = next;
}

const FIELDS = ['profileId', 'fromProfileId', 'nodeId', 'origin', 'routingSource', 'failureCode', 'state', 'handoffKind', 'resumeAt'] as const;

export function emitProviderAccountEvent(event: ProviderAccountEvent): void {
  if (sink) {
    sink(event);
    return;
  }
  const fields: Record<string, string | number> = { provider: event.provider };
  for (const field of FIELDS) {
    const value = event[field];
    if (value !== undefined) fields[field] = value;
  }
  logger.info(event.event, fields);
  recordLifecycleTrace({
    instanceId: event.instanceId ?? 'provider-account',
    eventType: event.event,
    provider: event.provider,
    metadata: fields,
  });
}
