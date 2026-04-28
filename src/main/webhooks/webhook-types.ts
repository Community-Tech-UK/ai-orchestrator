import type { WebhookDeliveryRecord, WebhookRouteConfig, WebhookServerStatus } from '../../shared/types/webhook.types';

export type {
  WebhookDeliveryRecord,
  WebhookRouteConfig,
  WebhookServerStatus,
};

export interface WebhookCreateRouteInput {
  path: string;
  secret: string;
  enabled?: boolean;
  allowUnsignedDev?: boolean;
  maxBodyBytes?: number;
  allowedAutomationIds?: string[];
  allowedEvents?: string[];
}

export interface WebhookServerOptions {
  port?: number;
  allowUnsignedDev?: boolean;
}
