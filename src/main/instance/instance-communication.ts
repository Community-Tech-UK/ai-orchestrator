/**
 * Instance Communication Manager - Handles adapter events and message passing
 */

import { EventEmitter } from 'events';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { BaseCliAdapter, type AdapterRuntimeCapabilities } from '../cli/adapters/base-cli-adapter';
// History archiving moved exclusively to instance-lifecycle.ts terminateInstance()
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import { getOutputStorageManager } from '../memory';
import { getHookManager } from '../hooks/hook-manager';
import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import type {
  FileAttachment,
  Instance,
  InstanceStatus,
  ContextUsage,
  OutputMessage,
  SessionDiffStats
} from '../../shared/types/instance.types';
import type { ErrorInfo } from '../../shared/types/ipc.types';
import type { SessionDiffTracker } from './session-diff-tracker';
import { ToolOutputParser } from './tool-output-parser';
import { generateId } from '../../shared/utils/id-generator';
import { isContextOverflowError, extractOverflowTokenCount } from '../context/ptl-retry';
import { TokenBudgetTracker, BudgetAction } from '../context/token-budget-tracker.js';
import { getTokenStatsService } from '../memory/token-stats';

/**
 * Dependencies required by the communication manager
 */
export interface CommunicationDependencies {
  getInstance: (id: string) => Instance | undefined;
  getAdapter: (id: string) => CliAdapter | undefined;
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => boolean;
  queueUpdate: (instanceId: string, status: InstanceStatus, contextUsage?: ContextUsage, diffStats?: SessionDiffStats, error?: ErrorInfo) => void;
  getDiffTracker?: (id: string) => SessionDiffTracker | undefined;
  processOrchestrationOutput: (instanceId: string, content: string) => void;
  onInterruptedExit: (instanceId: string) => Promise<void>;
  onUnexpectedExit?: (instanceId: string) => Promise<void>;
  onChildExit?: (childId: string, instance: Instance, exitCode: number | null) => void | Promise<void>;
  ingestToRLM: (instanceId: string, message: OutputMessage) => void;
  ingestToUnifiedMemory: (instance: Instance, message: OutputMessage) => void;
  compactContext?: (instanceId: string) => Promise<void>;
  onOutput?: (instanceId: string) => void;
  onToolStateChange?: (instanceId: string, state: 'generating' | 'tool_executing' | 'idle') => void;
  createSnapshot?: (instanceId: string, name: string, description: string | undefined, trigger: 'checkpoint' | 'auto') => void;
  getBudgetTracker?: (instanceId: string) => TokenBudgetTracker | undefined;
  getContextUsage?: (instanceId: string) => ContextUsage | undefined;
}

/**
 * Circuit breaker configuration for detecting rapid empty responses
 */
interface CircuitBreakerState {
  consecutiveEmptyResponses: number;
  lastResponseTimestamp: number;
  isTripped: boolean;
}

const logger = getLogger('InstanceCommunication');
const RESPONSE_PREVIEW_LENGTH = 120;

const CIRCUIT_BREAKER_CONFIG = {
  maxConsecutiveEmpty: 3,          // Trip after 3 consecutive empty responses
  minTimeBetweenResponses: 1000,   // Minimum expected time between responses (1s)
  resetTimeoutMs: 30000,           // Reset circuit after 30s
  cooldownMs: 5000                 // Wait 5s before allowing retry after trip
};

function summarizeLogText(value: string, maxLength = RESPONSE_PREVIEW_LENGTH): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
}

function summarizeInputResponse(response: string, permissionKey?: string): Record<string, unknown> {
  const normalized = response.trim().toLowerCase();
  return {
    responseLength: response.length,
    responsePreview: summarizeLogText(response),
    isPermissionApproval: normalized.includes('permission granted')
      || normalized.includes('allow')
      || normalized.startsWith('y'),
    isPermissionDenial: normalized.includes('permission denied')
      || normalized.includes('do not perform')
      || normalized.startsWith('n'),
    permissionKey: permissionKey ?? null,
  };
}

export class InstanceCommunicationManager extends EventEmitter {
  private settings = getSettingsManager();
  private outputStorage = getOutputStorageManager();
  private hookManager = getHookManager();
  private deps: CommunicationDependencies;
  private toolOutputParser = new ToolOutputParser();
  private interruptedInstances = new Set<string>();

  // Circuit breaker state per instance
  private circuitBreakers = new Map<string, CircuitBreakerState>();

