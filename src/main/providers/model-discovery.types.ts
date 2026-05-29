/**
 * Types for Model Discovery Service
 */

export interface DiscoveredModel {
  id: string;
  name: string;
  displayName?: string;
  provider: string;
  description?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  pricing?: ModelPricing;
  isAvailable: boolean;
  lastChecked: number;
}

export interface ModelCapabilities {
  vision?: boolean;
  functionCalling?: boolean;
  streaming?: boolean;
  json?: boolean;
  systemMessage?: boolean;
  maxTemperature?: number;
}

export interface ModelPricing {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  cachePer1kTokens?: number;
  currency: string;
}

export interface ProviderModelConfig {
  type: string;
  apiKey?: string;
  baseUrl?: string;
  organizationId?: string;
}

export interface CacheEntry {
  models: DiscoveredModel[];
  timestamp: number;
  expiresAt: number;
}

export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
