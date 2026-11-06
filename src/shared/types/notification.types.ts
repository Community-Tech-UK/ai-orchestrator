/** A notification retained in the in-app notification center. */
export type NotificationUrgency = 'normal' | 'critical';

export type LocalAiIncidentNotificationTransition =
  | 'fallback-possible'
  | 'paid-dispatch'
  | 'budget-critical'
  | 'recovered';

export type LocalAiHelperNotificationKind =
  | 'local-ai-helper-paused' | 'local-ai-helper-resumed' | 'local-ai-helper-daily-limit';

/**
 * Kinds the Automations runner raises. `automation-check-failed` (8b item 6)
 * fires once per streak of failing pre-checks; `automation-breaker` fires when
 * repeated failures auto-disable a job.
 */
export type AutomationNotificationKind = 'automation-check-failed' | 'automation-breaker';

export type LocalAiIncidentNotificationKind =
  `local-ai-${LocalAiIncidentNotificationTransition}`;

export interface LocalAiNotificationEndpointIdentity {
  provider: 'ollama' | 'openai-compatible';
  location: 'coordinator' | 'worker';
  /** Opaque stable identity used only as hash input and never rendered verbatim. */
  stableTargetId: string;
}

export type LocalAiNotificationEndpointIdentityResolver =
  (targetId: string) => LocalAiNotificationEndpointIdentity | undefined;

export type NotificationDelivery =
  | 'desktop'
  | 'fingerprint-suppressed'
  | 'cooldown-suppressed'
  | 'quiet-hours'
  | 'desktop-unavailable';

export interface NotificationRecord {
  id: string;
  kind: string;
  instanceId?: string;
  title: string;
  body: string;
  urgency: NotificationUrgency;
  fingerprint: string;
  createdAt: number;
  delivery: NotificationDelivery;
}