  // Context overflow failsafe tracking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private lastSentMessages = new Map<string, { message: string; attachments?: any[]; contextBlock?: string | null }>();
  private contextWarningIssued = new Set<string>();
  private contextOverflowRetried = new Set<string>();
  private contextOverflowSeen = new Set<string>(); // Tracks instances that hit context overflow via output path
  private pendingContinuityPreambles = new Map<string, string>(); // Continuity queued for next input
  private pendingContextWarnings = new Map<string, string>(); // Warnings queued for next input

  // Tool result deduplication — tracks seen tool_use_ids per instance
  private seenToolResultIds = new Map<string, Set<string>>();

  // Rewind point tracking — counts autonomous tool completions between user inputs
  private autonomousToolCounts = new Map<string, number>();
  private softCheckpointCounts = new Map<string, number>();

  // Repeated error suppression
  private lastErrorContent = new Map<string, { content: string; count: number }>();

  constructor(deps: CommunicationDependencies) {
    super();
    this.deps = deps;
  }

  private getAdapterRuntimeCapabilities(adapter: CliAdapter): AdapterRuntimeCapabilities {
    if (adapter instanceof BaseCliAdapter) {
      return adapter.getRuntimeCapabilities();
    }
    return {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
    };
  }

  /**
   * Codex/Gemini adapters run in exec-per-message mode (stateless sessions).
   * Context threshold warnings are not meaningful for these providers.
   */
  private isStatelessExecAdapter(adapter: CliAdapter): boolean {
    const adapterName = adapter.getName().toLowerCase();
    return adapterName.includes('codex') || adapterName.includes('gemini');
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
      logger.info('Resetting tripped circuit after timeout', { instanceId });
      state.isTripped = false;
      state.consecutiveEmptyResponses = 0;
    }

    // If circuit is tripped, check cooldown
    if (state.isTripped) {
      if ((now - state.lastResponseTimestamp) < CIRCUIT_BREAKER_CONFIG.cooldownMs) {
        logger.info('Circuit tripped, in cooldown period', { instanceId });
        return false;
      }
      // Cooldown expired, allow one retry
      state.isTripped = false;
      state.consecutiveEmptyResponses = 0;
      logger.info('Cooldown expired, allowing retry', { instanceId });
    }

    state.lastResponseTimestamp = now;

    if (hasContent) {
      // Good response, reset counter
      state.consecutiveEmptyResponses = 0;
      return true;
    }

    // Empty response
    state.consecutiveEmptyResponses++;
    logger.info('Empty response recorded', { instanceId, count: state.consecutiveEmptyResponses });

    if (state.consecutiveEmptyResponses >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveEmpty) {
      logger.warn('Circuit breaker tripped after consecutive empty responses', { instanceId, consecutiveEmptyResponses: state.consecutiveEmptyResponses });
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
      logger.info('Circuit breaker manually reset', { instanceId });
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
    this.contextOverflowSeen.delete(instanceId);
    this.pendingContinuityPreambles.delete(instanceId);
    this.pendingContextWarnings.delete(instanceId);
    this.lastErrorContent.delete(instanceId);
    this.seenToolResultIds.delete(instanceId);
    this.autonomousToolCounts.delete(instanceId);
    this.softCheckpointCounts.delete(instanceId);
  }

  cleanupToolResultDedup(instanceId: string): void {
    this.seenToolResultIds.delete(instanceId);
  }

  queueContinuityPreamble(instanceId: string, preamble: string): void {
    if (!preamble.trim()) {
      return;
    }

    this.pendingContinuityPreambles.set(instanceId, preamble);
    logger.info('Queued continuity preamble for next user input', { instanceId });
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
    attachments?: FileAttachment[],
    contextBlock?: string | null
  ): Promise<void> {
    logger.info('sendInput called', { instanceId });
    const instance = this.deps.getInstance(instanceId);
    const adapter = this.deps.getAdapter(instanceId);

    logger.info('sendInput state check', { instanceId, instanceExists: !!instance, adapterExists: !!adapter, status: instance?.status });

    // Check instance exists first
    if (!instance) {
      logger.error('Instance not found in state', undefined, { instanceId });
      throw new Error(`Instance ${instanceId} not found`);
    }

    // Check instance status for better error messages
    if (instance.status === 'error') {
      throw new Error(`Instance ${instanceId} is in error state and cannot accept input`);
    }

    if (instance.status === 'terminated') {
      throw new Error(`Instance ${instanceId} has been terminated`);
    }

    // If the instance is respawning after interrupt, wait for it to finish
    // rather than rejecting. The renderer has queued the message and we should
    // deliver it once the new adapter is ready (inspired by t3code's pattern
    // of only accepting input when session status === "ready").
    if (instance.status === 'respawning' && instance.respawnPromise) {
      logger.info('sendInput: instance is respawning, waiting for respawn to complete', { instanceId });
      const respawnTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Instance respawn timed out after 30s')), 30_000)
      );
      await Promise.race([instance.respawnPromise, respawnTimeout]);
      // After respawn, re-check status — it may have gone to 'error'.
      // Cast via string to bypass TS narrowing (status was mutated during await).
      const postRespawnStatus = instance.status as string;
      if (postRespawnStatus === 'error' || postRespawnStatus === 'failed') {
        throw new Error(`Instance ${instanceId} failed to respawn after interrupt`);
      }
      if (postRespawnStatus === 'terminated') {
        throw new Error(`Instance ${instanceId} was terminated during respawn`);
      }
      logger.info('sendInput: respawn complete, proceeding with send', { instanceId, status: postRespawnStatus });
    } else if (instance.status === 'respawning') {
      throw new Error(`Instance ${instanceId} is respawning after interrupt. Please wait for it to be ready.`);
    }

