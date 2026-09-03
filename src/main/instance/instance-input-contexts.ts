/**
 * Send-path input-context assembly and preflight timeouts.
 *
 * Extracted from `instance-manager.ts` so the coordinator stays inside its
 * LOC ceiling. Callers pass the live context port and preamble queue; this
 * module does not own instance state. Behaviour matches the previous
 * private methods.
 */

import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import { getContextEngine } from '../context/context-engine.js';
import {
  getIndexedCodebaseContextService,
  type IndexedCodebaseContextInfo,
} from '../indexing/indexed-codebase-context';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceContextPort } from './instance-context-port';
import type { RlmContextInfo, UnifiedMemoryContextInfo } from './instance-types';

const logger = getLogger('InstanceManager');

export const INPUT_CONTEXT_DEADLINE_MS = 500;

export interface InputContextBundle {
  rlmContext: RlmContextInfo | null;
  unifiedMemoryContext: UnifiedMemoryContextInfo | null;
  indexedCodebaseContext: IndexedCodebaseContextInfo | null;
}

export interface InputPreflightTimeoutOptions<T> {
  instanceId: string;
  phase: string;
  timeoutMs: number;
  operation: () => Promise<T>;
  onTimeout?: () => T;
  timeoutMessage?: string;
}

export interface InputContextAssemblyDeps {
  context: InstanceContextPort;
  queueContinuityPreamble: (instanceId: string, preamble: string) => void;
}

