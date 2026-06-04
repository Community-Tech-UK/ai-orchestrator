import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { registerCleanup } from '../util/cleanup-registry';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import type { InstanceManager } from '../instance/instance-manager';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import type { CliType as SettingsCliType } from '../../shared/types/settings.types';
import { CliDetectionService } from '../cli/cli-detection';
import { OutputClassifier } from './output-classifier';
import { ReviewerPool } from './reviewer-pool';
import {
  angleForReviewer,
  buildStructuredReviewPrompt,
  buildTieredReviewPrompt,
  truncateForReview,
} from './review-prompts';
import { aggregateReviewFindings, type AggregatableFinding } from './review-finding-aggregation';
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
import { reviewResultHasConcerns } from '../../shared/utils/cross-model-review-concerns';
import type { OutputBuffer, ReviewDispatchRequest } from './cross-model-review.types';
import type { HeadlessReviewFinding, HeadlessReviewResult, HeadlessReviewReviewer } from '../cli-entrypoints/review-command-output';
import { resolveReviewerModelOverride, type HeadlessReviewRequest, type ReviewExecutionHost } from '../review/review-execution-host';
import {
  MIN_COOLDOWN_MS,
  MAX_REVIEW_HISTORY,
  RATE_LIMIT_CHECK_INTERVAL_MS,
  AVAILABILITY_REFRESH_INTERVAL_MS,
  SUPPORTED_REVIEWER_CLIS,
} from './cross-model-review-service.constants';
import { extractJson } from './cross-model-review-service.helpers';

const logger = getLogger('CrossModelReviewService');

function isCliAdapterLike(adapter: unknown): adapter is { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as Record<string, unknown>)?.['sendMessage'] === 'function';
}