    // Now check adapter
    if (!adapter) {
      logger.error('No adapter found for instance', undefined, { instanceId, status: instance.status });
      // Instance exists but adapter is missing - this is a bug state
      // Mark instance as error to prevent further confusion
      instance.status = 'error';
      this.deps.queueUpdate(instanceId, 'error');
      throw new Error(`Instance ${instanceId} is in an inconsistent state (no adapter). Please restart the instance.`);
    }

    // Validate that the final message will be non-empty.
    // Empty user messages get stored in CLI session history and cause
    // API 400 "user messages must have non-empty content" on --resume.
    const hasAttachments = attachments && attachments.length > 0;
    if (!message.trim() && !contextBlock?.trim() && !hasAttachments) {
      throw new Error('Cannot send empty message: no text content and no attachments');
    }

    // Track last sent message for retry-after-compaction
    this.lastSentMessages.set(instanceId, { message, attachments, contextBlock });

    const pendingPreambles: string[] = [];
    const pendingContinuity = this.pendingContinuityPreambles.get(instanceId);
    if (pendingContinuity) {
      pendingPreambles.push(pendingContinuity);
      this.pendingContinuityPreambles.delete(instanceId);
      logger.info('Prepended pending continuity preamble to user input', { instanceId });
    }

    let finalContextBlock = contextBlock;
    const pendingWarning = this.pendingContextWarnings.get(instanceId);
    if (pendingWarning) {
      pendingPreambles.push(pendingWarning);
      this.pendingContextWarnings.delete(instanceId);
      logger.info('Prepended pending context warning to user input', { instanceId });
    }

    if (pendingPreambles.length > 0) {
      finalContextBlock = finalContextBlock
        ? `${pendingPreambles.join('\n\n')}\n\n${finalContextBlock}`
        : pendingPreambles.join('\n\n');
    }

    const finalMessage = finalContextBlock ? `${finalContextBlock}\n\n${message}` : message;

    // Hard checkpoint: snapshot before user message
    if (this.deps.createSnapshot) {
      const name = `Before: ${message.slice(0, 50)}`;
      try {
        this.deps.createSnapshot(instanceId, name, undefined, 'checkpoint');
      } catch (err) {
        logger.debug('Failed to create checkpoint snapshot', { instanceId, error: String(err) });
      }
    }
    // Reset autonomous tool counter on user input
    this.autonomousToolCounts.set(instanceId, 0);

    // Budget enforcement: check before API call
    const budgetTracker = this.deps.getBudgetTracker?.(instanceId);
    if (budgetTracker) {
      const contextUsage = this.deps.getContextUsage?.(instanceId);
      const turnTokens = contextUsage?.used ?? 0;
      const budgetCheck = budgetTracker.checkBudget({ turnTokens });

      if (budgetCheck.action === BudgetAction.STOP) {
        logger.warn('Token budget exceeded, halting before API call', {
          instanceId,
          reason: budgetCheck.reason,
          turnTokens,
        });

        // Push a system message so user sees why execution stopped
        const budgetNotification: OutputMessage = {
          id: generateId(),
          type: 'system',
          content: `Token budget limit reached: ${budgetCheck.reason}. ${budgetCheck.nudgeMessage ?? 'Consider starting a new conversation.'}`,
          timestamp: Date.now(),
        };
        instance.outputBuffer.push(budgetNotification);
        this.emit('output', { instanceId, message: budgetNotification });

        return; // Do NOT call adapter.sendInput
      }
    }

