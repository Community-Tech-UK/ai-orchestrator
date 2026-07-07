import type {
  WebhookCreateRouteInput,
  WebhookDeliveryRecord,
  WebhookRouteConfig,
  WebhookServerStatus,
} from '../../shared/types/webhook.types';

export type {
  WebhookCreateRouteInput,
  WebhookDeliveryRecord,
  WebhookRouteConfig,
  WebhookServerStatus,
};

export interface WebhookRuntimeRouteConfig extends WebhookRouteConfig {
  signingSecret: string;
}

export interface WebhookServerOptions {
  port?: number;
  allowUnsignedDev?: boolean;
  maxRequestsPerWindow?: number;
  rateLimitWindowMs?: number;
  deliveryTtlMs?: number;
}
