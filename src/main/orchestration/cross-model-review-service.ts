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
import type {
  AggregatedReview,
  ReviewOutputType,
  ReviewResult,
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
  normalizeAgenticReviewerCliList,
  normalizeReviewerCli,
  normalizeReviewerCliList,
  isReviewerRateLimitError,
} from './cross-model-review-service.constants';
import { resolveReviewWorkingDirectory } from './cross-model-review-service.helpers';
import { getLocalModelInventoryService } from '../local-models/local-model-inventory-service';
import { LocalReviewer } from '../review/local-reviewer';
import {
  createLocalReviewExecutionPlan,
  runReviewExecutionBatch,
} from './review-execution-batch';
import { parseCrossModelReviewResponse } from './review-response-parser';
import { summarizeHeadlessReview, toHeadlessFindings } from './headless-review-findings';
const logger = getLogger('CrossModelReviewService');
const CODEX_REVIEW_MIN_TIMEOUT_MS = 300_000;

function isCliAdapterLike(adapter: unknown): adapter is { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as Record<string, unknown>)?.['sendMessage'] === 'function';
}

function isTerminableAdapter(adapter: unknown): adapter is { terminate: (graceful?: boolean) => Promise<void> } {
  return typeof (adapter as Record<string, unknown>)?.['terminate'] === 'function';
}