function isTerminableAdapter(adapter: unknown): adapter is { terminate: (graceful?: boolean) => Promise<void> } {
  return typeof (adapter as Record<string, unknown>)?.['terminate'] === 'function';
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
  private availabilityRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private instanceManager: InstanceManager | null = null;
  private reviewExecutionHost: ReviewExecutionHost | null = null;
  private isPaused = getPauseCoordinator().isPaused();
  private readonly handlePause = (): void => {
    this.isPaused = true;
    this.cancelAllPendingReviews('orchestrator paused');
  };
  private readonly handleResume = (): void => {
    this.isPaused = false;
  };

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
    const pauseCoordinator = getPauseCoordinator();
    pauseCoordinator.on('pause', this.handlePause);
    pauseCoordinator.on('resume', this.handleResume);
    registerCleanup(() => this.shutdown());
  }

  /**
   * Inject the InstanceManager. Main process startup calls this after
   * InstanceManager is constructed so this service can look up instances
   * without a global singleton accessor.
   */
  setInstanceManager(im: InstanceManager): void {
    this.instanceManager = im;
  }

  setReviewExecutionHost(host: ReviewExecutionHost): void {
    this.reviewExecutionHost = host;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.refreshAvailability();
    this.rateLimitTimer = setInterval(() => {
      this.reviewerPool.checkRateLimitRecovery();
      this.reviewerPool.checkAvailabilityRecovery();
    }, RATE_LIMIT_CHECK_INTERVAL_MS);
    this.availabilityRefreshTimer = setInterval(() => {
      void this.refreshAvailability();
    }, AVAILABILITY_REFRESH_INTERVAL_MS);
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
    if (this.isPaused || getPauseCoordinator().isPaused()) return;

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

    const instance = this.instanceManager?.getInstance(instanceId);
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
      [],
      settings.crossModelReviewProviders as string[],
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
    // Honour the user's configured reviewer order when picking fallbacks too,
    // so a failed active reviewer is replaced by the next one in priority order.
    const preferredOrder = getSettingsManager().getAll().crossModelReviewProviders as string[];

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
        preferredOrder,
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
        if (this.isPaused || getPauseCoordinator().isPaused()) throw new Error('Review skipped while orchestrator is paused');

        const resolvedCli = await resolveCliType(cliType as SettingsCliType);
        const reviewerModel = resolveReviewerModelOverride(cliType);
        const adapter = getProviderRuntimeService().createAdapter({
          cliType: resolvedCli,
          options: {
            workingDirectory: request.workingDirectory,
            timeout: timeoutSeconds * 1000,
            yoloMode: false,
            // When no override is configured, leave `model` unset so the
            // reviewer CLI uses its own default/auto routing.
            ...(reviewerModel ? { model: reviewerModel } : {}),
          },
        });

        try {
          if (!isCliAdapterLike(adapter)) {
            throw new Error(`CLI adapter "${cliType}" does not support sendMessage`);
          }

          if (signal.aborted || this.isPaused || getPauseCoordinator().isPaused()) {
            throw new Error('Review cancelled');
          }

          const prompt = request.reviewDepth === 'tiered'
            ? buildTieredReviewPrompt(request.taskDescription, request.content)
            : buildStructuredReviewPrompt(request.taskDescription, request.content);

          // sendMessage() does not currently expose a universal cancellation API
          // across reviewer adapters, so an already-running provider call may run
          // until its configured timeout even after the abort signal fires.
          return await adapter.sendMessage({ role: 'user', content: prompt });
        } finally {
          if (isTerminableAdapter(adapter)) {
            await adapter.terminate(false).catch((cleanupError: unknown) => {
              logger.warn('Review adapter cleanup failed', {
                cliType,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              });
            });
          }
        }
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

  async runHeadlessReview(request: HeadlessReviewRequest): Promise<HeadlessReviewResult> {
    const startedAt = new Date();
    const host = this.reviewExecutionHost;
    if (!host) {
      const completedAt = new Date();
      return {
        target: request.target,
        cwd: request.cwd,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        reviewers: [],
        findings: [],
        summary: 'Headless review host is not configured.',
        infrastructureErrors: ['Headless review host is not configured.'],
      };
    }

    const reviewers = await this.resolveHeadlessReviewers(request);
    if (reviewers.length === 0) {
      const completedAt = new Date();
      return {
        target: request.target,
        cwd: request.cwd,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        reviewers: [],
        findings: [],
        summary: 'No reviewers available for headless review.',
        infrastructureErrors: [],
      };
    }

    const abort = new AbortController();
    const timeoutMs = Math.max(1, request.timeoutSeconds ?? 60) * 1000;
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    const reviewerStatuses: HeadlessReviewReviewer[] = [];
    const successfulReviews: ReviewResult[] = [];

    // Bound the review payload. The fresh-eyes loop gate feeds the full
    // cumulative git diff here; on a long run that diff can be hundreds of KB,
    // which overflows the reviewer CLI's context window and makes it emit
    // truncated / non-JSON output ("Reviewer returned unparseable output").
    // The in-session review path already truncates (see executeReview); the
    // headless path must do the same so large diffs degrade to a bounded
    // review rather than a hard failure.
    const reviewContent = truncateForReview(request.content);

    try {
      const reviewDepth = request.reviewDepth ?? 'structured';

      // Give each reviewer a different angle (and different phrasing) so N
      // reviewers produce genuinely independent passes rather than N copies
      // of the same opinion. Reviewers still score every dimension.
      let reviewerIndex = 0;
      for (const reviewer of reviewers) {
        const angle = angleForReviewer(reviewerIndex++);
        const prompt = reviewDepth === 'tiered'
          ? buildTieredReviewPrompt(request.taskDescription, reviewContent, angle)
          : buildStructuredReviewPrompt(request.taskDescription, reviewContent, angle);
        try {
          const rawResponse = await host.dispatchReviewerPrompt(reviewer, prompt, request.cwd, abort.signal);
          const parsed = this.parseReviewResponse(reviewer, rawResponse, reviewDepth, 0);
          if (!parsed) {
            const len = rawResponse?.length ?? 0;
            reviewerStatuses.push({
              provider: reviewer,
              status: 'failed',
              reason: `Reviewer returned unparseable output (${len} chars; expected strict JSON)`,
            });
            continue;
          }
          successfulReviews.push(parsed);
          reviewerStatuses.push({ provider: reviewer, status: 'used' });
        } catch (error) {
          reviewerStatuses.push({
            provider: reviewer,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    // Dedup + aggregate findings across reviewers ("N/M reviewers flagged X").
    // With a single successful reviewer this is a pass-through (no merging,
    // no agreement prefix), so single-reviewer output is unchanged.
    const taggedFindings: AggregatableFinding[] = successfulReviews.flatMap((review) =>
      this.toHeadlessFindings(review).map((finding) => ({ ...finding, reviewer: review.reviewerId })),
    );
    const findings: HeadlessReviewFinding[] = aggregateReviewFindings(taggedFindings, {
      totalReviewers: successfulReviews.length,
    }).map((finding) => ({
      title: finding.title,
      body: finding.body,
      ...(finding.file ? { file: finding.file } : {}),
      ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
      severity: finding.severity,
      confidence: finding.confidence,
    }));
    const failedReasons = reviewerStatuses
      .filter((reviewer) => reviewer.status === 'failed' && reviewer.reason)
      .map((reviewer) => `${reviewer.provider}: ${reviewer.reason}`);
    const infrastructureErrors = successfulReviews.length === 0 ? failedReasons : [];
    const completedAt = new Date();

    return {
      target: request.target,
      cwd: request.cwd,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      reviewers: reviewerStatuses,
      findings,
      summary: this.summarizeHeadlessReview(successfulReviews.length, findings.length, infrastructureErrors.length),
      infrastructureErrors,
    };
  }

  private async resolveHeadlessReviewers(request: HeadlessReviewRequest): Promise<string[]> {
    if (request.reviewers) {
      return request.reviewers;
    }

    await this.refreshAvailability();
    const settings = getSettingsManager().getAll();
    return this.reviewerPool.selectReviewers(
      request.primaryProvider ?? 'claude',
      settings.crossModelReviewMaxReviewers,
      [],
      settings.crossModelReviewProviders as string[],
    );
  }

  private toHeadlessFindings(review: ReviewResult): HeadlessReviewFinding[] {
    const findings: HeadlessReviewFinding[] = [];
    for (const issue of review.criticalIssues ?? []) {
      findings.push({
        title: `${review.reviewerId} critical issue`,
        body: issue,
        severity: 'high',
        confidence: 0.9,
      });
    }

    for (const [dimension, score] of Object.entries(review.scores)) {
      if (!score || score.issues.length === 0) {
        continue;
      }
      for (const issue of score.issues) {
        findings.push({
          title: `${review.reviewerId} ${dimension} concern`,
          body: issue,
          severity: this.severityForScore(dimension, score.score),
          confidence: Math.max(0.1, Math.min(1, (5 - score.score) / 4)),
        });
      }
    }

    if (findings.length === 0 && review.overallVerdict !== 'APPROVE') {
      findings.push({
        title: `${review.reviewerId} ${review.overallVerdict.toLowerCase()} verdict`,
        body: review.summary,
        severity: review.overallVerdict === 'REJECT' ? 'high' : 'medium',
        confidence: 0.7,
      });
    }

    return findings;
  }

  private severityForScore(dimension: string, score: number): HeadlessReviewFinding['severity'] {
    if (score <= 1) return dimension === 'security' ? 'critical' : 'high';
    if (score <= 2) return dimension === 'security' ? 'high' : 'medium';
    return 'low';
  }

  private summarizeHeadlessReview(successfulReviewers: number, findingCount: number, infrastructureErrorCount: number): string {
    if (infrastructureErrorCount > 0 && successfulReviewers === 0) {
      return 'Headless review failed before any reviewer completed.';
    }
    if (findingCount === 0) {
      return `No findings from ${successfulReviewers} reviewer(s).`;
    }
    return `${findingCount} finding(s) from ${successfulReviewers} reviewer(s).`;
  }

  // === Response Parsing ===

  private parseReviewResponse(reviewerId: string, rawResponse: string, reviewDepth: 'structured' | 'tiered', durationMs: number): ReviewResult | null {
    const baseResult: Partial<ReviewResult> = {
      reviewerId,
      reviewType: reviewDepth,
      timestamp: Date.now(),
      durationMs,
    };

    const parsed = extractJson(rawResponse);

    if (!parsed) {
      logger.warn('Failed to extract JSON from review response', {
        reviewerId,
        responseLength: rawResponse.length,
        responsePreview: rawResponse.slice(0, 400),
      });
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
    return reviews.some(reviewResultHasConcerns);
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
      const available = result.available
        .map(c => c.name)
        .filter(cliType => SUPPORTED_REVIEWER_CLIS.has(cliType));
      const settings = getSettingsManager().getAll();
      const configured = (settings.crossModelReviewProviders as string[])
        .filter(cliType => SUPPORTED_REVIEWER_CLIS.has(cliType));
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
    if (this.availabilityRefreshTimer) clearInterval(this.availabilityRefreshTimer);
    this.availabilityRefreshTimer = null;
    for (const abort of this.pendingReviews.values()) abort.abort();
    this.pendingReviews.clear();
    this.pendingReviewInstances.clear();
    this.buffers.clear();
    this.reviewHistory.clear();
    this.reviewContexts.clear();
    this.lastReviewTime.clear();
    const pauseCoordinator = getPauseCoordinator();
    pauseCoordinator.removeListener('pause', this.handlePause);
    pauseCoordinator.removeListener('resume', this.handleResume);
    this.removeAllListeners();
    this.initialized = false;
  }

  private cancelAllPendingReviews(reason: string): void {
    for (const abort of this.pendingReviews.values()) abort.abort();
    this.pendingReviews.clear();
    this.pendingReviewInstances.clear();
    logger.info('Cancelled pending cross-model reviews', { reason });
  }
}

export function getCrossModelReviewService(): CrossModelReviewService {
  return CrossModelReviewService.getInstance();
}