    // Pre-validate attachments against adapter capabilities
    if (attachments && attachments.length > 0 && adapter instanceof BaseCliAdapter) {
      const caps = adapter.getCapabilities();
      const imageAttachments = attachments.filter(a => a.type.startsWith('image/'));
      const fileAttachments = attachments.filter(a => !a.type.startsWith('image/'));

      if (imageAttachments.length > 0 && !caps.vision) {
        const adapterName = adapter.getName();
        const warning: OutputMessage = {
          id: generateId(),
          type: 'system',
          content: `${adapterName} does not support image attachments. ${imageAttachments.length} image(s) will be dropped.`,
          timestamp: Date.now(),
        };
        instance.outputBuffer.push(warning);
        this.emit('output', { instanceId, message: warning });
        // Filter out images, keep file attachments
        attachments = fileAttachments.length > 0 ? fileAttachments : undefined;
      }

      if (fileAttachments.length > 0 && !caps.fileAccess) {
        const adapterName = adapter.getName();
        const warning: OutputMessage = {
          id: generateId(),
          type: 'system',
          content: `${adapterName} does not support file attachments. ${fileAttachments.length} file(s) will be dropped.`,
          timestamp: Date.now(),
        };
        instance.outputBuffer.push(warning);
        this.emit('output', { instanceId, message: warning });
        attachments = imageAttachments.length > 0 && caps.vision ? imageAttachments : undefined;
      }
    }

    logger.info('Sending message to adapter');
    await adapter.sendInput(finalMessage, attachments);
    logger.info('Message sent to adapter');
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

    logger.info('Sending input response', {
      instanceId,
      ...summarizeInputResponse(response, permissionKey),
    });

    const capabilities = this.getAdapterRuntimeCapabilities(adapter);
    if (!capabilities.supportsPermissionPrompts) {
      throw new Error('This provider does not support interactive permission prompts.');
    }

    if ('sendRaw' in adapter && typeof (adapter as { sendRaw?: (...args: unknown[]) => Promise<void> }).sendRaw === 'function') {
      await (adapter as { sendRaw: (response: string, permissionKey?: string) => Promise<void> }).sendRaw(response, permissionKey);
    } else {
      throw new Error('Permission prompt response is not supported by this adapter.');
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

      // Skip user messages echoed back by the CLI — we add them explicitly
      // in InstanceManager.sendInput() and InstanceLifecycle.createInstance().
      // Without this filter, every user message appears twice (our emit + CLI echo),
      // and during --resume replays, historical user messages are re-added.
      if (message.type === 'user') {
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
          if (message.type === 'tool_use') {
            this.deps.onToolStateChange?.(instanceId, 'tool_executing');
          } else if (message.type === 'tool_result') {
            this.deps.onToolStateChange?.(instanceId, 'generating');
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
            logger.warn('Circuit breaker tripped, attempting context compaction', { instanceId });

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
                logger.error('Compaction failed during circuit breaker recovery', compactErr instanceof Error ? compactErr : undefined, { instanceId });
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
            logger.error('PreToolUse hook error', err instanceof Error ? err : undefined, { instanceId });
          }
        }

        // Capture file baselines for diff tracking on file-modifying tool events
        if (
          (message.type === 'tool_use' || message.type === 'tool_result') &&
          this.deps.getDiffTracker
        ) {
          const tracker = this.deps.getDiffTracker(instanceId);
          if (tracker) {
            const filePaths = this.toolOutputParser.extractFilePaths(message, instance.workingDirectory, instance.provider);
            for (const fp of filePaths) {
              try {
                tracker.captureBaseline(fp);
              } catch (err) {
                logger.debug('Baseline capture failed', { instanceId, filePath: fp, error: String(err) });
              }
            }
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
              logger.warn('Tool execution reported an error', { instanceId });
            }
          } catch (err) {
            logger.error('PostToolUse hook error', err instanceof Error ? err : undefined, { instanceId });
          }
        }

        // Detect corrupted session errors (empty user messages stored in CLI history).
        // These surface as API 400 "user messages must have non-empty content" on --resume.
        // Show a clear recovery message instead of a cryptic API error.
        if (message.type === 'error' && this.isCorruptedSessionMessage(message.content)) {
          logger.warn('Corrupted session detected via output path', { instanceId, content: message.content });

          const recoveryMessage: OutputMessage = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system',
            content: 'Session history contains invalid messages and cannot be resumed. Please restart this instance to start a fresh session.',
            metadata: { corruptedSession: true, fatal: true }
          };
          this.addToOutputBuffer(instance, message, { countAsProcessOutput: true });
          this.addToOutputBuffer(instance, recoveryMessage);
          this.emit('output', { instanceId, message });
          this.emit('output', { instanceId, message: recoveryMessage });

