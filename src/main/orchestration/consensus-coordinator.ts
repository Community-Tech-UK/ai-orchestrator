/**
 * Consensus Coordinator - Multi-model consensus query system
 *
 * Enables orchestrator instances to query multiple AI providers in parallel
 * and synthesize consensus responses. This is the orchestrator equivalent of
 * Claude Code's MCP-based multi-model consultation (Gemini, Copilot, Codex).
 *
 * Architecture:
 * 1. Instance emits consensus_query command
 * 2. ConsensusCoordinator fans out the question to N ephemeral provider instances
 * 3. Collects responses (with timeout/error handling per provider)
 * 4. Synthesizes consensus and injects result back to requesting instance
 */

import { EventEmitter } from 'events';
import type { CliAdapter, UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import { CliDetectionService, type CliType } from '../cli/cli-detection';
import { isProviderNotice } from '../cli/provider-notice';
import { toCliType, buildConsensusPrompt } from './consensus-prompt-utils';
import type {
  ConsensusOptions,
  ConsensusProviderSpec,
  ConsensusProviderResponse,
  ConsensusResult,
  ConsensusProgressEvent,
  ConsensusStrategy,
} from './consensus.types';
import { getLogger } from '../logging/logger';
import { handleCoordinatorError } from './utils/coordinator-error-handler';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { createAbortController, createChildAbortController } from '../util/abort-controller-tree';
import { observeAdapterRuntimeEvents } from '../providers/adapter-runtime-event-bridge';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { attachCopilotRoute } from '../instance/lifecycle/copilot-route-preflight';
import {
  filterProvidersForAutomation,
  isProviderExcludedFromAutomation,
} from '../providers/automation-provider-exclusions';
import { applyConsensusCheckingPolicy } from './consensus-checking-policy';
import { learnFromCheckerFailure } from '../review/copilot-model-entitlements';
import {
  synthesizeConsensus,
  synthesizeFromResponses as synthesizeFromResponsesImpl,
} from './consensus-synthesis';

const logger = getLogger('ConsensusCoordinator');

/** Maximum concurrent provider queries */
const MAX_CONCURRENT_QUERIES = 5;

/** Default providers to query when none specified */
const DEFAULT_PROVIDER_PRIORITY: CliType[] = ['claude', 'codex', 'antigravity', 'copilot', 'cursor'];

export class ConsensusCoordinator extends EventEmitter {
  private static instance: ConsensusCoordinator | null = null;
  private activeQueries = new Map<string, { abort: () => void }>();

  static getInstance(): ConsensusCoordinator {
    if (!this.instance) {
      this.instance = new ConsensusCoordinator();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.cleanup();
      this.instance = null;
    }
  }

  private constructor() {
    super();
  }

  /**
   * Execute a consensus query across multiple providers.
   *
   * Fans out the question to all specified (or available) providers in parallel,
   * collects responses, and synthesizes a consensus result.
   */
  async query(
    question: string,
    context?: string,
    options: ConsensusOptions = {}
  ): Promise<ConsensusResult> {
    const queryId = `cq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const startTime = Date.now();

    logger.info('Starting consensus query', { queryId, question: question.slice(0, 100) });

    // Resolve which providers to query
    // Same directory the fan-out actually runs in, so the licence check cannot
    // disagree with where the providers are pointed.
    const consensusCwd = options.workingDirectory || process.cwd();
    const checkingPlan = applyConsensusCheckingPolicy(
      await this.resolveProviders(options.providers),
      consensusCwd,
    );
    const providers = checkingPlan.panel;

    if (providers.length === 0) {
      logger.warn('No providers available for consensus query', { queryId });
      return this.emptyResult(startTime, 'No providers available for consensus query');
    }

    logger.info('Resolved providers for consensus', {
      queryId,
      providers: providers.map(p => p.provider),
    });

    this.emitProgress(queryId, 'dispatching', [], providers.map(p => p.provider));

    // Set up abort controller for the overall query
    const queryAbort = createAbortController();
    this.activeQueries.set(queryId, { abort: () => queryAbort.abort('query aborted') });

    const timeoutMs = (options.timeout ?? 60) * 1000;

    try {
      // Voting rounds: concurrent analysis. Final synthesis: exclusive (writes result)

      // Fan out queries to all providers in parallel
      // Each provider gets a child abort controller so non-retryable errors cascade
      const responsePromises = providers.map(spec => {
        const childAbort = createChildAbortController(queryAbort);
        return this.queryProvider(
          queryId,
          spec,
          question,
          context,
          consensusCwd,
          timeoutMs,
          () => childAbort.signal.aborted,
          checkingPlan.copilotProfileId,
        ).catch((error) => {
          if (!queryAbort.signal.aborted) {
            const msg = error instanceof Error ? error.message : String(error);
            if (/auth|unauthorized|forbidden|SIGKILL|SIGSEGV/i.test(msg)) {
              queryAbort.abort(msg);
            }
          }
          throw error;
        });
      });

      const responses = await Promise.all(responsePromises);

      this.emitProgress(
        queryId,
        'synthesizing',
        responses.filter(r => r.success).map(r => r.provider),
        [],
      );

      // Synthesize consensus from responses
      const result = synthesizeConsensus(
        responses,
        options.strategy || 'majority',
        startTime,
        providers,
      );

      this.emitProgress(queryId, 'complete', result.responses.map(r => r.provider), []);

      logger.info('Consensus query complete', {
        queryId,
        agreement: result.agreement,
        successCount: result.successCount,
        failureCount: result.failureCount,
        totalDurationMs: result.totalDurationMs,
      });

      return result;
    } catch (error) {
      handleCoordinatorError(error, {
        coordinatorName: 'ConsensusCoordinator',
        operationName: 'query',
        metadata: { queryId },
      });
      this.emitProgress(queryId, 'error', [], []);
      return this.emptyResult(startTime, error instanceof Error ? error.message : String(error));
    } finally {
      this.activeQueries.delete(queryId);
    }
  }

  /**
   * Query a single provider and collect its response.
   * Creates an ephemeral adapter instance, sends the question, waits for response.
   */
  private async queryProvider(
    queryId: string,
    spec: ConsensusProviderSpec,
    question: string,
    context: string | undefined,
    workingDirectory: string,
    timeoutMs: number,
    isAborted: () => boolean,
    copilotProfileId?: string,
  ): Promise<ConsensusProviderResponse> {
    const providerStart = Date.now();
    const cliType = toCliType(spec.provider);

    logger.debug('Querying provider', { provider: spec.provider, model: spec.model });

    let adapter: CliAdapter | null = null;

    try {
      // Build the consensus prompt
      const prompt = buildConsensusPrompt(question, context);

      // Create a lightweight ephemeral adapter
      const spawnOptions: UnifiedSpawnOptions = {
        workingDirectory,
        systemPrompt: 'You are answering a consensus query. Respond directly and concisely. Do not use orchestrator commands.',
        model: spec.model,
        // Codex desktop surfaces persisted threads; consensus fan-out should stay hidden.
        ephemeral: cliType === 'codex',
        yoloMode: false,
      };

      // Copilot account routing: consensus fan-out picks providers on the
      // user's behalf, so it carries the `consensus` origin.
      adapter = getProviderRuntimeService().createAdapter({
        cliType,
        options: await attachCopilotRoute(cliType, spawnOptions, 'consensus'),
      });

      // Spawn the process
      await adapter.spawn();

      // Collect output
      const response = await this.collectResponse(adapter, prompt, timeoutMs, isAborted);

      const durationMs = Date.now() - providerStart;

      // A throttled CLI streams a status notice ("You've hit your session limit
      // · resets 6:30pm") and exits 0. Record it as a failed vote rather than a
      // real opinion, so it can't pollute consensus aggregation with a
      // junk vote (missing confidence is explicitly zero).
      if (isProviderNotice(response)) {
        logger.warn('Consensus provider returned a rate-limit/status notice; recording as a failed vote', {
          provider: spec.provider,
        });
        this.emit('consensus:vote', {
          queryId,
          workingDirectory,
          provider: spec.provider,
          content: '[provider usage-limit notice]',
          confidence: 0,
          success: false,
        });
        return {
          provider: spec.provider,
          model: spec.model,
          content: '',
          success: false,
          error: `[${ErrorCategory.RATE_LIMITED}] provider returned a usage-limit notice`,
          durationMs,
        };
      }

      const consensusResponse: ConsensusProviderResponse = {
        provider: spec.provider,
        model: spec.model,
        content: response,
        success: true,
        durationMs,
      };

      this.emit('consensus:vote', {
        queryId,
        workingDirectory,
        provider: spec.provider,
        content: response,
        confidence: this.estimateVoteConfidence(response, true),
        success: true,
      });

      return consensusResponse;
    } catch (error) {
      const durationMs = Date.now() - providerStart;
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Learn a Copilot seat's real roster from its refusal; otherwise the same
      // unavailable model is re-selected on every future licence-pinned panel.
      learnFromCheckerFailure(copilotProfileId, errorMessage);

      const { classified } = handleCoordinatorError(error, {
        coordinatorName: 'ConsensusCoordinator',
        operationName: 'queryProvider',
        metadata: { provider: spec.provider },
      });

      const isTransient =
        classified.category === ErrorCategory.TRANSIENT ||
        classified.category === ErrorCategory.RATE_LIMITED;

      const response: ConsensusProviderResponse = {
        provider: spec.provider,
        model: spec.model,
        content: '',
        success: false,
        error: isTransient
          ? `[${classified.category}] ${errorMessage}`
          : errorMessage,
        durationMs,
      };

      this.emit('consensus:vote', {
        queryId,
        workingDirectory,
        provider: spec.provider,
        content: response.error || errorMessage,
        confidence: 0,
        success: false,
      });

      return response;
    } finally {
      // Always terminate the ephemeral adapter
      if (adapter) {
        try {
          await adapter.terminate(false);
        } catch {
          /* intentionally ignored: adapter cleanup errors should not mask the original result */
        }
      }
    }
  }

  /**
   * Send the prompt to an adapter and collect the full response.
   * Returns when the adapter goes back to idle or times out.
   */
  private collectResponse(
    adapter: CliAdapter,
    prompt: string,
    timeoutMs: number,
    isAborted: () => boolean,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      let latestAccumulatedContent = '';
      let settled = false;

      const settle = (result: string | Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      const timeout = setTimeout(() => {
        settle(new Error(`Provider timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Periodically check if the parent query was aborted
      const abortCheck = setInterval(() => {
        if (isAborted()) {
          settle(new Error('Consensus query aborted'));
        }
      }, 1000);

      const stopObserving = observeAdapterRuntimeEvents(adapter, (runtimeEvent) => {
        const { event } = runtimeEvent;
        switch (event.kind) {
          case 'output':
            if ((event.messageType === undefined || event.messageType === 'assistant') && event.content) {
              const accumulatedContent = event.metadata?.['accumulatedContent'];
              if (typeof accumulatedContent === 'string') {
                latestAccumulatedContent = accumulatedContent;
              } else {
                chunks.push(event.content);
              }
            }
            break;
          case 'status':
            if (event.status === 'idle' && (latestAccumulatedContent || chunks.length > 0)) {
              settle(latestAccumulatedContent || chunks.join(''));
            }
            break;
          case 'complete':
            {
              const rawPayload = runtimeEvent.rawPayload;
              const responseContent =
                rawPayload &&
                typeof rawPayload === 'object' &&
                'content' in rawPayload &&
                typeof rawPayload.content === 'string'
                  ? rawPayload.content
                  : '';
              const content = responseContent || latestAccumulatedContent || chunks.join('');
              settle(content || new Error('Provider completed with no output'));
            }
            break;
          case 'error':
            settle(new Error(event.message));
            break;
          case 'exit':
            // Safety net: adapters emit 'idle' for normal completion, but if the
            // underlying process crashes/terminates we still need to settle.
            if (latestAccumulatedContent || chunks.length > 0) {
              settle(latestAccumulatedContent || chunks.join(''));
            } else {
              settle(new Error(`Provider process exited with code ${event.code} and no output`));
            }
            break;
          default:
            break;
        }
      });

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(abortCheck);
        stopObserving();
      };

      // Send the prompt
      adapter.sendInput(prompt).catch((err: Error) => settle(err));
    });
  }

  /**
   * Resolve which providers are available and should be queried.
   */
  private async resolveProviders(
    requested?: ConsensusProviderSpec[]
  ): Promise<ConsensusProviderSpec[]> {
    const detection = CliDetectionService.getInstance();
    const result = await detection.detectAll();
    const availableNames = new Set(result.available.map(c => c.name));

    if (requested && requested.length > 0) {
      // Filter requested providers to only those that are available. The
      // "requested" list comes from an orchestrator agent's consensus_query
      // command, not from a human picking a session provider, so the automation
      // exclusions apply to it just as they do to the default fan-out.
      return requested.filter(spec => {
        const cliType = toCliType(spec.provider);
        return availableNames.has(cliType) && !isProviderExcludedFromAutomation(cliType);
      });
    }

    // Default: use all available providers from the priority list
    return filterProvidersForAutomation(DEFAULT_PROVIDER_PRIORITY, 'consensus')
      .filter(cli => availableNames.has(cli))
      .slice(0, MAX_CONCURRENT_QUERIES)
      .map(cli => ({ provider: cli as ConsensusProviderSpec['provider'] }));
  }

  /**
   * Synthesize consensus text directly from already-collected provider
   * responses (e.g. an Ask Council compare run, WS-B6) — no new provider
   * calls, just the existing agreement/dissent/edge-case algorithm this
   * class already uses for live `query()` fan-outs. Public so callers that
   * hold pre-collected `ConsensusProviderResponse[]` (successes AND
   * failures — failures keep absent members visible in the result) can
   * reuse the exact same synthesis this coordinator produces for a live
   * query, without re-querying any provider.
   */
  synthesizeFromResponses(
    responses: ConsensusProviderResponse[],
    strategy: ConsensusStrategy = 'majority',
    providerSpecs: ConsensusProviderSpec[] = [],
  ): ConsensusResult {
    return synthesizeFromResponsesImpl(responses, strategy, providerSpecs);
  }

  /**
   * Create an empty/error result
   */
  private emptyResult(startTime: number, error: string): ConsensusResult {
    return {
      consensus: `Consensus query failed: ${error}`,
      agreement: 0,
      responses: [],
      dissent: [],
      edgeCases: [],
      totalDurationMs: Date.now() - startTime,
      totalEstimatedCost: 0,
      successCount: 0,
      failureCount: 0,
    };
  }

  /**
   * Emit a progress event for tracking
   */
  private emitProgress(
    queryId: string,
    phase: ConsensusProgressEvent['phase'],
    respondedProviders: string[],
    pendingProviders: string[],
  ): void {
    const event: ConsensusProgressEvent = {
      queryId,
      phase,
      respondedProviders,
      pendingProviders,
    };
    this.emit('consensus:progress', event);
  }

  private estimateVoteConfidence(content: string, success: boolean): number {
    if (!success) {
      return 0;
    }

    // Backward compatibility for older/custom voters that still emit words;
    // the current prompt requires numeric `Confidence: NN/100`.
    const wordMatch = content.match(/confidence\s*[:=-]?\s*(high|medium|low)\b/i);
    if (wordMatch?.[1]) {
      const word = wordMatch[1].toLowerCase();
      return word === 'high' ? 0.9 : word === 'medium' ? 0.6 : 0.3;
    }

    // Also accept numeric formats ("confidence: 85%", "confidence 70/100").
    const match = content.match(/confidence\s*[:=-]?\s*(\d{1,3})(?:\s*%|\s*\/\s*100)?/i);
    if (!match?.[1]) {
      return 0;
    }

    const parsed = Number.parseInt(match[1], 10);
    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return Math.max(0, Math.min(1, parsed / 100));
  }

  /**
   * Abort an active consensus query
   */
  abortQuery(queryId: string): boolean {
    const query = this.activeQueries.get(queryId);
    if (query) {
      query.abort();
      return true;
    }
    return false;
  }

  /**
   * Get the number of active consensus queries
   */
  getActiveQueryCount(): number {
    return this.activeQueries.size;
  }

  /**
   * Cleanup all active queries
   */
  cleanup(): void {
    for (const [, query] of this.activeQueries) {
      query.abort();
    }
    this.activeQueries.clear();
  }
}

/** Convenience getter */
export function getConsensusCoordinator(): ConsensusCoordinator {
  return ConsensusCoordinator.getInstance();
}
