import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventRaw,
} from '@contracts/types/provider-runtime-events';

export interface ProviderEventCaptureInput {
  eventId: string;
  provider: ProviderName;
  instanceId: string;
  sessionId: string | null;
  sequence: number;
  createdAt: number;
  event: ProviderRuntimeEvent;
  raw: ProviderRuntimeEventRaw;
}

export interface ProviderEventCaptureRecord extends ProviderEventCaptureInput {}

export interface ProviderEventCaptureQuery {
  instanceId: string;
  limit?: number;
}
