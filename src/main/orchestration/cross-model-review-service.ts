import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { registerCleanup } from '../util/cleanup-registry';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { createCliAdapter, resolveCliType } from '../cli/adapters/adapter-factory';
import { getInstanceManager } from '../instance/instance-manager';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import type { CliType as SettingsCliType } from '../../shared/types/settings.types';
import { CliDetectionService } from '../cli/cli-detection';
import { OutputClassifier } from './output-classifier';
import { ReviewerPool } from './reviewer-pool';
import {
  buildStructuredReviewPrompt,
  buildTieredReviewPrompt,
  truncateForReview,
} from './review-prompts';
import {
  ReviewResultJsonSchema,
  TieredReviewResultJsonSchema,
} from '../../shared/validation/cross-model-review-schemas';
import type {
  AggregatedReview,
  ReviewOutputType,
  ReviewResult,
  ReviewVerdict,
  CrossModelReviewStatus,
} from '../../shared/types/cross-model-review.types';
import type { OutputBuffer, ReviewDispatchRequest } from './cross-model-review.types';

const logger = getLogger('CrossModelReviewService');

const MIN_COOLDOWN_MS = 10_000;
const MAX_REVIEW_HISTORY = 50;
const RATE_LIMIT_CHECK_INTERVAL_MS = 30_000;

function isCliAdapterLike(adapter: unknown): adapter is { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as Record<string, unknown>)?.['sendMessage'] === 'function';
}

export class CrossModelReviewService extends EventEmitter {
  private static instance: CrossModelReviewService | null = null;

