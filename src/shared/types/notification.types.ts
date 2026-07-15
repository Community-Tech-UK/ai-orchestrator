/** A notification retained in the in-app notification center. */
export type NotificationUrgency = 'normal' | 'critical';

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