          if (instance.status !== 'error' && instance.status !== 'terminated') {
            instance.status = 'error';
            this.deps.queueUpdate(instanceId, 'error');
            this.forceCleanupAdapter(instanceId).catch((err) => {
              logger.error('Failed to cleanup adapter after corrupted session', err instanceof Error ? err : undefined, { instanceId });
            });
          }
          return;
        }

        // Detect context-overflow errors arriving via NDJSON stdout path
        // (these bypass the adapter 'error' event and need explicit handling)
        if (message.type === 'error' && this.isContextOverflowMessage(message.content)) {
          const tokenInfo = extractOverflowTokenCount(message.content);
          logger.warn('Context overflow detected via output path', {
            instanceId,
            content: message.content,
            observedTokens: tokenInfo.observed,
            maximumTokens: tokenInfo.maximum,
          });

          // Only show the first occurrence; suppress duplicates
          if (!this.contextOverflowSeen.has(instanceId)) {
            this.contextOverflowSeen.add(instanceId);
            this.addToOutputBuffer(instance, message, { countAsProcessOutput: true });
            this.emit('output', { instanceId, message });

            // Add guidance message
            const guidanceMessage: OutputMessage = {
              id: generateId(),
              timestamp: Date.now(),
              type: 'system',
              content: 'Context window limit reached. The instance has been stopped. Please start a new conversation or delegate large tasks to child instances.',
              metadata: { contextOverflow: true, fatal: true }
            };
            this.addToOutputBuffer(instance, guidanceMessage);
            this.emit('output', { instanceId, message: guidanceMessage });
          }

          // Force the instance to stop — don't let the CLI keep retrying
          if (instance.status !== 'error' && instance.status !== 'terminated') {
            instance.status = 'error';
            this.deps.queueUpdate(instanceId, 'error');
            this.forceCleanupAdapter(instanceId).catch((err) => {
              logger.error('Failed to cleanup adapter after context overflow', err instanceof Error ? err : undefined, { instanceId });
            });
          }
          return; // Don't add duplicate errors to buffer
        }

        this.addToOutputBuffer(instance, message, { countAsProcessOutput: true });
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
        const previousStatus = instance.status;
        instance.status = status;
        instance.lastActivity = Date.now();

        if (status === 'idle' || status === 'ready' || status === 'waiting_for_input') {
          this.deps.onToolStateChange?.(instanceId, 'idle');
        }

        // On busy→idle/ready transition, compute diff stats and include them in the update
        if (
          previousStatus === 'busy' &&
          (status === 'idle' || status === 'ready') &&
          this.deps.getDiffTracker
        ) {
          const tracker = this.deps.getDiffTracker(instanceId);
          if (tracker) {
            try {
              const diffStats = tracker.computeDiff();
              instance.diffStats = diffStats;
              this.deps.queueUpdate(instanceId, status, instance.contextUsage, diffStats);
            } catch (err) {
              logger.debug('computeDiff failed', { instanceId, error: String(err) });
              this.deps.queueUpdate(instanceId, status, instance.contextUsage);
            }
            return;
          }
        }

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
        // Prefer the lifetime spend counter; fall back to occupancy for
        // adapters that don't emit cumulativeTokens (e.g. Claude).
        instance.totalTokensUsed = usage.cumulativeTokens ?? usage.used;
        this.deps.queueUpdate(instanceId, instance.status, usage);
        if (!this.isStatelessExecAdapter(adapter)) {
          this.checkContextWarningThreshold(instanceId, instance, usage);
        }
      }
    });

    adapter.on('cost', (cost: { costEstimate: number }) => {
      const instance = this.deps.getInstance(instanceId);
      if (instance) {
        instance.contextUsage = { ...instance.contextUsage, costEstimate: cost.costEstimate };
        this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      }
    });

    adapter.on('input_required', (payload: { id: string; prompt: string; timestamp: number; metadata?: Record<string, unknown> }) => {
      const payloadMetadata = payload.metadata || {};
      const approvalTraceId = typeof payloadMetadata['approvalTraceId'] === 'string'
        ? String(payloadMetadata['approvalTraceId'])
        : `approval-forward-${payload.id}`;

      const capabilities = this.getAdapterRuntimeCapabilities(adapter);
      if (!capabilities.supportsPermissionPrompts) {
        logger.info('[APPROVAL_TRACE] communication_drop_input_required', {
          approvalTraceId,
          instanceId,
          requestId: payload.id,
          reason: 'provider_does_not_support_permission_prompts'
        });
        const instance = this.deps.getInstance(instanceId);
        if (instance) {
          const message: OutputMessage = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system',
            content: 'Provider does not support interactive permission prompts. Adjust permissions or switch provider.',
            metadata: { inputRequiredIgnored: true },
          };
          this.addToOutputBuffer(instance, message);
          this.emit('output', { instanceId, message });
        }
        return;
      }

      const metadata: Record<string, unknown> = {
        ...payloadMetadata,
        approvalTraceId,
        traceStage: 'main:instance-communication:forwarded'
      };
      logger.info('[APPROVAL_TRACE] communication_receive_input_required', {
        approvalTraceId,
        instanceId,
        requestId: payload.id,
        metadataType: metadata['type']
      });

      this.emit('input-required', {
        instanceId,
        requestId: payload.id,
        prompt: payload.prompt,
        timestamp: payload.timestamp,
        metadata
      });

      logger.info('[APPROVAL_TRACE] communication_emit_input_required', {
        approvalTraceId,
        instanceId,
        requestId: payload.id
      });
    });

    adapter.on('error', async (error: Error) => {
      const instance = this.deps.getInstance(instanceId);
      logger.error('Instance error', error instanceof Error ? error : undefined, { instanceId, status: instance?.status });

      if (!instance) return;

      // Guard: EPIPE errors are expected when a CLI process dies while we have
      // buffered writes. Swallow them — the exit handler will take care of
      // respawning. Emitting EPIPE as an instance error would race with the
      // exit handler and could mark the instance as 'error' before auto-respawn
      // gets a chance to run, which kills the session.
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        logger.debug('Ignoring EPIPE error from adapter — exit handler will manage recovery', { instanceId });
        return;
      }

      // Guard: ignore errors from a replaced adapter (e.g., late pipe errors from a
      // killed process after respawnAfterInterrupt already installed a new adapter).
      // Without this, the old adapter's error handler would force-cleanup the NEW adapter.
      const currentAdapter = this.deps.getAdapter(instanceId);
      if (currentAdapter !== adapter) {
        logger.info('Adapter error event but adapter has been replaced - ignoring', { instanceId });
        return;
      }

      // Check if this is a context overflow error
      const classified = getErrorRecoveryManager().classifyError(error);
      if (classified.category === ErrorCategory.RESOURCE && classified.technicalDetails?.includes('context')) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const tokenInfo = extractOverflowTokenCount(errorMsg);
        logger.info('Context overflow detected, attempting compaction', {
          instanceId,
          observedTokens: tokenInfo.observed,
          maximumTokens: tokenInfo.maximum,
        });

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
            logger.info('Context compaction completed', { instanceId });

            // Reset warning so it can fire again after compaction
            this.contextWarningIssued.delete(instanceId);

            // Check if we already retried once — prevent infinite loop
            if (this.contextOverflowRetried.has(instanceId)) {
              logger.warn('Already retried after overflow, skipping retry', { instanceId });
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
                logger.error('Retry after compaction failed', retryErr instanceof Error ? retryErr : undefined, { instanceId });
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
            logger.error('Context compaction failed', compactErr instanceof Error ? compactErr : undefined, { instanceId });
            // Fall through to normal error handling
          }
        } else {
          logger.warn('No compactContext handler available', { instanceId });
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
          logger.error('Failed to cleanup adapter after error', cleanupErr instanceof Error ? cleanupErr : undefined, { instanceId });
        });
      } else {
        logger.info('Instance error during respawning - skipping force cleanup, letting lifecycle handle it', { instanceId });
      }
    });

    adapter.on('exit', (code: number | null, signal: string | null) => {
      logger.info('Adapter exit event', { instanceId, code, signal });

      const instance = this.deps.getInstance(instanceId);
      if (!instance) {
        logger.info('Adapter exit event but instance not found - ignoring', { instanceId });
        return;
      }

      const buildCrashError = (reason: string): ErrorInfo => ({
        code: signal ? `SIGNAL_${signal}` : `EXIT_${code ?? 'unknown'}`,
        message: reason,
        timestamp: Date.now(),
      });

      // Check if this adapter is still the current adapter for this instance
      // If not, a new adapter has been set (e.g., during YOLO toggle) and we should
      // not delete it or modify instance state
      const currentAdapter = this.deps.getAdapter(instanceId);
      logger.info('Adapter exit check', { instanceId, currentAdapterExists: !!currentAdapter, adapterExists: !!adapter, isSameAdapter: currentAdapter === adapter });
      if (currentAdapter !== adapter) {
        logger.info('Adapter exit event but adapter has been replaced - ignoring', { instanceId });
        return;
      }

      if (this.isStatelessExecAdapter(adapter)) {
        logger.info('Ignoring per-turn process exit for stateless exec adapter', {
          instanceId,
          adapter: adapter.getName(),
          code,
          signal,
          status: instance.status,
        });
        this.interruptedInstances.delete(instanceId);
        return;
      }

      // Check if this exit is from a deferred tool use (defer-pause).
      // The CLI exits with code 0 after a hook returns `defer`. Don't trigger
      // respawn — the resume flow handles this when the user approves/denies.
      if (adapter.getName() === 'claude-cli') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const claudeAdapter = adapter as any;
        if (typeof claudeAdapter.getDeferredToolUse === 'function' && claudeAdapter.getDeferredToolUse()) {
          logger.info('Adapter exit with deferred tool use pending — skipping respawn', {
            instanceId,
            code,
            toolName: claudeAdapter.getDeferredToolUse().toolName,
          });
          return;
        }
      }

      // Check if this was an interrupted instance that needs respawning
      if (this.interruptedInstances.has(instanceId)) {
        logger.info('Instance was interrupted, will respawn with --resume', { instanceId });
        this.interruptedInstances.delete(instanceId);
        this.deps.onInterruptedExit(instanceId).catch((err) => {
          logger.error('Failed to respawn instance after interrupt', err instanceof Error ? err : undefined, { instanceId });
          instance.status = 'error';
          instance.processId = null;
          this.deps.queueUpdate(instanceId, 'error', undefined, undefined, buildCrashError(`Failed to respawn after interrupt: ${err instanceof Error ? err.message : String(err)}`));
        });
        return;
      }

      if (instance.status !== 'terminated') {
        // Auto-respawn root instances that exit unexpectedly while idle/ready.
        // This handles CLI processes dying from sleep/wake, pipe errors, or
        // idle timeouts — keeping sessions alive like standalone CLI tools do.
        const canAutoRespawn =
          this.deps.onUnexpectedExit &&
          !instance.parentId &&                        // Only root instances
          instance.restartCount < 5 &&                 // Don't loop forever
          (instance.status === 'idle' || instance.status === 'ready' || instance.status === 'busy') &&
          instance.outputBuffer.some(m => m.type === 'user'); // Has conversation worth preserving

        if (canAutoRespawn) {
          logger.info('Auto-respawning instance after unexpected exit', {
            instanceId,
            code,
            signal,
            restartCount: instance.restartCount,
            previousStatus: instance.status,
          });
          instance.status = 'respawning';
          instance.processId = null;
          instance.restartCount++;
          this.deps.queueUpdate(instanceId, 'respawning');
          // NOTE: deleteAdapter is called INSIDE respawnAfterUnexpectedExit
          // AFTER capabilities are read. Previously it was called here, which
          // meant the respawn method couldn't read adapter capabilities and
          // resume was never attempted.

          this.deps.onUnexpectedExit!(instanceId).catch((err) => {
            logger.error('Auto-respawn failed', err instanceof Error ? err : undefined, { instanceId });
            instance.status = 'error';
            instance.processId = null;
            this.deps.queueUpdate(instanceId, 'error', undefined, undefined, buildCrashError(`Auto-respawn failed: ${err instanceof Error ? err.message : String(err)}`));
          });
          return;
        }

        const newStatus = code === 0 ? 'terminated' : 'error';
        logger.info('Instance exited unexpectedly', { instanceId, newStatus, code, signal });
        instance.status = newStatus;
        instance.processId = null;
        this.deps.queueUpdate(
          instanceId,
          instance.status,
          undefined,
          undefined,
          newStatus === 'error' ? buildCrashError(`Process exited unexpectedly with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`) : undefined
        );

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
  addToOutputBuffer(
    instance: Instance,
    message: OutputMessage,
    options?: { countAsProcessOutput?: boolean }
  ): void {
    if (options?.countAsProcessOutput) {
      this.deps.onOutput?.(instance.id);
    }
    // Suppress repeated identical error messages (e.g., "Prompt is too long" spam)
    if (message.type === 'error') {
      const lastError = this.lastErrorContent.get(instance.id);
      if (lastError && lastError.content === message.content) {
        lastError.count++;
        if (lastError.count > 3) {
          // Silently suppress after 3 identical errors
          logger.info('Suppressing repeated error', { instanceId: instance.id, content: message.content, count: lastError.count });
          return;
        }
      } else {
        this.lastErrorContent.set(instance.id, { content: message.content, count: 1 });
      }
    } else {
      // Non-error message resets the repeated error tracker
      this.lastErrorContent.delete(instance.id);
    }

    // Tool result deduplication — skip duplicate tool_results by tool_use_id
    if (message.type === 'tool_result' && message.metadata) {
      const toolUseId = message.metadata['tool_use_id'] as string | undefined;
      if (toolUseId) {
        let seen = this.seenToolResultIds.get(instance.id);
        if (!seen) {
          seen = new Set();
          this.seenToolResultIds.set(instance.id, seen);
        }
        if (seen.has(toolUseId)) {
          logger.debug('Skipped duplicate tool_result', { instanceId: instance.id, toolUseId });
          return;
        }
        seen.add(toolUseId);
      }
    }

    // Soft checkpoint: track autonomous tool completions
    if (message.type === 'tool_result' && this.deps.createSnapshot) {
      const count = (this.autonomousToolCounts.get(instance.id) ?? 0) + 1;
      this.autonomousToolCounts.set(instance.id, count);

      if (count > 5) {
        const softCount = this.softCheckpointCounts.get(instance.id) ?? 0;
        if (softCount < 10) {
          const toolName = (message.metadata?.['name'] as string) || 'unknown';
          try {
            this.deps.createSnapshot(
              instance.id,
              `Auto: after ${toolName} (autonomous run, tool #${count})`,
              undefined,
              'auto'
            );
            this.softCheckpointCounts.set(instance.id, softCount + 1);
          } catch (err) {
            logger.debug('Failed to create soft checkpoint', { instanceId: instance.id, error: String(err) });
          }
          // Reset counter after creating checkpoint (per spec)
          this.autonomousToolCounts.set(instance.id, 0);
        }
      }
    }

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

    // Record token stats (best-effort)
    try {
      const statsService = getTokenStatsService();
      const charCount = typeof message.content === 'string'
        ? message.content.length
        : JSON.stringify(message.content).length;
      statsService.record({
        instanceId: instance.id,
        toolType: statsService.classifyToolType(message),
        tokenCount: Math.ceil(charCount / 4),
        charCount,
        truncated: !!(message.metadata?.['truncated']),
        metadata: message.metadata ? { toolName: message.metadata['toolName'] } : undefined
      });
    } catch { /* stats are best-effort */ }

    const settings = this.settings.getAll();
    const bufferSize = settings.outputBufferSize;

    if (instance.outputBuffer.length > bufferSize) {
      if (settings.enableDiskStorage) {
        const overflow = instance.outputBuffer.slice(
          0,
          instance.outputBuffer.length - bufferSize
        );
        this.outputStorage.storeMessages(instance.id, overflow).catch((err) => {
          logger.error('Failed to store output to disk', err instanceof Error ? err : undefined, { instanceId: instance.id });
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
   * Check if a message content indicates a context overflow / prompt-too-long error.
   * Delegates to the PTL retry module's pattern set for comprehensive detection.
   */
  private isContextOverflowMessage(content: string): boolean {
    if (!content) return false;
    return isContextOverflowError(content);
  }

  /**
   * Check if a message indicates a corrupted session (e.g., empty user messages
   * stored in CLI history that cause API 400 on --resume)
   */
  private isCorruptedSessionMessage(content: string): boolean {
    if (!content) return false;
    const lower = content.toLowerCase();
    return (
      lower.includes('user messages must have non-empty content') ||
      lower.includes('must have non-empty content') ||
      lower.includes('messages must have non-empty') ||
      lower.includes('invalid_request_error') && lower.includes('non-empty')
    );
  }

  /**
   * Check if context usage has crossed the warning threshold and send delegation guidance
   */
  private checkContextWarningThreshold(
    instanceId: string,
    instance: Instance,
    usage: ContextUsage,
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

    this.pendingContextWarnings.set(instanceId, guidance);
    logger.info('Queued context warning for next user input', { instanceId });
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

    logger.info('Force cleaning up adapter', { instanceId });

    try {
      await adapter.terminate(false);
    } catch (error) {
      logger.error('Error during force cleanup', error instanceof Error ? error : undefined, { instanceId });
    } finally {
      this.deps.deleteAdapter(instanceId);
    }
  }
}