  private classifier = new OutputClassifier();
  private reviewerPool = new ReviewerPool();
  private buffers = new Map<string, OutputBuffer>();
  private lastReviewTime = new Map<string, number>();
  private reviewHistory = new Map<string, AggregatedReview[]>();
  private reviewContexts = new Map<string, ReviewDispatchRequest>();
  private pendingReviews = new Map<string, AbortController>();
  private pendingReviewInstances = new Map<string, string>();
  private rateLimitTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  static getInstance(): CrossModelReviewService {
    if (!this.instance) {
      this.instance = new CrossModelReviewService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.shutdown();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    registerCleanup(() => this.shutdown());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.refreshAvailability();
    this.rateLimitTimer = setInterval(() => {
      this.reviewerPool.checkRateLimitRecovery();
    }, RATE_LIMIT_CHECK_INTERVAL_MS);
    logger.info('CrossModelReviewService initialized', {
      reviewers: this.reviewerPool.getStatus(),
    });
  }

  // === Message Buffering ===

  bufferMessage(instanceId: string, messageType: string, content: string, primaryProvider = 'claude', firstUserPrompt = ''): void {
    if (messageType !== 'assistant') return;
    let buffer = this.buffers.get(instanceId);
    if (!buffer) {
      buffer = { instanceId, messages: [], primaryProvider, firstUserPrompt, lastUpdated: Date.now() };
      this.buffers.set(instanceId, buffer);
    }
    buffer.messages.push(content);
    buffer.lastUpdated = Date.now();
  }

  getBufferSize(instanceId: string): number {
    return this.buffers.get(instanceId)?.messages.length ?? 0;
  }

  clearBuffer(instanceId: string): void {
    this.buffers.delete(instanceId);
  }

  // === Trigger (called when instance goes idle) ===

  async onInstanceIdle(instanceId: string): Promise<void> {
    const settings = getSettingsManager().getAll();
    if (!settings.crossModelReviewEnabled) return;

    const buffer = this.buffers.get(instanceId);
    if (!buffer || buffer.messages.length === 0) return;

    const aggregatedContent = buffer.messages.join('\n\n');
    this.buffers.delete(instanceId);

    if (aggregatedContent.length < 50) return;

    const lastReview = this.lastReviewTime.get(instanceId) ?? 0;
    if (Date.now() - lastReview < MIN_COOLDOWN_MS) {
      logger.debug('Skipping review due to cooldown', { instanceId });
      return;
    }

    const classification = this.classifier.classify(aggregatedContent);
    if (!classification.shouldReview) return;

    const instance = getInstanceManager().getInstance(instanceId);
    const firstUserPrompt = instance?.outputBuffer
      .find(message => message.type === 'user' && message.content.trim().length > 0)
      ?.content.trim();

    const enabledTypes = settings.crossModelReviewTypes as string[];
    if (!enabledTypes.includes(classification.type)) return;

    let reviewDepth = settings.crossModelReviewDepth as 'structured' | 'tiered';
    if (reviewDepth === 'structured' && classification.isComplex) {
      reviewDepth = 'tiered';
    }

    await this.refreshAvailability();
    const selectedReviewers = this.reviewerPool.selectReviewers(
      buffer.primaryProvider,
      settings.crossModelReviewMaxReviewers,
    );

    if (selectedReviewers.length === 0) {
      this.emit('review:all-unavailable', { instanceId });
      return;
    }

    const reviewId = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.lastReviewTime.set(instanceId, Date.now());
    this.emit('review:started', { instanceId, reviewId });

    const request: ReviewDispatchRequest = {
      id: reviewId,
      instanceId,
      primaryProvider: buffer.primaryProvider,
      workingDirectory: instance?.workingDirectory || process.cwd(),
      content: truncateForReview(aggregatedContent),
      taskDescription: firstUserPrompt || buffer.firstUserPrompt || instance?.displayName || 'No task description available',
      classification,
      reviewDepth,
      timestamp: Date.now(),
    };

    this.reviewContexts.set(reviewId, request);

    this.executeReviews(request, selectedReviewers, settings.crossModelReviewTimeout)
      .catch(err => logger.error('Review execution failed', err, { reviewId }));
  }

  // === Review Execution ===

  private async executeReviews(request: ReviewDispatchRequest, reviewerClis: string[], timeoutSeconds: number): Promise<void> {
    const abort = new AbortController();
    this.pendingReviews.set(request.id, abort);
    this.pendingReviewInstances.set(request.id, request.instanceId);

    try {
      const successfulResults = await this.collectSuccessfulReviews(request, reviewerClis, timeoutSeconds, abort.signal);

      if (successfulResults.length === 0) {
        this.reviewContexts.delete(request.id);
        this.emit('review:all-unavailable', { instanceId: request.instanceId });
        return;
      }

      const hasDisagreement = this.detectDisagreement(successfulResults);

      const aggregated: AggregatedReview = {
        id: request.id,
        instanceId: request.instanceId,
        outputType: request.classification.type as ReviewOutputType,
        reviewDepth: request.reviewDepth,
        reviews: successfulResults,
        hasDisagreement,
        timestamp: Date.now(),
      };

      this.addToHistory(request.instanceId, aggregated);
      this.emit('review:result', aggregated);
    } finally {
      this.pendingReviews.delete(request.id);
      this.pendingReviewInstances.delete(request.id);
    }
  }

  private async collectSuccessfulReviews(
    request: ReviewDispatchRequest,
    reviewerClis: string[],
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<ReviewResult[]> {
    const attempted = new Set<string>();
    const successful: ReviewResult[] = [];
    let candidates = [...reviewerClis];
    const desiredCount = reviewerClis.length;

    while (candidates.length > 0 && successful.length < desiredCount) {
      for (const cliType of candidates) attempted.add(cliType);

      const results = await Promise.allSettled(
        candidates.map(cliType => this.executeOneReview(request, cliType, timeoutSeconds, signal))
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          successful.push(result.value);
        }
      }

      const remaining = desiredCount - successful.length;
      if (remaining <= 0) break;

      candidates = this.reviewerPool.selectReviewers(
        request.primaryProvider,
        remaining,
        Array.from(attempted),
      );
    }

    return successful;
  }

  private async executeOneReview(request: ReviewDispatchRequest, cliType: string, timeoutSeconds: number, signal: AbortSignal): Promise<ReviewResult | null> {
    const startTime = Date.now();
    const breaker = getCircuitBreakerRegistry().getBreaker(`cross-review-${cliType}`, {
      failureThreshold: 3,
      resetTimeoutMs: 60000,
    });

    try {
      const response = await breaker.execute(async () => {
        if (signal.aborted) throw new Error('Review cancelled');

        const resolvedCli = await resolveCliType(cliType as SettingsCliType);
        const adapter = createCliAdapter(resolvedCli, {
          workingDirectory: request.workingDirectory,
          timeout: timeoutSeconds * 1000,
          yoloMode: false,
        });

        if (!isCliAdapterLike(adapter)) {
          throw new Error(`CLI adapter "${cliType}" does not support sendMessage`);
        }

        const prompt = request.reviewDepth === 'tiered'
          ? buildTieredReviewPrompt(request.taskDescription, request.content)
          : buildStructuredReviewPrompt(request.taskDescription, request.content);

        return adapter.sendMessage({ role: 'user', content: prompt });
      });

      const parsed = this.parseReviewResponse(cliType, response.content, request.reviewDepth, Date.now() - startTime);
      if (!parsed) {
        logger.warn('Skipping unparseable reviewer response', { cliType, reviewId: request.id });
        return null;
      }

      this.reviewerPool.recordSuccess(cliType);
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('429') || message.toLowerCase().includes('rate limit') || message.toLowerCase().includes('quota')) {
        this.reviewerPool.markRateLimited(cliType);
      } else {
        this.reviewerPool.recordFailure(cliType);
      }
      logger.warn('Review failed', { cliType, error: message });
      throw err;
    }
  }

