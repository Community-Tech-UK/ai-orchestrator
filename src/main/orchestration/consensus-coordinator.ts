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
import { createCliAdapter, type CliAdapter, type UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import { CliDetectionService, type CliType } from '../cli/cli-detection';
import type { OutputMessage } from '../../shared/types/instance.types';
import type {
  ConsensusOptions,
  ConsensusProviderSpec,
  ConsensusProviderResponse,
  ConsensusResult,
  ConsensusProgressEvent,
} from '../../shared/types/consensus.types';
import { getLogger } from '../logging/logger';
import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { createAbortController, createChildAbortController } from '../util/abort-controller-tree';

const logger = getLogger('ConsensusCoordinator');

/** Maximum concurrent provider queries */
const MAX_CONCURRENT_QUERIES = 5;

/** Default providers to query when none specified */
const DEFAULT_PROVIDER_PRIORITY: CliType[] = ['claude', 'codex', 'gemini', 'copilot'];

/**
 * Maps user-facing provider names to CliType
 */
function toCliType(provider: string): CliType {
  switch (provider) {
    case 'claude': return 'claude';
    case 'codex': return 'codex';
    case 'gemini': return 'gemini';
    case 'copilot': return 'copilot';
    default: return provider as CliType;
  }
}

/**
 * Build a focused prompt for consensus queries.
 * Keeps responses concise and structured for easy comparison.
 */
function buildConsensusPrompt(question: string, context?: string): string {
  const parts = [
    'You are being consulted as part of a multi-model consensus query.',
    'Multiple AI models are answering the same question independently.',
    'Give your honest, thorough analysis. Be specific and concrete.',
    'Highlight any edge cases, risks, or caveats you identify.',
    '',
    'IMPORTANT: Respond with your analysis only. Do NOT use any orchestrator commands.',
    'Do NOT spawn children or use tools. Just answer the question directly.',
  ];

  if (context) {
    parts.push('', '## Context', context);
  }

  parts.push('', '## Question', question);

  return parts.join('\n');
}

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
    const providers = await this.resolveProviders(options.providers);

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
      // Fan out queries to all providers in parallel
      // Each provider gets a child abort controller so non-retryable errors cascade
      const responsePromises = providers.map(spec => {
        const childAbort = createChildAbortController(queryAbort);
        return this.queryProvider(
          spec,
          question,
          context,
          options.workingDirectory || process.cwd(),
          timeoutMs,
          () => childAbort.signal.aborted,
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
      const result = this.synthesizeConsensus(
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
      const classified = getErrorRecoveryManager().classifyError(
        error instanceof Error ? error : new Error(String(error)),
        'ConsensusCoordinator'
      );
      logger.error('Consensus query failed', error instanceof Error ? error : undefined, {
        queryId,
        category: classified.category,
        severity: classified.severity,
        recoverable: classified.recoverable,
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
    spec: ConsensusProviderSpec,
    question: string,
    context: string | undefined,
    workingDirectory: string,
    timeoutMs: number,
    isAborted: () => boolean,
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
        yoloMode: true, // No permission prompts for read-only consensus queries
      };

      adapter = createCliAdapter(cliType, spawnOptions);

      // Spawn the process
      await adapter.spawn();

      // Collect output
      const response = await this.collectResponse(adapter, prompt, timeoutMs, isAborted);

      const durationMs = Date.now() - providerStart;

      return {
        provider: spec.provider,
        model: spec.model,
        content: response,
        success: true,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - providerStart;
      const errorMessage = error instanceof Error ? error.message : String(error);

      const classified = getErrorRecoveryManager().classifyError(
        error instanceof Error ? error : new Error(errorMessage),
        `ConsensusCoordinator.queryProvider[${spec.provider}]`
      );

      const isTransient =
        classified.category === ErrorCategory.TRANSIENT ||
        classified.category === ErrorCategory.RATE_LIMITED;

      logger.warn('Provider query failed', {
        provider: spec.provider,
        error: errorMessage,
        category: classified.category,
        recoverable: classified.recoverable,
        isTransient,
      });

      return {
        provider: spec.provider,
        model: spec.model,
        content: '',
        success: false,
        error: isTransient
          ? `[${classified.category}] ${errorMessage}`
          : errorMessage,
        durationMs,
      };
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

      const onOutput = (message: OutputMessage | string) => {
        const content = typeof message === 'string'
          ? message
          : (message as OutputMessage).type === 'assistant'
            ? (message as OutputMessage).content
            : '';
        if (content) {
          chunks.push(content);
        }
      };

      const onStatus = (status: string) => {
        // When the adapter returns to idle, the response is complete
        if (status === 'idle' && chunks.length > 0) {
          settle(chunks.join(''));
        }
      };

      const onError = (error: Error | string) => {
        settle(error instanceof Error ? error : new Error(String(error)));
      };

      const onExit = (code: number | null) => {
        // Safety net: adapters emit 'idle' for normal completion, but if the
        // underlying process crashes/terminates we still need to settle.
        if (chunks.length > 0) {
          settle(chunks.join(''));
        } else {
          settle(new Error(`Provider process exited with code ${code} and no output`));
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(abortCheck);
        adapter.removeListener('output', onOutput);
        adapter.removeListener('status', onStatus);
        adapter.removeListener('error', onError);
        adapter.removeListener('exit', onExit);
      };

      adapter.on('output', onOutput);
      adapter.on('status', onStatus);
      adapter.on('error', onError);
      adapter.on('exit', onExit);

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
      // Filter requested providers to only those that are available
      return requested.filter(spec => {
        const cliType = toCliType(spec.provider);
        return availableNames.has(cliType);
      });
    }

    // Default: use all available providers from the priority list
    return DEFAULT_PROVIDER_PRIORITY
      .filter(cli => availableNames.has(cli))
      .slice(0, MAX_CONCURRENT_QUERIES)
      .map(cli => ({ provider: cli as ConsensusProviderSpec['provider'] }));
  }

  /**
   * Synthesize consensus from individual provider responses.
   */
  private synthesizeConsensus(
    responses: ConsensusProviderResponse[],
    strategy: string,
    startTime: number,
    providerSpecs: ConsensusProviderSpec[],
  ): ConsensusResult {
    const successful = responses.filter(r => r.success);
    const failed = responses.filter(r => !r.success);

    if (successful.length === 0) {
      return this.emptyResult(startTime, 'All providers failed');
    }

    // For 'all' strategy, just return raw responses without synthesis
    if (strategy === 'all') {
      return {
        consensus: successful.map(r => `**[${r.provider}${r.model ? ` / ${r.model}` : ''}]:**\n${r.content}`).join('\n\n---\n\n'),
        agreement: 0, // Not computed for 'all' strategy
        responses,
        dissent: [],
        edgeCases: [],
        totalDurationMs: Date.now() - startTime,
        totalEstimatedCost: responses.reduce((sum, r) => sum + (r.estimatedCost || 0), 0),
        successCount: successful.length,
        failureCount: failed.length,
      };
    }

    // For majority/weighted strategies, synthesize consensus
    const { consensus, agreement, dissent, edgeCases } = this.buildConsensus(successful, strategy, providerSpecs);

    return {
      consensus,
      agreement,
      responses,
      dissent,
      edgeCases,
      totalDurationMs: Date.now() - startTime,
      totalEstimatedCost: responses.reduce((sum, r) => sum + (r.estimatedCost || 0), 0),
      successCount: successful.length,
      failureCount: failed.length,
    };
  }

  /**
   * Build consensus from successful responses.
   *
   * Strategy behavior:
   * - 'majority': Extracts shared themes across providers, presents agreement first,
   *   then individual details. Designed to minimize context usage.
   * - 'weighted': Sorts responses by provider weight, presents highest-weighted
   *   provider's response as the primary answer with supporting views.
   */
  private buildConsensus(
    responses: ConsensusProviderResponse[],
    strategy: string,
    providerSpecs: ConsensusProviderSpec[],
  ): { consensus: string; agreement: number; dissent: string[]; edgeCases: string[] } {
    if (responses.length === 1) {
      return {
        consensus: responses[0].content,
        agreement: 1,
        dissent: [],
        edgeCases: [],
      };
    }

    // Compute agreement score
    const agreement = this.computeAgreementScore(responses);

    // Extract edge cases
    const edgeCases = this.extractEdgeCases(responses);

    // Identify dissent
    const dissent = this.identifyDissent(responses, agreement);

    // Build strategy-specific consensus text
    const consensus = strategy === 'weighted'
      ? this.buildWeightedConsensus(responses, agreement, edgeCases, providerSpecs)
      : this.buildMajorityConsensus(responses, agreement, edgeCases);

    return { consensus, agreement, dissent, edgeCases };
  }

  /**
   * Majority strategy: Extract shared themes, present agreement areas first,
   * then per-provider specifics only where they diverge.
   */
  private buildMajorityConsensus(
    responses: ConsensusProviderResponse[],
    agreement: number,
    edgeCases: string[],
  ): string {
    const parts: string[] = [];

    // Header
    if (agreement >= 0.7) {
      parts.push(`## Consensus (${responses.length} providers, ${Math.round(agreement * 100)}% agreement)\n`);
    } else {
      parts.push(`## Multi-Model Analysis (${responses.length} providers, ${Math.round(agreement * 100)}% agreement)\n`);
      parts.push('*Note: Providers showed significant disagreement. Review individual responses carefully.*\n');
    }

    // Extract shared key terms that appear in a majority of responses
    const sharedTerms = this.extractSharedTerms(responses);
    if (sharedTerms.length > 0) {
      parts.push('### Key Themes (mentioned by majority)');
      parts.push(sharedTerms.map(t => `- ${t}`).join('\n'));
      parts.push('');
    }

    // Per-provider summaries — truncated to first paragraph for context efficiency
    parts.push('### Provider Responses\n');
    for (const r of responses) {
      const label = `**${r.provider}${r.model ? ` (${r.model})` : ''}**`;
      const summary = this.truncateToFirstParagraph(r.content, 500);
      parts.push(`${label}: ${summary}`);
      parts.push('');
    }

    // Edge cases
    if (edgeCases.length > 0) {
      parts.push('### Edge Cases & Caveats');
      for (const ec of edgeCases) {
        parts.push(`- ${ec}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Weighted strategy: Sort by provider weight, present highest-weighted
   * response as primary, others as supporting/contrasting views.
   */
  private buildWeightedConsensus(
    responses: ConsensusProviderResponse[],
    agreement: number,
    edgeCases: string[],
    providerSpecs: ConsensusProviderSpec[],
  ): string {
    // Build a weight map from specs
    const weightMap = new Map<string, number>();
    for (const spec of providerSpecs) {
      weightMap.set(spec.provider, spec.weight ?? 1);
    }

    // Sort responses by weight descending
    const sorted = [...responses].sort((a, b) =>
      (weightMap.get(b.provider) ?? 1) - (weightMap.get(a.provider) ?? 1)
    );

    const primary = sorted[0];
    const supporting = sorted.slice(1);
    const primaryWeight = weightMap.get(primary.provider) ?? 1;

    const parts: string[] = [];
    parts.push(`## Weighted Consensus (${responses.length} providers, ${Math.round(agreement * 100)}% agreement)\n`);

    // Primary response (highest weight)
    const primaryLabel = `${primary.provider}${primary.model ? ` (${primary.model})` : ''}`;
    parts.push(`### Primary: ${primaryLabel} (weight: ${primaryWeight})\n`);
    parts.push(primary.content);
    parts.push('');

    // Supporting views — truncated
    if (supporting.length > 0) {
      parts.push('### Supporting Views\n');
      for (const r of supporting) {
        const w = weightMap.get(r.provider) ?? 1;
        const label = `**${r.provider}${r.model ? ` (${r.model})` : ''}** (weight: ${w})`;
        const summary = this.truncateToFirstParagraph(r.content, 400);
        parts.push(`${label}: ${summary}`);
        parts.push('');
      }
    }

    // Edge cases
    if (edgeCases.length > 0) {
      parts.push('### Edge Cases & Caveats');
      for (const ec of edgeCases) {
        parts.push(`- ${ec}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Extract edge cases from response content.
   */
  private extractEdgeCases(responses: ConsensusProviderResponse[]): string[] {
    const edgeCases: string[] = [];
    for (const r of responses) {
      const matches = r.content.matchAll(
        /(?:edge case|caveat|risk|warning|gotcha|pitfall|however|but note|be aware|careful|watch out)[:\s]([^\n.]+[.\n])/gi
      );
      for (const match of matches) {
        const edgeCase = match[1].trim();
        if (edgeCase && !edgeCases.some(ec => ec.toLowerCase() === edgeCase.toLowerCase())) {
          edgeCases.push(edgeCase);
        }
      }
    }
    return edgeCases;
  }

  /**
   * Identify areas of disagreement between responses.
   */
  private identifyDissent(responses: ConsensusProviderResponse[], agreement: number): string[] {
    const dissent: string[] = [];
    if (agreement < 0.9 && responses.length >= 2) {
      const lengths = responses.map(r => r.content.length);
      const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const maxDiff = Math.max(...lengths.map(l => Math.abs(l - avgLen) / avgLen));

      if (maxDiff > 0.5) {
        dissent.push('Responses varied significantly in depth/detail');
      }

      if (agreement < 0.5) {
        dissent.push('Low vocabulary overlap suggests fundamentally different perspectives');
      }
    }
    return dissent;
  }

  /**
   * Extract significant terms shared by a majority of responses.
   * Returns terms appearing in > 50% of responses, sorted by frequency.
   */
  private extractSharedTerms(responses: ConsensusProviderResponse[]): string[] {
    const threshold = Math.ceil(responses.length / 2);

    // Tokenize each response into significant words (5+ chars to skip noise)
    const perResponse = responses.map(r => {
      const words = r.content
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 5);
      return new Set(words);
    });

    // Count how many responses contain each word
    const termCounts = new Map<string, number>();
    for (const wordSet of perResponse) {
      for (const word of wordSet) {
        termCounts.set(word, (termCounts.get(word) ?? 0) + 1);
      }
    }

    // Filter to majority terms, sort by frequency, take top 10
    return [...termCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([term]) => term);
  }

  /**
   * Truncate content to approximately the first paragraph or maxChars,
   * whichever is shorter. Appends "..." if truncated.
   */
  private truncateToFirstParagraph(content: string, maxChars: number): string {
    // Find first double-newline (paragraph break)
    const paragraphEnd = content.indexOf('\n\n');
    const firstParagraph = paragraphEnd > 0 && paragraphEnd < maxChars
      ? content.slice(0, paragraphEnd)
      : content.slice(0, maxChars);

    if (firstParagraph.length < content.length) {
      return firstParagraph.trimEnd() + '...';
    }
    return firstParagraph;
  }

  /**
   * Compute a rough agreement score between responses.
   * Uses a simple token overlap approach (Jaccard-like similarity).
   */
  private computeAgreementScore(responses: ConsensusProviderResponse[]): number {
    if (responses.length < 2) return 1;

    // Tokenize each response into significant words
    const tokenSets = responses.map(r => {
      const words = r.content
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3); // Skip short words
      return new Set(words);
    });

    // Compute pairwise Jaccard similarity
    let totalSimilarity = 0;
    let pairs = 0;

    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        const intersection = new Set([...tokenSets[i]].filter(w => tokenSets[j].has(w)));
        const union = new Set([...tokenSets[i], ...tokenSets[j]]);
        const similarity = union.size > 0 ? intersection.size / union.size : 0;
        totalSimilarity += similarity;
        pairs++;
      }
    }

    return pairs > 0 ? totalSimilarity / pairs : 0;
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
