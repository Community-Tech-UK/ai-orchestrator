/**
 * Static Anthropic model catalog for Model Discovery Service
 */

import { CLAUDE_MODELS, CLAUDE_PINNED_MODELS } from '../../shared/types/provider.types';
import type { DiscoveredModel } from './model-discovery.types';

/**
 * Returns the list of known Anthropic models stamped with the current time.
 * Called once per discovery request so lastChecked reflects the actual check time.
 */
export function buildAnthropicKnownModels(): DiscoveredModel[] {
  const now = Date.now();
  return [
    {
      id: CLAUDE_MODELS.OPUS,
      name: 'Claude Opus (latest)',
      displayName: 'Claude Opus (latest)',
      provider: 'anthropic',
      description: 'Most capable model for complex tasks',
      contextLength: 1000000,
      maxOutputTokens: 128000,
      capabilities: {
        vision: true,
        functionCalling: true,
        streaming: true,
        json: true,
        systemMessage: true,
      },
      pricing: {
        inputPer1kTokens: 0.005,
        outputPer1kTokens: 0.025,
        cachePer1kTokens: 0.00625,
        currency: 'USD',
      },
      isAvailable: true,
      lastChecked: now,
    },
    {
      id: CLAUDE_MODELS.OPUS_1M,
      name: 'Claude Opus (latest, 1M)',
      displayName: 'Claude Opus (latest, 1M)',
      provider: 'anthropic',
      description: 'Most capable model with extended 1M context',
      contextLength: 1000000,
      maxOutputTokens: 128000,
      capabilities: {
        vision: true,
        functionCalling: true,
        streaming: true,
        json: true,
        systemMessage: true,
      },
      pricing: {
        inputPer1kTokens: 0.005,
        outputPer1kTokens: 0.025,
        cachePer1kTokens: 0.00625,
        currency: 'USD',
      },
      isAvailable: true,
      lastChecked: now,
    },
    {
      id: CLAUDE_PINNED_MODELS.OPUS_48,
      name: 'Claude Opus 4.8',
      displayName: 'Claude Opus 4.8',
      provider: 'anthropic',
      description: 'Most capable model for long-horizon coding and complex reasoning',
      contextLength: 1000000,
      maxOutputTokens: 128000,
      capabilities: {
        vision: true,
        functionCalling: true,
        streaming: true,
        json: true,
        systemMessage: true,
      },
      pricing: {
        inputPer1kTokens: 0.005,
        outputPer1kTokens: 0.025,
        cachePer1kTokens: 0.00625,
        currency: 'USD',
      },
      isAvailable: true,
      lastChecked: now,
    },
    {
      id: CLAUDE_MODELS.SONNET,
      name: 'Claude Sonnet (latest)',
      displayName: 'Claude Sonnet (latest)',
      provider: 'anthropic',
      description: 'Balanced performance and cost',
      contextLength: 1000000,
      maxOutputTokens: 64000,
      capabilities: {
        vision: true,
        functionCalling: true,
        streaming: true,
        json: true,
        systemMessage: true,
      },
      pricing: {
        inputPer1kTokens: 0.003,
        outputPer1kTokens: 0.015,
        cachePer1kTokens: 0.00375,
        currency: 'USD',
      },
      isAvailable: true,
      lastChecked: now,
    },
    {
      id: CLAUDE_MODELS.SONNET_1M,
      name: 'Claude Sonnet (latest, 1M)',
      displayName: 'Claude Sonnet (latest, 1M)',
      provider: 'anthropic',
      description: 'Balanced performance with extended 1M context',
      contextLength: 1000000,
      maxOutputTokens: 64000,
      capabilities: {
        vision: true,
        functionCalling: true,
        streaming: true,
        json: true,
        systemMessage: true,
      },
      pricing: {
        inputPer1kTokens: 0.003,
        outputPer1kTokens: 0.015,
        cachePer1kTokens: 0.00375,
        currency: 'USD',
      },
      isAvailable: true,
      lastChecked: now,
    },
    {
      id: CLAUDE_MODELS.HAIKU,
      name: 'Claude Haiku (latest)',
      displayName: 'Claude Haiku (latest)',
      provider: 'anthropic',
      description: 'Fast and cost-effective',
      contextLength: 200000,
      maxOutputTokens: 8192,
      capabilities: {
        vision: true,
        functionCalling: true,
        streaming: true,
        json: true,
        systemMessage: true,
      },
      pricing: {
        inputPer1kTokens: 0.001,
        outputPer1kTokens: 0.005,
        cachePer1kTokens: 0.00125,
        currency: 'USD',
      },
      isAvailable: true,
      lastChecked: now,
    },
  ];
}
