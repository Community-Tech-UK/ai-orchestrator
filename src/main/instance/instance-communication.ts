/**
 * Instance Communication Manager - Handles adapter events and message passing
 */

import { EventEmitter } from 'events';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
// History archiving moved exclusively to instance-lifecycle.ts terminateInstance()
import { getSettingsManager } from '../core/config/settings-manager';
import { getOutputStorageManager } from '../memory';
import { getHookManager } from '../hooks/hook-manager';
import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import type {
  Instance,
  InstanceStatus,
  ContextUsage,
  OutputMessage
} from '../../shared/types/instance.types';
import { generateId } from '../../shared/utils/id-generator';

/**
 * Dependencies required by the communication manager
 */
export interface CommunicationDependencies {
  getInstance: (id: string) => Instance | undefined;
  getAdapter: (id: string) => CliAdapter | undefined;
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => boolean;
  queueUpdate: (instanceId: string, status: InstanceStatus, contextUsage?: ContextUsage) => void;
  processOrchestrationOutput: (instanceId: string, content: string) => void;
  onInterruptedExit: (instanceId: string) => Promise<void>;
  onChildExit?: (childId: string, instance: Instance, exitCode: number | null) => void | Promise<void>;
  ingestToRLM: (instanceId: string, message: OutputMessage) => void;
  ingestToUnifiedMemory: (instance: Instance, message: OutputMessage) => void;
  compactContext?: (instanceId: string) => Promise<void>;
}

/**
 * Circuit breaker configuration for detecting rapid empty responses
 */
interface CircuitBreakerState {
  consecutiveEmptyResponses: number;
  lastResponseTimestamp: number;
  isTripped: boolean;
}

const CIRCUIT_BREAKER_CONFIG = {
  maxConsecutiveEmpty: 3,          // Trip after 3 consecutive empty responses
  minTimeBetweenResponses: 1000,   // Minimum expected time between responses (1s)
  resetTimeoutMs: 30000,           // Reset circuit after 30s
  cooldownMs: 5000                 // Wait 5s before allowing retry after trip
};

export class InstanceCommunicationManager extends EventEmitter {
  private settings = getSettingsManager();
  private outputStorage = getOutputStorageManager();
  private hookManager = getHookManager();
  private deps: CommunicationDependencies;
  private interruptedInstances = new Set<string>();

  // Circuit breaker state per instance
  private circuitBreakers = new Map<string, CircuitBreakerState>();

  // Context overflow failsafe tracking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private lastSentMessages = new Map<string, { message: string; attachments?: any[]; contextBlock?: string | null }>();
  private contextWarningIssued = new Set<string>();
  private contextOverflowRetried = new Set<string>();

  constructor(deps: CommunicationDependencies) {
    super();
    this.deps = deps;
  }

  /**
   * Get or create circuit breaker state for an instance
   */
  private getCircuitBreaker(instanceId: string): CircuitBreakerState {
    let state = this.circuitBreakers.get(instanceId);
    if (!state) {
      state = {
        consecutiveEmptyResponses: 0,
        lastResponseTimestamp: 0,
        isTripped: false
      };
      this.circuitBreakers.set(instanceId, state);
    }
    return state;
  }