  // === Response Parsing ===

  private parseReviewResponse(reviewerId: string, rawResponse: string, reviewDepth: 'structured' | 'tiered', durationMs: number): ReviewResult | null {
    const baseResult: Partial<ReviewResult> = {
      reviewerId,
      reviewType: reviewDepth,
      timestamp: Date.now(),
      durationMs,
    };

    const parsed = this.extractJson(rawResponse);

    if (!parsed) {
      logger.warn('Failed to extract JSON from review response', { reviewerId, responseLength: rawResponse.length });
      return null;
    }

    // Pre-coerce common model quirks before schema validation
    const coerced = this.coerceReviewJson(parsed);

    const schema = reviewDepth === 'tiered' ? TieredReviewResultJsonSchema : ReviewResultJsonSchema;
    const validated = schema.safeParse(coerced);

    if (!validated.success) {
      logger.warn('Review response failed schema validation', {
        reviewerId,
        errors: validated.error.issues.slice(0, 3),
      });
      return null;
    }

    const data = validated.data;
    const scores = 'scores' in data ? data.scores : data;

    return {
      ...baseResult,
      scores: {
        correctness: scores.correctness,
        completeness: scores.completeness,
        security: scores.security,
        consistency: scores.consistency,
        feasibility: 'feasibility' in scores ? scores.feasibility : undefined,
      },
      overallVerdict: data.overall_verdict as ReviewVerdict,
      summary: data.summary,
      criticalIssues: 'critical_issues' in data ? data.critical_issues : undefined,
      traces: 'traces' in data ? data.traces : undefined,
      boundariesChecked: 'boundaries_checked' in data ? data.boundaries_checked : undefined,
      assumptions: 'assumptions' in data ? data.assumptions : undefined,
      integrationRisks: 'integration_risks' in data ? data.integration_risks : undefined,
      parseSuccess: true,
    } as ReviewResult;
  }

  /**
   * Extract JSON from a reviewer response, handling common model output quirks:
   * markdown fences, preamble text, trailing commentary, nested braces.
   */
  private extractJson(rawResponse: string): unknown | null {
    let cleaned = rawResponse.trim();

    // Strategy 1: Extract from markdown fences (```json ... ``` or ``` ... ```)
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    // Strategy 2: Direct parse (works when model follows instructions perfectly)
    try {
      return JSON.parse(cleaned);
    } catch {
      // continue to fallback strategies
    }

    // Strategy 3: Find the outermost balanced JSON object
    const jsonStart = cleaned.indexOf('{');
    if (jsonStart >= 0) {
      const candidate = this.extractBalancedJson(cleaned, jsonStart);
      if (candidate) {
        try {
          return JSON.parse(candidate);
        } catch {
          // continue
        }
      }

      // Strategy 4: Greedy regex fallback (last resort)
      const greedyMatch = cleaned.match(/\{[\s\S]*\}/);
      if (greedyMatch) {
        try {
          return JSON.parse(greedyMatch[0]);
        } catch {
          // all strategies exhausted
        }
      }
    }

    return null;
  }

