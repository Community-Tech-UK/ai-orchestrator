export interface WebhookRouteConfig {
  id: string;
  path: string;
  enabled: boolean;
  secretHash: string;
  allowUnsignedDev: boolean;
  maxBodyBytes: number;
  allowedAutomationIds: string[];
  allowedEvents: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WebhookDeliveryRecord {
  id: string;
  routeId: string;
  deliveryId: string;
  eventType?: string;
  status: 'accepted' | 'duplicate' | 'rejected' | 'failed';
  statusCode?: number;
  error?: string;
  payloadHash: string;
  receivedAt: number;
  processedAt?: number;
  triggerSource?: Record<string, unknown>;
}

export interface WebhookServerStatus {
  running: boolean;
  port?: number;
  routeCount: number;
  recentDeliveries: WebhookDeliveryRecord[];
}
