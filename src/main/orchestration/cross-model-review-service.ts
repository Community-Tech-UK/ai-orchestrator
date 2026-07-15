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
  buildReviewFormatRepairPrompt,
  buildStructuredReviewPrompt,
  buildTieredReviewPrompt,
  truncateForReview,
} from './review-prompts';
import { combineAbortSignals } from '../util/abort-signals';
import type {
  AggregatedReview,
  ReviewOutputType,
  ReviewResult,
  CrossModelReviewStatus,
} from '../../shared/types/cross-model-review.types';
import { reviewResultHasConcerns } from '../../shared/utils/cross-model-review-concerns';
import type { OutputBuffer, ReviewDispatchRequest } from './cross-model-review.types';
import {
  resolveReviewerModelOverride,
  sendAbortableReviewerMessage,
  type HeadlessReviewRequest,
  type ReviewExecutionHost,
} from '../review/review-execution-host';
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
import { isLikelyReviewRefusal, parseCrossModelReviewResponse } from './review-response-parser';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { resolveAntigravityReviewModelPlan } from './antigravity-review-model-routing';
import { redactForEgress } from '../security/content-egress-gate';
import { runHeadlessReviewCommand } from './headless-review-runner';
const logger = getLogger('CrossModelReviewService');

// Codex and Antigravity both run noticeably slower than other reviewer CLIs
// and have been observed cutting reviews off at the configured timeout before
// they can finish (Antigravity's observed cutoff was 120s). Both get the same
// floor; every other reviewer keeps the user-configured timeout as-is.
const REVIEWER_TIMEOUT_FLOOR_MS: Readonly<Record<string, number>> = {
  codex: 300_000,
  antigravity: 300_000,
};

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
  const floorMs = REVIEWER_TIMEOUT_FLOOR_MS[cliType];
  return floorMs ? Math.max(configuredMs, floorMs) : configuredMs;
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
      content: redactForEgress(truncateForReview(aggregatedContent), {
        kind: 'prompt',
        instanceId,
      }).content,
      taskDescription: redactForEgress(
        firstUserPrompt || buffer.firstUserPrompt || instance?.displayName || 'No task description available',
        { kind: 'prompt', instanceId },
      ).content,
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
      const aggregated: AggregatedReview = {
        id: request.id,
        instanceId: request.instanceId,
        outputType: request.classification.type as ReviewOutputType,
        reviewDepth: request.reviewDepth,
        reviews: successfulResults,
        localReviewer: localParticipant,
        hasDisagreement: this.detectDisagreement(batch.remoteReviews),
        timestamp: Date.now(),
      };

      if (successfulResults.length === 0) {
        // Nothing was actually reviewed. Only surface a panel when the local
        // reviewer genuinely *failed* — worth flagging that the safety net
        // errored. A *skipped* local reviewer (or local review disabled) means
        // nothing ran at all, so route it to the quiet "all unavailable" state
        // instead of showing an empty "advisory only" review with no findings.
        if (settings.crossModelReviewLocalEnabled && localParticipant.status === 'failed') {
          this.addToHistory(request.instanceId, aggregated);
          this.emit('review:result', aggregated);
        } else {
          this.reviewContexts.delete(request.id);
          this.emit('review:all-unavailable', { instanceId: request.instanceId });
        }
        return;
      }

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

    // Codex and Antigravity are slow: a tiered review at default effort blows
    // the per-review deadline because the configured `timeout` is the
    // adapter's absolute total process budget. Force structured depth + low
    // reasoning effort for codex only, and give both a provider-specific
    // timeout floor; other reviewers keep the configured depth and timeout.
    // Declared in the outer scope so the parse below uses the same depth the
    // adapter was prompted with.
    const isCodex = reviewerCli === 'codex';
    const effectiveDepth: 'structured' | 'tiered' = isCodex ? 'structured' : request.reviewDepth;
    const timeoutMs = resolveReviewerTimeoutMs(reviewerCli, timeoutSeconds);

    // One operation deadline covers the initial send and its single
    // format-repair retry, so a hanging repair can't buy the reviewer a
    // second full timeout window. `deadlineExceeded` distinguishes this from
    // an upstream cancellation in the catch block below — both reject through
    // the same combined signal with the same "Review cancelled" message.
    const deadlineController = new AbortController();
    let deadlineExceeded = false;
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      deadlineController.abort();
    }, timeoutMs);
    const operationSignal = combineAbortSignals([signal, deadlineController.signal]);

    try {
      const outcome = await breaker.execute(async () => {
        if (operationSignal.aborted) throw new Error('Review cancelled');
        if (this.isPaused || getPauseCoordinator().isPaused()) throw new Error('Review skipped while orchestrator is paused');

        const resolvedCli = await resolveCliType(reviewerCli as SettingsCliType);
        const configuredModel = resolveReviewerModelOverride(reviewerCli);
        const reviewerModels = reviewerCli === 'antigravity'
          ? resolveAntigravityReviewModelPlan(
              configuredModel,
              getProviderQuotaService().getSnapshot('antigravity'),
            )
          : [configuredModel];

        for (const [modelIndex, reviewerModel] of reviewerModels.entries()) {
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

          let cancelled = false;
          try {
            if (!isCliAdapterLike(adapter)) {
              throw new Error(`CLI adapter "${reviewerCli}" does not support sendMessage`);
            }

            if (operationSignal.aborted || this.isPaused || getPauseCoordinator().isPaused()) {
              throw new Error('Review cancelled');
            }

            const prompt = effectiveDepth === 'tiered'
              ? buildTieredReviewPrompt(request.taskDescription, request.content)
              : buildStructuredReviewPrompt(request.taskDescription, request.content);

            const initialResponse = await sendAbortableReviewerMessage(
              adapter,
              { role: 'user', content: prompt },
              operationSignal,
              () => { cancelled = true; },
            );

            const initialParsed = this.parseReviewResponse(reviewerCli, initialResponse.content, effectiveDepth, Date.now() - startTime);
            if (initialParsed) return { result: initialParsed, repaired: false };

            if (isLikelyReviewRefusal(initialResponse.content)) {
              logger.warn('Reviewer refused the review request', { cliType: reviewerCli, reviewId: request.id, model: reviewerModel });
            } else {
              logger.info('Reviewer response failed validation — attempting one format-repair retry', {
                cliType: reviewerCli,
                reviewId: request.id,
                model: reviewerModel,
              });
              const repairResponse = await sendAbortableReviewerMessage(
                adapter,
                { role: 'user', content: buildReviewFormatRepairPrompt(effectiveDepth, initialResponse.content) },
                operationSignal,
                () => { cancelled = true; },
              );
              const repairedParsed = this.parseReviewResponse(reviewerCli, repairResponse.content, effectiveDepth, Date.now() - startTime);
              if (repairedParsed) return { result: repairedParsed, repaired: true };
              logger.warn('Reviewer format-repair response also failed validation', {
                cliType: reviewerCli,
                reviewId: request.id,
                model: reviewerModel,
              });
            }

            if (modelIndex < reviewerModels.length - 1) {
              logger.info('Retrying Antigravity review with fallback model', {
                reviewId: request.id,
                fromModel: reviewerModel,
                toModel: reviewerModels[modelIndex + 1],
              });
            }
          } finally {
            if (!cancelled && isTerminableAdapter(adapter)) {
              await adapter.terminate(false).catch((cleanupError: unknown) => {
                logger.warn('Review adapter cleanup failed', {
                  cliType: reviewerCli,
                  error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
              });
            }
          }
        }
        return { result: null, repaired: false };
      });

      if (!outcome.result) {
        logger.warn('Skipping unparseable reviewer response', { cliType: reviewerCli, reviewId: request.id });
        return null;
      }

      this.reviewerPool.recordSuccess(reviewerCli);
      logger.info('Review completed', {
        cliType: reviewerCli,
        reviewId: request.id,
        durationMs: Date.now() - startTime,
        repaired: outcome.repaired,
      });
      return outcome.result;
    } catch (err) {
      if (deadlineExceeded) {
        this.reviewerPool.recordFailure(reviewerCli);
        logger.warn('Review exceeded its operation deadline', { cliType: reviewerCli, reviewId: request.id, timeoutMs });
        throw new Error(`Reviewer "${reviewerCli}" exceeded its ${timeoutMs}ms review deadline`);
      }
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
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async runHeadlessReview(request: HeadlessReviewRequest) {
    const settings = getSettingsManager().getAll();
    return runHeadlessReviewCommand(request, {
      host: this.reviewExecutionHost,
      resolveReviewers: (headlessRequest) => this.resolveHeadlessReviewers(headlessRequest),
      localEnabled: settings.crossModelReviewLocalEnabled === true,
      createLocalPlan: ({ workspaceRoot, taskDescription, content, reviewDepth, signal }) =>
        createLocalReviewExecutionPlan({
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
          request: { workspaceRoot, taskDescription, content, reviewDepth },
          signal,
        }),
    });
  }

  private async resolveHeadlessReviewers(request: HeadlessReviewRequest): Promise<string[]> {
    if (request.reviewers) {
      const primaryProvider = normalizeReviewerCli(request.primaryProvider ?? 'claude');
      return normalizeAgenticReviewerCliList(request.reviewers)
        .filter((reviewer) => reviewer !== primaryProvider);
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