  /**
   * Extract a balanced JSON object starting at the given index.
   * Tracks brace depth to avoid grabbing trailing text.
   */
  private extractBalancedJson(text: string, startIdx: number): string | null {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(startIdx, i + 1);
      }
    }
    return null;
  }

  /**
   * Coerce common model output quirks to match the expected schema:
   * - String-typed scores ("3" → 3)
   * - Missing issues arrays (undefined → [])
   * - Verdict case variations ("approve" → "APPROVE")
   */
  private coerceReviewJson(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null) return raw;
    const obj = raw as Record<string, unknown>;

    // Coerce overall_verdict case
    if (typeof obj['overall_verdict'] === 'string') {
      obj['overall_verdict'] = obj['overall_verdict'].toUpperCase();
    }

    // Coerce dimension scores (both flat and nested under "scores")
    const scoreSections = obj['scores'] ? [obj['scores'] as Record<string, unknown>] : [obj];
    // Also coerce top-level dimensions for structured format
    if (!obj['scores']) scoreSections.push(obj);
    else scoreSections.push(obj['scores'] as Record<string, unknown>);

    const dimensions = ['correctness', 'completeness', 'security', 'consistency', 'feasibility'];
    for (const section of scoreSections) {
      if (typeof section !== 'object' || section === null) continue;
      for (const dim of dimensions) {
        const dimObj = (section as Record<string, unknown>)[dim];
        if (typeof dimObj === 'object' && dimObj !== null) {
          const d = dimObj as Record<string, unknown>;
          // Coerce string scores to numbers
          if (typeof d['score'] === 'string') {
            const num = parseInt(d['score'], 10);
            if (!isNaN(num)) d['score'] = num;
          }
          // Ensure issues is an array
          if (!Array.isArray(d['issues'])) {
            d['issues'] = d['issues'] ? [String(d['issues'])] : [];
          }
          // Ensure reasoning is a string
          if (typeof d['reasoning'] !== 'string') {
            d['reasoning'] = d['reasoning'] ? String(d['reasoning']) : 'No reasoning provided';
          }
        }
      }
    }

    return obj;
  }

  // === Disagreement Detection ===

  private detectDisagreement(reviews: ReviewResult[]): boolean {
    if (reviews.length === 0) return false;
    if (reviews.some(r => r.overallVerdict !== 'APPROVE')) return true;
    for (const review of reviews) {
      const allScores = [
        review.scores.correctness?.score,
        review.scores.completeness?.score,
        review.scores.security?.score,
        review.scores.consistency?.score,
        review.scores.feasibility?.score,
      ].filter((s): s is number => s !== undefined);
      if (allScores.some(s => s === 1)) return true;
    }
    const verdicts = new Set(reviews.map(r => r.overallVerdict));
    if (verdicts.has('APPROVE') && verdicts.has('REJECT')) return true;
    return false;
  }

  // === Review History ===

  getReviewHistory(instanceId: string): AggregatedReview[] {
    return this.reviewHistory.get(instanceId) ?? [];
  }

  getReviewContext(reviewId: string): ReviewDispatchRequest | null {
    return this.reviewContexts.get(reviewId) ?? null;
  }

  private addToHistory(instanceId: string, review: AggregatedReview): void {
    let history = this.reviewHistory.get(instanceId);
    if (!history) {
      history = [];
      this.reviewHistory.set(instanceId, history);
    }
    history.push(review);
    if (history.length > MAX_REVIEW_HISTORY) {
      const removed = history.splice(0, history.length - MAX_REVIEW_HISTORY);
      for (const entry of removed) {
        this.reviewContexts.delete(entry.id);
      }
    }
  }

  // === Availability ===

  private async refreshAvailability(): Promise<void> {
    try {
      const detection = CliDetectionService.getInstance();
      const result = await detection.detectAll();
      const available = result.available.map(c => c.name);
      const settings = getSettingsManager().getAll();
      const configured = settings.crossModelReviewProviders as string[];
      const effectiveList = configured.length > 0
        ? configured.filter(p => available.includes(p))
        : available;
      this.reviewerPool.setAvailable(effectiveList);
    } catch (err) {
      logger.warn('CLI detection failed', { error: String(err) });
    }
  }

  getStatus(): CrossModelReviewStatus {
    const settings = getSettingsManager().getAll();
    return {
      enabled: settings.crossModelReviewEnabled,
      reviewers: this.reviewerPool.getStatus(),
      pendingReviews: this.pendingReviews.size,
    };
  }

  // === Cleanup ===

  cancelPendingReviews(instanceId: string): void {
    for (const [reviewId, instId] of this.pendingReviewInstances) {
      if (instId === instanceId) {
        const abort = this.pendingReviews.get(reviewId);
        if (abort) {
          abort.abort();
          this.pendingReviews.delete(reviewId);
        }
        this.pendingReviewInstances.delete(reviewId);
      }
    }
    this.clearBuffer(instanceId);
    this.reviewHistory.delete(instanceId);
    for (const [reviewId, context] of this.reviewContexts) {
      if (context.instanceId === instanceId) {
        this.reviewContexts.delete(reviewId);
      }
    }
  }

  shutdown(): void {
    if (this.rateLimitTimer) clearInterval(this.rateLimitTimer);
    this.rateLimitTimer = null;
    for (const abort of this.pendingReviews.values()) abort.abort();
    this.pendingReviews.clear();
    this.pendingReviewInstances.clear();
    this.buffers.clear();
    this.reviewHistory.clear();
    this.reviewContexts.clear();
    this.lastReviewTime.clear();
    this.removeAllListeners();
    this.initialized = false;
  }
}

export function getCrossModelReviewService(): CrossModelReviewService {
  return CrossModelReviewService.getInstance();
}