function resolveReviewerTimeoutMs(cliType: string, timeoutSeconds: number): number {
  const configuredSeconds = Number.isFinite(timeoutSeconds)
    ? Math.max(1, Math.floor(timeoutSeconds))
    : 30;
  const configuredMs = configuredSeconds * 1000;
  return cliType === 'codex'
    ? Math.max(configuredMs, CODEX_REVIEW_MIN_TIMEOUT_MS)
    : configuredMs;
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
  // Dedupes configured-but-unavailable warnings/events across refreshes.
  private lastUnavailableKey = '';
  // Retained for renderer badge rehydration through getStatus().
  private unavailableReviewers: { cli: string; error?: string }[] = [];
  private initialized = false;
  private instanceManager: InstanceManager | null = null;
  private reviewExecutionHost: ReviewExecutionHost | null = null;
  private localReviewer: Pick<LocalReviewer, 'review'> = new LocalReviewer();
  private localModelInventory: Pick<ReturnType<typeof getLocalModelInventoryService>, 'list'> &
    Partial<Pick<ReturnType<typeof getLocalModelInventoryService>, 'resolveTarget'>> =
    getLocalModelInventoryService();
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

  setLocalReviewDependenciesForTesting(
    reviewer: Pick<LocalReviewer, 'review'>,
    inventory: Pick<ReturnType<typeof getLocalModelInventoryService>, 'list'>,
  ): void {
    this.localReviewer = reviewer;
    this.localModelInventory = inventory;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.refreshAvailability();
    this.rateLimitTimer = setInterval(() => {
      const cleared = this.reviewerPool.checkRateLimitRecovery();
      for (const cliType of cleared) {
        // Let the UI drop the "rate-limited" badge once the cooldown elapses.
        this.emit('review:reviewer-rate-limit-cleared', { cliType });
      }
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

    // Remote instances run on another machine — their files do not exist
    // locally. A local reviewer CLI would spawn with the remote machine's
    // working directory (crash: `spawn <cli> ENOENT`) and, even with a
    // fallback cwd, review without file context. Skip; routing reviews to
    // the owning node is a separate feature.
    if (instance?.executionLocation?.type === 'remote') {
      logger.info('Skipping cross-model review for remote instance', {
        instanceId,
        nodeId: instance.executionLocation.nodeId,
      });
      return;
    }

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
    const preferredReviewers = normalizeReviewerCliList(settings.crossModelReviewProviders as string[]);
    const selectedReviewers = this.reviewerPool.selectReviewers(
      normalizeReviewerCli(buffer.primaryProvider),
      settings.crossModelReviewMaxReviewers,
      [],
      preferredReviewers,
    );

    // Record who actually ran vs. what was configured, so a top-priority
    // reviewer quietly falling through to a fallback is visible per cycle.
    logger.info('Cross-model review reviewers selected', {
      instanceId,
      selected: selectedReviewers,
      configured: preferredReviewers,
    });

    const reviewId = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.lastReviewTime.set(instanceId, Date.now());
    this.emit('review:started', { instanceId, reviewId });

    const request: ReviewDispatchRequest = {
      id: reviewId,
      instanceId,
      primaryProvider: buffer.primaryProvider,
      ...(instance?.modelRuntimeTarget
        ? { builderModelRuntimeTarget: instance.modelRuntimeTarget }
        : {}),
      workingDirectory: resolveReviewWorkingDirectory(instance?.workingDirectory),
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
      const settings = getSettingsManager().getAll();
      const localPlan = createLocalReviewExecutionPlan({
        enabled: settings.crossModelReviewLocalEnabled,
        selectorId: settings.crossModelReviewLocalSelectorId,
        auxiliaryQualityModel: settings.auxiliaryLlmQualityModel,
        timeoutSeconds: settings.crossModelReviewLocalTimeout,
        maxToolRounds: settings.crossModelReviewLocalMaxToolRounds,
        inventory: settings.crossModelReviewLocalEnabled ? this.localModelInventory.list() : [],
        ...(this.localModelInventory.resolveTarget
          ? { resolveTarget: (selectorId: string) => this.localModelInventory.resolveTarget!(selectorId) }
          : {}),
        reviewer: this.localReviewer,
        request: {
          workspaceRoot: request.workingDirectory,
          taskDescription: request.taskDescription,
          content: request.content,
          reviewDepth: request.reviewDepth,
        },
        ...(request.builderModelRuntimeTarget?.kind === 'local-model'
          ? { builderSelectorId: request.builderModelRuntimeTarget.selectorId }
          : {}),
        signal: abort.signal,
      });
      const batch = await runReviewExecutionBatch({
        collectRemoteReviews: () => this.collectSuccessfulReviews(
          request,
          reviewerClis,
          timeoutSeconds,
          abort.signal,
        ),
        runLocalReview: localPlan.run,
      });
      if (batch.remoteError) logger.warn('Remote review collection failed', { error: batch.remoteError });
      const localParticipant = localPlan.participant(batch.localOutcome);
      const localReview = batch.localOutcome.status === 'used'
        ? [{ ...batch.localOutcome.review, source: 'local' as const }]
        : [];
      const successfulResults = [...batch.remoteReviews, ...localReview];

      if (successfulResults.length === 0) {
        this.reviewContexts.delete(request.id);
        this.emit('review:all-unavailable', { instanceId: request.instanceId });
        return;
      }

      const hasDisagreement = this.detectDisagreement(batch.remoteReviews);

      const aggregated: AggregatedReview = {
        id: request.id,
        instanceId: request.instanceId,
        outputType: request.classification.type as ReviewOutputType,
        reviewDepth: request.reviewDepth,
        reviews: successfulResults,
        localReviewer: localParticipant,
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
    let candidates = normalizeAgenticReviewerCliList(reviewerClis);
    const desiredCount = candidates.length;
    // Honour the user's configured reviewer order when picking fallbacks too,
    // so a failed active reviewer is replaced by the next one in priority order.
    const preferredOrder = normalizeReviewerCliList(getSettingsManager().getAll().crossModelReviewProviders as string[]);

    while (candidates.length > 0 && successful.length < desiredCount) {
      for (const cliType of candidates) attempted.add(normalizeReviewerCli(cliType));

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
        normalizeReviewerCli(request.primaryProvider),
        remaining,
        Array.from(attempted),
        preferredOrder,
      );
    }

    return successful;
  }

  private async executeOneReview(request: ReviewDispatchRequest, cliType: string, timeoutSeconds: number, signal: AbortSignal): Promise<ReviewResult | null> {
    const startTime = Date.now();
    const reviewerCli = normalizeReviewerCli(cliType);
    const breaker = getCircuitBreakerRegistry().getBreaker(`cross-review-${reviewerCli}`, {
      failureThreshold: 3,
      resetTimeoutMs: 60000,
    });

    // Codex is slow: a tiered review at default effort blows the per-review
    // deadline because the configured `timeout` is codex's absolute total
    // process budget. Force structured depth + low reasoning effort for codex
    // only, and give it a codex-specific timeout floor; other reviewers keep
    // the configured depth and timeout. Declared in the outer scope so the
    // parse below uses the same depth the adapter was prompted with.
    const isCodex = reviewerCli === 'codex';
    const effectiveDepth: 'structured' | 'tiered' = isCodex ? 'structured' : request.reviewDepth;
    const timeoutMs = resolveReviewerTimeoutMs(reviewerCli, timeoutSeconds);

    try {
      const response = await breaker.execute(async () => {
        if (signal.aborted) throw new Error('Review cancelled');
        if (this.isPaused || getPauseCoordinator().isPaused()) throw new Error('Review skipped while orchestrator is paused');

        const resolvedCli = await resolveCliType(reviewerCli as SettingsCliType);
        const reviewerModel = resolveReviewerModelOverride(reviewerCli);
        const adapter = getProviderRuntimeService().createAdapter({
          cliType: resolvedCli,
          options: {
            workingDirectory: request.workingDirectory,
            timeout: timeoutMs,
            yoloMode: false,
            ...(isCodex ? { reasoningEffort: 'low' as const } : {}),
            // When no override is configured, leave `model` unset so the
            // reviewer CLI uses its own default/auto routing.
            ...(reviewerModel ? { model: reviewerModel } : {}),
          },
        });

        try {
          if (!isCliAdapterLike(adapter)) {
            throw new Error(`CLI adapter "${reviewerCli}" does not support sendMessage`);
          }

          if (signal.aborted || this.isPaused || getPauseCoordinator().isPaused()) {
            throw new Error('Review cancelled');
          }

          const prompt = effectiveDepth === 'tiered'
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
                cliType: reviewerCli,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              });
            });
          }
        }
      });

      const parsed = this.parseReviewResponse(reviewerCli, response.content, effectiveDepth, Date.now() - startTime);
      if (!parsed) {
        logger.warn('Skipping unparseable reviewer response', { cliType: reviewerCli, reviewId: request.id });
        return null;
      }

      this.reviewerPool.recordSuccess(reviewerCli);
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isReviewerRateLimitError(message)) {
        this.reviewerPool.markRateLimited(reviewerCli);
        // Surface it: a rate-limited/quota-capped reviewer is silently skipped
        // by selectReviewers, so without this the only trace is app.log. Lets
        // the UI show when a subscription reviewer (e.g. Grok Build) hits its cap.
        this.emit('review:reviewer-rate-limited', {
          instanceId: request.instanceId,
          reviewId: request.id,
          cliType: reviewerCli,
        });
      } else {
        this.reviewerPool.recordFailure(reviewerCli);
      }
      logger.warn('Review failed', { cliType: reviewerCli, error: message });
      throw err;
    }
  }

  async runHeadlessReview(request: HeadlessReviewRequest): Promise<HeadlessReviewResult> {
    const startedAt = new Date();
    // The cwd comes from the caller (CLI entrypoint / loop gate) — validate it
    // like the in-session path does so a stale/foreign path degrades to a
    // bounded review instead of a `spawn <cli> ENOENT` crash. No remote check
    // here: headless reviews have no instance concept.
    const cwd = resolveReviewWorkingDirectory(request.cwd);
    const host = this.reviewExecutionHost;
    const reviewers = await this.resolveHeadlessReviewers(request);

    const abort = new AbortController();
    const externalSignal = request.signal;
    const abortFromExternal = (): void => abort.abort(externalSignal?.reason);
    const timeoutMs = Math.max(1, request.timeoutSeconds ?? 60) * 1000;
    const reviewerStatuses: HeadlessReviewReviewer[] = [];

    // Bound the review payload. The fresh-eyes loop gate feeds the full
    // cumulative git diff here; on a long run that diff can be hundreds of KB,
    // which overflows the reviewer CLI's context window and makes it emit
    // truncated / non-JSON output ("Reviewer returned unparseable output").
    // The in-session review path already truncates (see executeReview); the
    // headless path must do the same so large diffs degrade to a bounded
    // review rather than a hard failure.
    const reviewContent = truncateForReview(request.content);
    const reviewDepth = request.reviewDepth ?? 'structured';
    const settings = getSettingsManager().getAll();
    const localPlan = createLocalReviewExecutionPlan({
      enabled: settings.crossModelReviewLocalEnabled,
      selectorId: settings.crossModelReviewLocalSelectorId ?? '',
      auxiliaryQualityModel: settings.auxiliaryLlmQualityModel ?? '',
      timeoutSeconds: settings.crossModelReviewLocalTimeout ?? 120,
      maxToolRounds: settings.crossModelReviewLocalMaxToolRounds ?? 12,
      inventory: settings.crossModelReviewLocalEnabled ? this.localModelInventory.list() : [],
      ...(this.localModelInventory.resolveTarget
        ? { resolveTarget: (selectorId: string) => this.localModelInventory.resolveTarget!(selectorId) }
        : {}),
      reviewer: this.localReviewer,
      request: {
        workspaceRoot: cwd,
        taskDescription: request.taskDescription,
        content: reviewContent,
        reviewDepth,
      },
      signal: abort.signal,
    });
    if (externalSignal?.aborted) {
      abortFromExternal();
    } else {
      externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    }
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    let batch: Awaited<ReturnType<typeof runReviewExecutionBatch>>;
    try {
      batch = await runReviewExecutionBatch({
        collectRemoteReviews: async () => {
          if (reviewers.length === 0) return [];
          if (!host) throw new Error('Headless review host is not configured.');
          const successful: ReviewResult[] = [];
          let reviewerIndex = 0;
          for (const reviewer of reviewers) {
            const angle = angleForReviewer(reviewerIndex++);
            const prompt = reviewDepth === 'tiered'
              ? buildTieredReviewPrompt(request.taskDescription, reviewContent, angle)
              : buildStructuredReviewPrompt(request.taskDescription, reviewContent, angle);
            try {
              const rawResponse = await host.dispatchReviewerPrompt(reviewer, prompt, cwd, abort.signal);
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
              successful.push(parsed);
              reviewerStatuses.push({ provider: reviewer, status: 'used' });
            } catch (error) {
              reviewerStatuses.push({
                provider: reviewer,
                status: 'failed',
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return successful;
        },
        runLocalReview: localPlan.run,
      });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }

    const localParticipant = localPlan.participant(batch.localOutcome);
    if (settings.crossModelReviewLocalEnabled === true) {
      reviewerStatuses.push({
        provider: 'local-model',
        source: 'local',
        status: localParticipant.status,
        ...(localParticipant.model ? { model: localParticipant.model } : {}),
        ...(localParticipant.selectorId ? { selectorId: localParticipant.selectorId } : {}),
        ...(localParticipant.reason ? { reason: localParticipant.reason } : {}),
      });
    }
    const localReviews = batch.localOutcome.status === 'used'
      ? [{ ...batch.localOutcome.review, source: 'local' as const }]
      : [];
    const successfulReviews = [...batch.remoteReviews, ...localReviews];

    // Dedup + aggregate findings across reviewers ("N/M reviewers flagged X").
    const taggedFindings: AggregatableFinding[] = successfulReviews.flatMap((review) =>
      toHeadlessFindings(review).map((finding) => ({
        ...finding,
        reviewer: review.reviewerId,
        source: review.source === 'local' ? 'local' : 'remote',
      })),
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
      reviewers: finding.reviewers,
      agreementCount: finding.agreementCount,
      advisory: finding.advisory,
    }));
    const failedReasons = reviewerStatuses
      .filter((reviewer) => reviewer.source !== 'local' && reviewer.status === 'failed' && reviewer.reason)
      .map((reviewer) => `${reviewer.provider}: ${reviewer.reason}`);
    const localFailureReasons = reviewerStatuses
      .filter((reviewer) => reviewer.source === 'local' && reviewer.status === 'failed' && reviewer.reason)
      .map((reviewer) => `${reviewer.provider}: ${reviewer.reason}`);
    if (batch.remoteError) failedReasons.push(`remote: ${batch.remoteError}`);
    const infrastructureErrors = batch.remoteReviews.length === 0 &&
      (reviewers.length > 0 || batch.localOutcome.status === 'used' || batch.localOutcome.status === 'failed')
      ? [
        ...failedReasons,
        ...localFailureReasons,
        ...(failedReasons.length === 0 ? ['No remote reviewers completed.'] : []),
      ]
      : [];
    const completedAt = new Date();
    const noReviewers = reviewers.length === 0 && batch.localOutcome.status === 'skipped';

    return {
      target: request.target,
      cwd,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      reviewers: reviewerStatuses,
      findings,
      summary: noReviewers
        ? 'No reviewers available for headless review.'
        : summarizeHeadlessReview(successfulReviews.length, findings.length, infrastructureErrors.length),
      infrastructureErrors,
    };
  }

  private async resolveHeadlessReviewers(request: HeadlessReviewRequest): Promise<string[]> {
    if (request.reviewers) {
      return normalizeAgenticReviewerCliList(request.reviewers);
    }

    await this.refreshAvailability();
    const settings = getSettingsManager().getAll();
    const preferredReviewers = normalizeReviewerCliList(settings.crossModelReviewProviders as string[]);
    return this.reviewerPool.selectReviewers(
      normalizeReviewerCli(request.primaryProvider ?? 'claude'),
      settings.crossModelReviewMaxReviewers,
      [],
      preferredReviewers,
    );
  }

  // === Response Parsing ===

  private parseReviewResponse(reviewerId: string, rawResponse: string, reviewDepth: 'structured' | 'tiered', durationMs: number): ReviewResult | null {
    return parseCrossModelReviewResponse(reviewerId, rawResponse, reviewDepth, durationMs);
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
      const available = normalizeReviewerCliList(result.available.map(c => c.name));
      const settings = getSettingsManager().getAll();
      const configured = normalizeReviewerCliList(settings.crossModelReviewProviders as string[]);
      const effectiveList = configured.length > 0
        ? configured.filter(p => available.includes(p))
        : available;

      // Surface configured reviewers that detection could not find. Without this
      // a top-priority reviewer (e.g. antigravity) silently drops out of the
      // pool and its slot is handed to the next available CLI (e.g. copilot)
      // with no trace — the exact failure where copilot burned usage while
      // antigravity showed zero. Deduped by the dropped set so we only warn/emit
      // when the set changes, not on every refresh.
      if (configured.length > 0) {
        const dropped = configured.filter(p => !available.includes(p));
        const detected = result.detected ?? [];
        const detail = dropped.map(name => {
          const info = detected.find(d => normalizeReviewerCli(d.name) === name);
          return { cli: name, error: info?.error ?? 'not detected on PATH' };
        });
        // Keep the snapshot current every refresh (used by getStatus rehydration),
        // even when the set is unchanged and we skip the emit below.
        this.unavailableReviewers = detail;
        const key = dropped.slice().sort().join(',');
        if (key !== this.lastUnavailableKey) {
          this.lastUnavailableKey = key;
          if (dropped.length > 0) {
            logger.warn('Configured cross-model reviewer(s) unavailable — excluded from pool', {
              dropped,
              available,
              detail,
            });
          }
          // Emit even when the set is now empty so the UI clears stale badges
          // once a reviewer (e.g. agy after a PATH fix) comes back.
          this.emit('review:reviewer-unavailable', { dropped: detail });
        }
      } else {
        // No configured reviewers → nothing can be "dropped"; reset so re-adding
        // reviewers later re-emits instead of being deduped against a stale key.
        this.unavailableReviewers = [];
        this.lastUnavailableKey = '';
      }

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
      unavailableReviewers: this.unavailableReviewers,
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