  /**
   * Record a response and check circuit breaker state
   * @returns true if circuit is OK, false if tripped
   */
  private recordResponse(instanceId: string, hasContent: boolean): boolean {
    const state = this.getCircuitBreaker(instanceId);
    const now = Date.now();

    // Check if we should reset after timeout
    if (state.isTripped && (now - state.lastResponseTimestamp) > CIRCUIT_BREAKER_CONFIG.resetTimeoutMs) {
      console.log(`[CircuitBreaker] Resetting tripped circuit for ${instanceId} after timeout`);
      state.isTripped = false;
      state.consecutiveEmptyResponses = 0;
    }

    // If circuit is tripped, check cooldown
    if (state.isTripped) {
      if ((now - state.lastResponseTimestamp) < CIRCUIT_BREAKER_CONFIG.cooldownMs) {
        console.log(`[CircuitBreaker] Circuit tripped for ${instanceId}, in cooldown period`);
        return false;
      }
      // Cooldown expired, allow one retry
      state.isTripped = false;
      state.consecutiveEmptyResponses = 0;
      console.log(`[CircuitBreaker] Cooldown expired for ${instanceId}, allowing retry`);
    }

    state.lastResponseTimestamp = now;

    if (hasContent) {
      // Good response, reset counter
      state.consecutiveEmptyResponses = 0;
      return true;
    }

    // Empty response
    state.consecutiveEmptyResponses++;
    console.log(`[CircuitBreaker] Empty response #${state.consecutiveEmptyResponses} for ${instanceId}`);

    if (state.consecutiveEmptyResponses >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveEmpty) {
      console.warn(`[CircuitBreaker] TRIPPED for ${instanceId} after ${state.consecutiveEmptyResponses} consecutive empty responses`);
      state.isTripped = true;
      return false;
    }

    return true;
  }

  /**
   * Check if circuit is currently tripped for an instance
   */
  isCircuitTripped(instanceId: string): boolean {
    const state = this.circuitBreakers.get(instanceId);
    return state?.isTripped ?? false;
  }

  /**
   * Manually reset circuit breaker for an instance
   */
  resetCircuitBreaker(instanceId: string): void {
    const state = this.circuitBreakers.get(instanceId);
    if (state) {
      state.isTripped = false;
      state.consecutiveEmptyResponses = 0;
      console.log(`[CircuitBreaker] Manually reset for ${instanceId}`);
    }
  }

  /**
   * Clean up circuit breaker state for an instance
   */
  cleanupCircuitBreaker(instanceId: string): void {
    this.circuitBreakers.delete(instanceId);
    this.lastSentMessages.delete(instanceId);
    this.contextWarningIssued.delete(instanceId);
    this.contextOverflowRetried.delete(instanceId);
  }

  // ============================================
  // Message Sending
  // ============================================

  /**
   * Send input to an instance
   */
  async sendInput(
    instanceId: string,
    message: string,
    attachments?: any[],
    contextBlock?: string | null
  ): Promise<void> {
    console.log(`[InstanceCommunicationManager] sendInput called for ${instanceId}`);
    const instance = this.deps.getInstance(instanceId);
    const adapter = this.deps.getAdapter(instanceId);

    console.log(`[InstanceCommunicationManager] Instance exists: ${!!instance}, Adapter exists: ${!!adapter}, Status: ${instance?.status}`);

    // Check instance exists first
    if (!instance) {
      console.error(`[InstanceCommunicationManager] Instance ${instanceId} not found in state`);
      throw new Error(`Instance ${instanceId} not found`);
    }

    // Check instance status for better error messages
    if (instance.status === 'error') {
      throw new Error(`Instance ${instanceId} is in error state and cannot accept input`);
    }

    if (instance.status === 'terminated') {
      throw new Error(`Instance ${instanceId} has been terminated`);
    }

    if (instance.status === 'respawning') {
      throw new Error(`Instance ${instanceId} is respawning after interrupt. Please wait for it to be ready.`);
    }

    // Now check adapter
    if (!adapter) {
      console.error(`[InstanceCommunicationManager] No adapter found for ${instanceId} (status: ${instance.status})`);
      // Instance exists but adapter is missing - this is a bug state
      // Mark instance as error to prevent further confusion
      instance.status = 'error';
      this.deps.queueUpdate(instanceId, 'error');
      throw new Error(`Instance ${instanceId} is in an inconsistent state (no adapter). Please restart the instance.`);
    }

    // Track last sent message for retry-after-compaction
    this.lastSentMessages.set(instanceId, { message, attachments, contextBlock });

    const finalMessage = contextBlock ? `${contextBlock}\n\n${message}` : message;

    console.log('InstanceCommunicationManager: Sending message to adapter...');
    await adapter.sendInput(finalMessage, attachments);
    console.log('InstanceCommunicationManager: Message sent to adapter');
  }

