/**
 * InstanceContextPort — narrow interface for RLM and unified memory operations.
 *
 * Decouples InstanceManager and InstanceCommunicationManager from the concrete
 * InstanceContextManager so that a worker-backed implementation can be swapped
 * in during Task 9 without changing any call sites.
 */

import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { RlmContextInfo, ContextBudget, UnifiedMemoryContextInfo } from './instance-types';

/**
 * Clone-safe snapshot of the instance fields needed by context operations.
 * Structured-clone safe: no functions, EventEmitters, or native handles.
 */
export interface InstanceContextSnapshot {
  id: string;
  sessionId?: string;
  historyThreadId?: string;
  provider?: string;
  workingDirectory: string;
  displayName: string;
  currentModel?: string;
  contextUsage: { used: number; total: number; percentage: number };
}

/**
 * Narrow interface for all RLM / unified-memory operations.
 * The concrete InstanceContextManager implements this; a future worker-backed
 * ContextWorkerClient will implement it too.
 */
export interface InstanceContextPort {
  // ── Instance lifecycle ──────────────────────────────────────────────────────
  initializeRlm(instance: Instance): Promise<void>;
  endRlmSession(instanceId: string): void;
  ingestInitialOutputToRlm(instance: Instance, messages: OutputMessage[]): Promise<void>;

  // ── Hot-path ingestion (fire-and-forget) ─────────────────────────────────────
  ingestToRLM(instanceId: string, message: OutputMessage): void;
  ingestToUnifiedMemory(instance: Instance, message: OutputMessage): void;

  // ── Context retrieval (RPC with timeout) ─────────────────────────────────────
  calculateContextBudget(instance: Instance, message: string): ContextBudget;
  buildRlmContext(
    instanceId: string,
    message: string,
    maxTokens?: number,
    topK?: number,
  ): Promise<RlmContextInfo | null>;
  buildUnifiedMemoryContext(
    instance: Instance,
    message: string,
    taskId: string,
    maxTokens?: number,
  ): Promise<UnifiedMemoryContextInfo | null>;

  // ── Formatting helpers ──────────────────────────────────────────────────────
  formatRlmContextBlock(context: RlmContextInfo | null): string | null;
  formatUnifiedMemoryContextBlock(context: UnifiedMemoryContextInfo | null): string | null;

  // ── Maintenance ─────────────────────────────────────────────────────────────
  compactContext(instanceId: string, instance: Instance): Promise<void>;
}
