/**
 * Provider Event Normalizer
 *
 * Implements the ProviderEventMapper interface from @contracts/types
 * to normalize raw adapter events into the provider-agnostic
 * ProviderRuntimeEvent stream.
 *
 * One normalizer per provider adapter. Consumers listen to the normalized
 * stream instead of per-provider event shapes.
 */

import { randomUUID } from 'node:crypto';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
  ProviderEventMapper,
} from '@contracts/types/provider-runtime-events';
import type { OutputMessage, ContextUsage } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('EventNormalizer');

// ============================================
// Claude Event Mapper
// ============================================

export class ClaudeEventMapper implements ProviderEventMapper {
  readonly provider = 'claude';

  normalize(rawEventType: string, ...args: unknown[]): ProviderRuntimeEvent | null {
    switch (rawEventType) {
      case 'output': {
        const message = args[0] as OutputMessage;
        return {
          kind: 'output',
          content: message.content,
          messageType: message.type,
          metadata: message.metadata,
        };
      }
      case 'status': {
        const status = args[0] as string;
        return { kind: 'status', status };
      }
      case 'context': {
        const usage = args[0] as ContextUsage;
        return {
          kind: 'context',
          used: usage.used,
          total: usage.total,
          percentage: usage.percentage,
        };
      }
      case 'error': {
        const error = args[0];
        return {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        };
      }
      case 'exit': {
        const code = args[0] as number | null;
        const signal = args[1] as string | null;
        return { kind: 'exit', code, signal };
      }
      case 'spawned': {
        const pid = args[0] as number;
        return { kind: 'spawned', pid };
      }
      case 'complete': {
        return { kind: 'complete' };
      }
      default:
        return null;
    }
  }
}

// ============================================
// Codex Event Mapper
// ============================================

export class CodexEventMapper implements ProviderEventMapper {
  readonly provider = 'codex';

  normalize(rawEventType: string, ...args: unknown[]): ProviderRuntimeEvent | null {
    switch (rawEventType) {
      case 'output': {
        const message = args[0] as OutputMessage;
        return {
          kind: 'output',
          content: message.content,
          messageType: message.type,
          metadata: message.metadata,
        };
      }
      case 'status': {
        const status = args[0] as string;
        return { kind: 'status', status };
      }
      case 'context': {
        const usage = args[0] as ContextUsage;
        return {
          kind: 'context',
          used: usage.used,
          total: usage.total,
          percentage: usage.percentage,
        };
      }
      case 'error': {
        const error = args[0];
        return {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        };
      }
      case 'exit': {
        return { kind: 'exit', code: args[0] as number | null, signal: args[1] as string | null };
      }
      case 'spawned': {
        return { kind: 'spawned', pid: args[0] as number };
      }
      case 'complete': {
        return { kind: 'complete' };
      }
      default:
        return null;
    }
  }
}

// ============================================
// Gemini Event Mapper
// ============================================

export class GeminiEventMapper implements ProviderEventMapper {
  readonly provider = 'gemini';

  normalize(rawEventType: string, ...args: unknown[]): ProviderRuntimeEvent | null {
    // Gemini and Codex share the same event shapes
    return new CodexEventMapper().normalize(rawEventType, ...args);
  }
}

// ============================================
// Copilot Event Mapper
// ============================================

export class CopilotEventMapper implements ProviderEventMapper {
  readonly provider = 'copilot';

  normalize(rawEventType: string, ...args: unknown[]): ProviderRuntimeEvent | null {
    // Copilot shares the same event shapes as Codex/Gemini
    return new CodexEventMapper().normalize(rawEventType, ...args);
  }
}

// ============================================
// Mapper Registry
// ============================================

const mapperRegistry = new Map<string, ProviderEventMapper>();

/** Register a provider event mapper. */
export function registerEventMapper(mapper: ProviderEventMapper): void {
  mapperRegistry.set(mapper.provider, mapper);
}

/** Get the event mapper for a provider. */
export function getEventMapper(provider: string): ProviderEventMapper | undefined {
  return mapperRegistry.get(provider);
}

/**
 * Wrap a raw adapter event into a normalized envelope.
 * Returns null if the event type is unrecognized by the mapper.
 *
 * @param seq Per-instance monotonic counter. Phase 1 bridging passes a
 *   literal `0`; real sequencing arrives in Task 8 (subscribe-to-self bridge).
 */
export function normalizeAdapterEvent(
  provider: string,
  instanceId: string,
  rawEventType: string,
  args: unknown[],
  sessionId?: string,
  seq: number = 0,
): ProviderRuntimeEventEnvelope | null {
  const mapper = mapperRegistry.get(provider);
  if (!mapper) {
    logger.warn('No event mapper registered for provider', { provider });
    return null;
  }

  const event = mapper.normalize(rawEventType, ...args);
  if (!event) return null;

  const envelope: ProviderRuntimeEventEnvelope = {
    eventId: randomUUID(),
    seq,
    timestamp: Date.now(),
    provider: provider as ProviderName,
    instanceId,
    sessionId,
    event,
  };
  return envelope;
}

// Register built-in mappers
registerEventMapper(new ClaudeEventMapper());
registerEventMapper(new CodexEventMapper());
registerEventMapper(new GeminiEventMapper());
registerEventMapper(new CopilotEventMapper());