  /**
   * Send a raw input response (for permission prompts, etc.)
   */
  async sendInputResponse(
    instanceId: string,
    response: string,
    permissionKey?: string
  ): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    const adapter = this.deps.getAdapter(instanceId);

    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!adapter) {
      // Instance exists but adapter is missing
      if (instance.status === 'respawning') {
        throw new Error(`Instance ${instanceId} is respawning. Please wait for it to be ready.`);
      }
      throw new Error(`Instance ${instanceId} is in an inconsistent state. Please restart the instance.`);
    }

    instance.lastActivity = Date.now();

    console.log(`InstanceCommunicationManager: Sending input response to ${instanceId}: ${response}`);
    if (permissionKey) {
      console.log(`InstanceCommunicationManager: Permission key: ${permissionKey}`);
    }

    if ('sendRaw' in adapter && typeof (adapter as any).sendRaw === 'function') {
      await (adapter as any).sendRaw(response, permissionKey);
    } else {
      await adapter.sendInput(response);
    }
  }

  // ============================================
  // Adapter Event Setup
  // ============================================

  /**
   * Set up event handlers for a CLI adapter.
   * Cleans up listeners on any previously-attached adapter to prevent leaks.
   */
  setupAdapterEvents(instanceId: string, adapter: CliAdapter): void {
    // Clean up listeners on the old adapter to prevent memory leaks
    // when adapters are replaced (e.g., toggleYoloMode, changeModel, changeAgentMode)
    const oldAdapter = this.deps.getAdapter(instanceId);
    if (oldAdapter && oldAdapter !== adapter) {
      oldAdapter.removeAllListeners();
    }

    adapter.on('output', async (message: OutputMessage) => {
      // Guard: ignore output events from a replaced adapter
      const currentAdapter = this.deps.getAdapter(instanceId);
      if (currentAdapter !== adapter) {
        return;
      }

      const instance = this.deps.getInstance(instanceId);
      if (instance) {
        // Sync CLI-assigned session ID back to instance for accurate history archiving.
        // The adapter receives the real CLI session ID via system messages (session_id field),
        // which may differ from the orchestrator-generated UUID after forks/interrupts.
        const cliSessionId = adapter.getSessionId();
        if (cliSessionId && cliSessionId !== instance.sessionId) {
          instance.sessionId = cliSessionId;
        }

        // Reset circuit breaker counter on tool activity — tool-use sequences
        // naturally produce empty assistant text between calls and shouldn't trip it
        if (message.type === 'tool_use' || message.type === 'tool_result') {
          const state = this.getCircuitBreaker(instanceId);
          if (state.consecutiveEmptyResponses > 0) {
            state.consecutiveEmptyResponses = 0;
          }
        }

        // Check circuit breaker for assistant messages
        if (message.type === 'assistant') {
          const hasContent = !!(
            (message.content && message.content.trim()) ||
            (message.thinking && message.thinking.length > 0)
          );
          // Successful response means overflow retry worked — allow future retries
          if (hasContent) {
            this.contextOverflowRetried.delete(instanceId);
          }
          const circuitOk = this.recordResponse(instanceId, hasContent);

          if (!circuitOk) {
            // Circuit tripped - attempt context compaction
            console.warn(`[InstanceCommunicationManager] Circuit breaker tripped for ${instanceId}, attempting context compaction`);

            // Add warning message
            const warningMessage: OutputMessage = {
              id: generateId(),
              timestamp: Date.now(),
              type: 'system',
              content: 'Detected multiple empty responses. Attempting to recover by compacting context...',
              metadata: { circuitBreakerTripped: true }
            };
            this.addToOutputBuffer(instance, warningMessage);
            this.emit('output', { instanceId, message: warningMessage });

            // Attempt compaction if available
            if (this.deps.compactContext) {
              try {
                await this.deps.compactContext(instanceId);
                this.resetCircuitBreaker(instanceId);

                const recoveryMessage: OutputMessage = {
                  id: generateId(),
                  timestamp: Date.now(),
                  type: 'system',
                  content: 'Context compacted. You can continue the conversation.',
                  metadata: { circuitBreakerRecovered: true }
                };
                this.addToOutputBuffer(instance, recoveryMessage);
                this.emit('output', { instanceId, message: recoveryMessage });
              } catch (compactErr) {
                console.error(`[InstanceCommunicationManager] Compaction failed during circuit breaker recovery:`, compactErr);
              }
            }

            // Don't add empty messages to buffer when circuit is tripped
            if (!hasContent) {
              return;
            }
          }
        }

        // Trigger hooks for tool_use events (PreToolUse)
        if (message.type === 'tool_use' && message.metadata) {
          const metadata = message.metadata as Record<string, unknown>;
          const toolName = (metadata['name'] as string) || 'unknown';

          try {
            await this.hookManager.triggerHooks('PreToolUse', {
              instanceId,
              toolName,
              workingDirectory: instance.workingDirectory,
            });
          } catch (err) {
            console.error(`[InstanceCommunicationManager] PreToolUse hook error:`, err);
          }
        }

        // Trigger hooks for tool_result events (PostToolUse)
        if (message.type === 'tool_result' && message.metadata) {
          const metadata = message.metadata as Record<string, unknown>;
          const isError = (metadata['is_error'] as boolean) || false;

          try {
            await this.hookManager.triggerHooks('PostToolUse', {
              instanceId,
              content: message.content,
              workingDirectory: instance.workingDirectory,
            });
            // Log warning if tool result was an error
            if (isError) {
              console.warn(`[InstanceCommunicationManager] Tool execution reported an error for ${instanceId}`);
            }
          } catch (err) {
            console.error(`[InstanceCommunicationManager] PostToolUse hook error:`, err);
          }
        }

        this.addToOutputBuffer(instance, message);
        this.emit('output', { instanceId, message });

        // Check for orchestration commands in assistant output
        if (message.type === 'assistant' && message.content) {
          this.deps.processOrchestrationOutput(instanceId, message.content);
        }
      }
    });

    adapter.on('status', (status: InstanceStatus) => {
      // Guard: ignore status events from a replaced adapter (e.g., dying
      // process after interrupt while a new adapter is already set up)
      const currentAdapter = this.deps.getAdapter(instanceId);
      if (currentAdapter !== adapter) {
        return;
      }

      const instance = this.deps.getInstance(instanceId);
      if (instance && instance.status !== status) {
        instance.status = status;
        instance.lastActivity = Date.now();
        this.deps.queueUpdate(instanceId, status, instance.contextUsage);
      }
    });

    adapter.on('context', (usage: ContextUsage) => {
      // Guard: ignore context events from a replaced adapter
      const currentAdapter = this.deps.getAdapter(instanceId);
      if (currentAdapter !== adapter) {
        return;
      }

      const instance = this.deps.getInstance(instanceId);
      if (instance) {
        instance.contextUsage = usage;
        instance.totalTokensUsed = usage.used;
        this.deps.queueUpdate(instanceId, instance.status, usage);
        this.checkContextWarningThreshold(instanceId, instance, usage, adapter);
      }
    });

    adapter.on('input_required', (payload: { id: string; prompt: string; timestamp: number; metadata?: Record<string, unknown> }) => {
      console.log('=== [InstanceCommunicationManager] INPUT_REQUIRED EVENT RECEIVED ===');
      console.log('[InstanceCommunicationManager] Instance ID:', instanceId);
      console.log('[InstanceCommunicationManager] Payload:', JSON.stringify(payload, null, 2));

      this.emit('input-required', {
        instanceId,
        requestId: payload.id,
        prompt: payload.prompt,
        timestamp: payload.timestamp,
        metadata: payload.metadata
      });

      console.log('[InstanceCommunicationManager] input-required event emitted');
    });

    adapter.on('error', async (error: Error) => {
      const instance = this.deps.getInstance(instanceId);
      console.error(`Instance ${instanceId} error (status: ${instance?.status}):`, error);

      if (instance) {
        // Check if this is a context overflow error
        const classified = getErrorRecoveryManager().classifyError(error);
        if (classified.category === ErrorCategory.RESOURCE && classified.technicalDetails?.includes('context')) {
          console.log(`[InstanceCommunicationManager] Context overflow detected for ${instanceId}, attempting compaction...`);

          // Add a system message to inform the user
          const compactingMessage: OutputMessage = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system',
            content: 'Context is too long. Compacting conversation history...',
            metadata: { contextOverflow: true }
          };
          this.addToOutputBuffer(instance, compactingMessage);
          this.emit('output', { instanceId, message: compactingMessage });

          // Attempt context compaction if handler is available
          if (this.deps.compactContext) {
            try {
              await this.deps.compactContext(instanceId);
              console.log(`[InstanceCommunicationManager] Context compaction completed for ${instanceId}`);

              // Reset warning so it can fire again after compaction
              this.contextWarningIssued.delete(instanceId);

              // Check if we already retried once — prevent infinite loop
              if (this.contextOverflowRetried.has(instanceId)) {
                console.warn(`[InstanceCommunicationManager] Already retried after overflow for ${instanceId}, skipping retry`);
                const idleMessage: OutputMessage = {
                  id: generateId(),
                  timestamp: Date.now(),
                  type: 'system',
                  content: 'Context compacted. Please delegate large file reads to child instances and try again.',
                  metadata: { contextCompacted: true }
                };
                this.addToOutputBuffer(instance, idleMessage);
                this.emit('output', { instanceId, message: idleMessage });
                instance.status = 'idle';
                this.deps.queueUpdate(instanceId, 'idle');
                return;
              }

              // Attempt retry with delegation guidance
              const lastMsg = this.lastSentMessages.get(instanceId);
              const retryAdapter = this.deps.getAdapter(instanceId);
              if (lastMsg && retryAdapter) {
                this.contextOverflowRetried.add(instanceId);

                const delegationGuidance = [
                  '[SYSTEM: Context Overflow Recovery]',
                  'Your context overflowed and has been compacted. To prevent this from happening again:',
                  '1. Do NOT read large files directly — spawn child instances for file reading.',
                  '2. Use get_child_summary instead of get_child_output for results.',
                  '3. Summarize rather than copying full file contents.',
                  'Your previous message is being retried. Follow the guidance above.',
                  '[END SYSTEM]'
                ].join('\n');

                const retryMessage = lastMsg.contextBlock
                  ? `${lastMsg.contextBlock}\n\n${delegationGuidance}\n\n${lastMsg.message}`
                  : `${delegationGuidance}\n\n${lastMsg.message}`;

                const successMessage: OutputMessage = {
                  id: generateId(),
                  timestamp: Date.now(),
                  type: 'system',
                  content: 'Context compacted and message retried with delegation guidance.',
                  metadata: { contextCompacted: true, retrying: true }
                };
                this.addToOutputBuffer(instance, successMessage);
                this.emit('output', { instanceId, message: successMessage });

                instance.status = 'busy';
                this.deps.queueUpdate(instanceId, 'busy');

                retryAdapter.sendInput(retryMessage, lastMsg.attachments).catch(retryErr => {
                  console.error(`[InstanceCommunicationManager] Retry after compaction failed for ${instanceId}:`, retryErr);
                  instance.status = 'idle';
                  this.deps.queueUpdate(instanceId, 'idle');
                });
                return;
              }

              // No stored message or adapter — fall back to idle
              const fallbackMessage: OutputMessage = {
                id: generateId(),
                timestamp: Date.now(),
                type: 'system',
                content: 'Context compacted. Please delegate large file reads to child instances and try again.',
                metadata: { contextCompacted: true }
              };
              this.addToOutputBuffer(instance, fallbackMessage);
              this.emit('output', { instanceId, message: fallbackMessage });
              instance.status = 'idle';
              this.deps.queueUpdate(instanceId, 'idle');
              return;
            } catch (compactErr) {
              console.error(`[InstanceCommunicationManager] Context compaction failed for ${instanceId}:`, compactErr);
              // Fall through to normal error handling
            }
          } else {
            console.warn(`[InstanceCommunicationManager] No compactContext handler available for ${instanceId}`);
          }
        }

        // Add error message to output buffer so user sees it in the UI
        const errorMessage: OutputMessage = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'error',
          content: error instanceof Error ? error.message : String(error)
        };
        this.addToOutputBuffer(instance, errorMessage);
        this.emit('output', { instanceId, message: errorMessage });

        instance.errorCount++;

        // Don't mark as error if we're in the middle of respawning - let respawnAfterInterrupt handle it
        if (instance.status !== 'respawning') {
          instance.status = 'error';
          this.deps.queueUpdate(instanceId, 'error');

          // Only force cleanup if not respawning - during respawn the lifecycle manager handles cleanup
          this.forceCleanupAdapter(instanceId).catch((cleanupErr) => {
            console.error(`Failed to cleanup adapter for ${instanceId} after error:`, cleanupErr);
          });
        } else {
          console.log(`Instance ${instanceId} error during respawning - skipping force cleanup, letting lifecycle handle it`);
        }
      }
    });

    adapter.on('exit', (code: number | null, signal: string | null) => {
      console.log(
        `Adapter exit event for instance ${instanceId}: code=${code}, signal=${signal}`
      );

      const instance = this.deps.getInstance(instanceId);
      if (!instance) {
        console.log(`Adapter exit event for ${instanceId} but instance not found - ignoring`);
        return;
      }

      // Check if this adapter is still the current adapter for this instance
      // If not, a new adapter has been set (e.g., during YOLO toggle) and we should
      // not delete it or modify instance state
      const currentAdapter = this.deps.getAdapter(instanceId);
      console.log(`Adapter exit check: currentAdapter=${currentAdapter ? 'exists' : 'undefined'}, adapter=${adapter ? 'exists' : 'undefined'}, same=${currentAdapter === adapter}`);
      if (currentAdapter !== adapter) {
        console.log(
          `Adapter exit event for ${instanceId} but adapter has been replaced - ignoring`
        );
        return;
      }

      // Check if this was an interrupted instance that needs respawning
      if (this.interruptedInstances.has(instanceId)) {
        console.log(
          `Instance ${instanceId} was interrupted, will respawn with --resume`
        );
        this.interruptedInstances.delete(instanceId);
        this.deps.onInterruptedExit(instanceId).catch((err) => {
          console.error(
            `Failed to respawn instance ${instanceId} after interrupt:`,
            err
          );
          instance.status = 'error';
          instance.processId = null;
          this.deps.queueUpdate(instanceId, 'error');
        });
        return;
      }

      if (instance.status !== 'terminated') {
        const newStatus = code === 0 ? 'terminated' : 'error';
        console.log(
          `Instance ${instanceId} exited unexpectedly, marking as ${newStatus}`
        );
        instance.status = newStatus;
        instance.processId = null;
        this.deps.queueUpdate(instanceId, instance.status);

        this.deps.deleteAdapter(instanceId);

        // Notify parent when a child instance exits
        if (instance.parentId && this.deps.onChildExit) {
          this.deps.onChildExit(instanceId, instance, code);
        }

        // NOTE: History archiving is handled exclusively by terminateInstance()
        // in instance-lifecycle.ts. Previously this exit handler also archived,
        // which caused a race condition: both paths would call archiveInstance()
        // concurrently, leading to duplicate entries and corrupted index saves
        // (the same index.json.tmp file was written by concurrent operations).
      }
    });
  }

  // ============================================
  // Interrupt Handling
  // ============================================

  /**
   * Mark an instance as interrupted
   */
  markInterrupted(instanceId: string): void {
    this.interruptedInstances.add(instanceId);
  }

  /**
   * Remove interrupt marking
   */
  clearInterrupted(instanceId: string): void {
    this.interruptedInstances.delete(instanceId);
  }

  /**
   * Check if an instance was interrupted
   */
  isInterrupted(instanceId: string): boolean {
    return this.interruptedInstances.has(instanceId);
  }

  // ============================================
  // Output Buffer Management
  // ============================================

  /**
   * Add message to instance output buffer
   */
  addToOutputBuffer(instance: Instance, message: OutputMessage): void {
    const isStreaming = message.metadata && 'streaming' in message.metadata && message.metadata['streaming'] === true;

    if (isStreaming) {
      const existingIndex = instance.outputBuffer.findIndex(m => m.id === message.id);
      if (existingIndex >= 0) {
        const accumulatedContent = message.metadata && 'accumulatedContent' in message.metadata
          ? String(message.metadata['accumulatedContent'])
          : message.content;
        instance.outputBuffer[existingIndex] = {
          ...instance.outputBuffer[existingIndex],
          content: accumulatedContent,
          metadata: message.metadata
        };
        this.emit('output', {
          instanceId: instance.id,
          message: instance.outputBuffer[existingIndex]
        });
        return;
      }
    }

    instance.outputBuffer.push(message);

    const settings = this.settings.getAll();
    const bufferSize = settings.outputBufferSize;

    if (instance.outputBuffer.length > bufferSize) {
      if (settings.enableDiskStorage) {
        const overflow = instance.outputBuffer.slice(
          0,
          instance.outputBuffer.length - bufferSize
        );
        this.outputStorage.storeMessages(instance.id, overflow).catch((err) => {
          console.error(
            `Failed to store output to disk for ${instance.id}:`,
            err
          );
        });
      }

      instance.outputBuffer = instance.outputBuffer.slice(-bufferSize);
    }

    // Ingest to context systems
    this.deps.ingestToRLM(instance.id, message);
    this.deps.ingestToUnifiedMemory(instance, message);
  }

  // ============================================
  // Context Overflow Failsafe
  // ============================================

  /**
   * Check if context usage has crossed the warning threshold and send delegation guidance
   */
  private checkContextWarningThreshold(
    instanceId: string,
    instance: Instance,
    usage: ContextUsage,
    adapter: CliAdapter
  ): void {
    // Skip if already warned
    if (this.contextWarningIssued.has(instanceId)) return;
    // Skip child instances — they don't spawn children
    if (instance.parentId !== null) return;
    // Skip if not busy
    if (instance.status !== 'busy') return;
    // Skip if under threshold
    if (usage.percentage < 80) return;

    this.contextWarningIssued.add(instanceId);

    const warningMessage: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: `Context usage at ${usage.percentage}% (${usage.used} / ${usage.total} tokens). Sending delegation guidance.`,
      metadata: { contextWarning: true }
    };
    this.addToOutputBuffer(instance, warningMessage);
    this.emit('output', { instanceId, message: warningMessage });

    const guidance = [
      '[SYSTEM: Context Usage Warning]',
      `Your context is at ${usage.percentage}% capacity (${usage.used} / ${usage.total} tokens).`,
      'To avoid hitting the limit:',
      '1. Do NOT read large files directly — spawn child instances for file reading.',
      '2. Use get_child_summary instead of get_child_output for results.',
      '3. Summarize rather than copying full file contents.',
      '[END SYSTEM WARNING]'
    ].join('\n');

    adapter.sendInput(guidance).catch(err => {
      console.error(`[InstanceCommunicationManager] Failed to send context warning to ${instanceId}:`, err);
    });
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Force cleanup an adapter when errors occur
   */
  async forceCleanupAdapter(instanceId: string): Promise<void> {
    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter) return;

    console.log(`Force cleaning up adapter for instance ${instanceId}`);

    try {
      await adapter.terminate(false);
    } catch (error) {
      console.error(`Error during force cleanup of ${instanceId}:`, error);
    } finally {
      this.deps.deleteAdapter(instanceId);
    }
  }
}
