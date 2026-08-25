/**
 * Structured routing/binding events for Copilot account routing (spec §18).
 *
 * The payload shape is a deliberately CLOSED set of fields. Everything this
 * feature touches — Copilot config files, child environments, login flows —
 * is adjacent to credential material, so the event type does not carry a
 * free-form `metadata` bag that a later edit could fill with a token, a raw
 * config body, an environment value, prompt content, a device code, or a
 * filesystem path. If a new field is genuinely needed, add it here explicitly
 * and extend the negative test in copilot-account-events.spec.ts.
 */

import type {
  CopilotAccountBindingState,
  CopilotInvocationOrigin,
  CopilotRouteFailureCode,
  CopilotRouteSource,
} from '../../../shared/types/copilot-account.types';
import { getLogger } from '../../logging/logger';
import { recordLifecycleTrace } from '../../observability/lifecycle-trace';

const logger = getLogger('CopilotAccountEvents');

export type CopilotAccountEventName =
  | 'copilot_account_route_resolved'
  | 'copilot_account_route_blocked'
  | 'copilot_account_binding_checked'
  | 'copilot_account_identity_mismatch'
  | 'copilot_account_login_launched';

export interface CopilotAccountEvent {
  event: CopilotAccountEventName;
  /** Safe slug. */
  profileId?: string;
  /** Execution node identity, not an address. */
  nodeId?: string;
  origin?: CopilotInvocationOrigin;
  routingSource?: CopilotRouteSource;
  ruleId?: string;
  failureCode?: CopilotRouteFailureCode;
  state?: CopilotAccountBindingState;
  /** GitHub login only — never a token, and never the config that held one. */
  observedLogin?: string;
  /** Normalized hostname only. */
  observedHost?: string;
  instanceId?: string;
}

type EventSink = (event: CopilotAccountEvent) => void;

let sink: EventSink | null = null;

/** Test seam. Production writes to the lifecycle trace and the subsystem log. */
export function _setCopilotAccountEventSinkForTesting(next: EventSink | null): void {
  sink = next;
}

export function emitCopilotAccountEvent(event: CopilotAccountEvent): void {
  if (sink) {
    sink(event);
    return;
  }
  logger.info(event.event, {
    ...(event.profileId ? { profileId: event.profileId } : {}),
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.origin ? { origin: event.origin } : {}),
    ...(event.routingSource ? { routingSource: event.routingSource } : {}),
    ...(event.ruleId ? { ruleId: event.ruleId } : {}),
    ...(event.failureCode ? { failureCode: event.failureCode } : {}),
    ...(event.state ? { state: event.state } : {}),
    ...(event.observedLogin ? { observedLogin: event.observedLogin } : {}),
    ...(event.observedHost ? { observedHost: event.observedHost } : {}),
  });
  recordLifecycleTrace({
    instanceId: event.instanceId ?? 'copilot-account',
    eventType: event.event,
    provider: 'copilot',
    metadata: {
      ...(event.profileId ? { profileId: event.profileId } : {}),
      ...(event.nodeId ? { nodeId: event.nodeId } : {}),
      ...(event.origin ? { origin: event.origin } : {}),
      ...(event.routingSource ? { routingSource: event.routingSource } : {}),
      ...(event.ruleId ? { ruleId: event.ruleId } : {}),
      ...(event.failureCode ? { failureCode: event.failureCode } : {}),
      ...(event.state ? { state: event.state } : {}),
      ...(event.observedLogin ? { observedLogin: event.observedLogin } : {}),
      ...(event.observedHost ? { observedHost: event.observedHost } : {}),
    },
  });
}