export async function runInputPreflight<T>({
  instanceId,
  phase,
  timeoutMs,
  operation,
  onTimeout,
  timeoutMessage,
}: InputPreflightTimeoutOptions<T>): Promise<T> {
  const startedAt = Date.now();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      logger.warn('Input preflight exceeded deadline', {
        instanceId,
        phase,
        timeoutMs,
        durationMs: Date.now() - startedAt,
      });

      if (onTimeout) {
        resolve(onTimeout());
        return;
      }

      reject(new Error(timeoutMessage ?? `${phase} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (
      typeof timeoutId === 'object'
      && timeoutId !== null
      && 'unref' in timeoutId
      && typeof timeoutId.unref === 'function'
    ) {
      timeoutId.unref();
    }
  });

  logger.debug('Input preflight started', { instanceId, phase, timeoutMs });

  try {
    const result = await Promise.race([operation(), deadline]);
    logger.debug('Input preflight completed', {
      instanceId,
      phase,
      durationMs: Date.now() - startedAt,
      timedOut,
    });
    return result;
  } catch (error) {
    logger.warn('Input preflight failed', {
      instanceId,
      phase,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function buildInputContexts(
  deps: InputContextAssemblyDeps,
  instance: Instance,
  message: string,
): Promise<InputContextBundle> {
  const assembly = await getContextEngine().assemble({
    instance,
    message,
    contextPort: deps.context,
    taskId: generateId(),
    buildIndexedCodebaseContext: (targetInstance, targetMessage) =>
      buildIndexedCodebaseContext(targetInstance, targetMessage),
  });

  return {
    rlmContext: assembly.rlmContext,
    unifiedMemoryContext: assembly.unifiedMemoryContext,
    indexedCodebaseContext: assembly.indexedCodebaseContext,
  };
}

export async function resolveInputContextsBeforeDeadline(
  instanceId: string,
  contextPromise: Promise<InputContextBundle>,
): Promise<InputContextBundle | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), INPUT_CONTEXT_DEADLINE_MS);
    if (
      typeof timeoutId === 'object'
      && timeoutId !== null
      && 'unref' in timeoutId
      && typeof timeoutId.unref === 'function'
    ) {
      timeoutId.unref();
    }
  });

  try {
    return await Promise.race([contextPromise, deadline]);
  } catch (error) {
    logger.warn('Context generation failed before send deadline; sending without retrieved context', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      rlmContext: null,
      unifiedMemoryContext: null,
      indexedCodebaseContext: null,
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function queueDeferredInputContexts(
  deps: InputContextAssemblyDeps,
  instanceId: string,
  contextPromise: Promise<InputContextBundle>,
): void {
  void contextPromise
    .then((contexts) => {
      logInputContexts(instanceId, contexts, 'deferred');
      const contextBlock = buildContextBlock(deps, contexts);
      if (contextBlock) {
        deps.queueContinuityPreamble(instanceId, contextBlock);
      }
    })
    .catch((error) => {
      logger.warn('Deferred context generation failed', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function buildContextBlock(
  deps: InputContextAssemblyDeps,
  contexts: InputContextBundle | null,
): string | null {
  if (!contexts) {
    return null;
  }

  const contextBlocks = [
    deps.context.formatUnifiedMemoryContextBlock(contexts.unifiedMemoryContext),
    formatIndexedCodebaseContextBlock(contexts.indexedCodebaseContext),
    deps.context.formatRlmContextBlock(contexts.rlmContext),
  ].filter(Boolean) as string[];

  return contextBlocks.length > 0 ? contextBlocks.join('\n\n') : null;
}

export function buildInputContextMetadata(
  contexts: InputContextBundle | null,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (!contexts) {
    return metadata;
  }

  const { rlmContext, unifiedMemoryContext, indexedCodebaseContext } = contexts;
  if (rlmContext) {
    metadata['rlmContext'] = {
      injected: true,
      tokens: rlmContext.tokens,
      sectionsAccessed: rlmContext.sectionsAccessed,
      durationMs: rlmContext.durationMs,
      source: rlmContext.source,
    };
  }
  if (unifiedMemoryContext) {
    metadata['unifiedMemoryContext'] = {
      injected: true,
      tokens: unifiedMemoryContext.tokens,
      longTermCount: unifiedMemoryContext.longTermCount,
      proceduralCount: unifiedMemoryContext.proceduralCount,
      durationMs: unifiedMemoryContext.durationMs,
    };
  }
  if (indexedCodebaseContext) {
    metadata['indexedCodebaseContext'] = {
      injected: true,
      tokens: indexedCodebaseContext.tokens,
      resultCount: indexedCodebaseContext.results.length,
      storeId: indexedCodebaseContext.storeId,
      durationMs: indexedCodebaseContext.durationMs,
    };
  }

  return metadata;
}

export function logInputContexts(
  instanceId: string,
  contexts: InputContextBundle,
  phase: 'current' | 'deferred',
): void {
  const { rlmContext, unifiedMemoryContext, indexedCodebaseContext } = contexts;
  const prefix = phase === 'deferred' ? 'Deferred ' : '';

  if (rlmContext) {
    logger.info(`${prefix}RLM context injected`, {
      instanceId,
      tokens: rlmContext.tokens,
      sections: rlmContext.sectionsAccessed.length,
      durationMs: rlmContext.durationMs,
    });
  }

  if (unifiedMemoryContext) {
    logger.info(`${prefix}UnifiedMemory context injected`, {
      instanceId,
      tokens: unifiedMemoryContext.tokens,
      longTermCount: unifiedMemoryContext.longTermCount,
      proceduralCount: unifiedMemoryContext.proceduralCount,
      durationMs: unifiedMemoryContext.durationMs,
    });
  }

  if (indexedCodebaseContext) {
    logger.info(`${prefix}Indexed codebase context injected`, {
      instanceId,
      tokens: indexedCodebaseContext.tokens,
      resultCount: indexedCodebaseContext.results.length,
      storeId: indexedCodebaseContext.storeId,
      durationMs: indexedCodebaseContext.durationMs,
    });
  }
}

export async function buildIndexedCodebaseContext(
  instance: Instance,
  message: string,
): Promise<IndexedCodebaseContextInfo | null> {
  if (instance.parentId) {
    return null;
  }

  try {
    return await getIndexedCodebaseContextService().buildContext({
      workspacePath: instance.workingDirectory,
      query: message,
      maxTokens: 900,
      topK: 5,
    });
  } catch (error) {
    logger.warn('Failed to build indexed codebase context', {
      instanceId: instance.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function formatIndexedCodebaseContextBlock(
  context: IndexedCodebaseContextInfo | null,
): string | null {
  if (!context) {
    return null;
  }

  try {
    return getIndexedCodebaseContextService().formatContextBlock(context);
  } catch (error) {
    logger.warn('Failed to format indexed codebase context', {
      storeId: context.storeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
