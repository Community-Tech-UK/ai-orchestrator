"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrossModelReviewService = void 0;
exports.getCrossModelReviewService = getCrossModelReviewService;
const events_1 = require("events");
const logger_1 = require("../logging/logger");
const settings_manager_1 = require("../core/config/settings-manager");
const circuit_breaker_1 = require("../core/circuit-breaker");
const adapter_factory_1 = require("../cli/adapters/adapter-factory");
const cli_detection_1 = require("../cli/cli-detection");
const output_classifier_1 = require("./output-classifier");
const reviewer_pool_1 = require("./reviewer-pool");
const review_prompts_1 = require("./review-prompts");
const cross_model_review_schemas_1 = require("../../shared/validation/cross-model-review-schemas");
const logger = (0, logger_1.getLogger)('CrossModelReviewService');
const MIN_COOLDOWN_MS = 10_000;
const MAX_REVIEW_HISTORY = 50;
const RATE_LIMIT_CHECK_INTERVAL_MS = 30_000;
const AVAILABILITY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
function isCliAdapterLike(adapter) {
    return typeof adapter?.['sendMessage'] === 'function';
}
class CrossModelReviewService extends events_1.EventEmitter {
    static instance = null;
    classifier = new output_classifier_1.OutputClassifier();
    reviewerPool = new reviewer_pool_1.ReviewerPool();
    buffers = new Map();
    lastReviewTime = new Map();
    reviewHistory = new Map();
    pendingReviews = new Map();
    pendingReviewInstances = new Map();
    rateLimitTimer = null;
    availabilityTimer = null;
    initialized = false;
    static getInstance() {
        if (!this.instance) {
            this.instance = new CrossModelReviewService();
        }
        return this.instance;
    }
    static _resetForTesting() {
        if (this.instance) {
            this.instance.shutdown();
            this.instance = null;
        }
    }
    constructor() {
        super();
    }
    async initialize() {
        if (this.initialized)
            return;
        this.initialized = true;
        await this.refreshAvailability();
        this.rateLimitTimer = setInterval(() => {
            this.reviewerPool.checkRateLimitRecovery();
        }, RATE_LIMIT_CHECK_INTERVAL_MS);
        this.availabilityTimer = setInterval(() => {
            this.refreshAvailability().catch(err => logger.warn('Availability refresh failed', { error: String(err) }));
        }, AVAILABILITY_CHECK_INTERVAL_MS);
        logger.info('CrossModelReviewService initialized', {
            reviewers: this.reviewerPool.getStatus(),
        });
    }
    // === Message Buffering ===
    bufferMessage(instanceId, messageType, content, primaryProvider = 'claude', firstUserPrompt = '') {
        if (messageType !== 'assistant')
            return;
        let buffer = this.buffers.get(instanceId);
        if (!buffer) {
            buffer = { instanceId, messages: [], primaryProvider, firstUserPrompt, lastUpdated: Date.now() };
            this.buffers.set(instanceId, buffer);
        }
        buffer.messages.push(content);
        buffer.lastUpdated = Date.now();
    }
    getBufferSize(instanceId) {
        return this.buffers.get(instanceId)?.messages.length ?? 0;
    }
    clearBuffer(instanceId) {
        this.buffers.delete(instanceId);
    }
    // === Trigger (called when instance goes idle) ===
    async onInstanceIdle(instanceId) {
        const settings = (0, settings_manager_1.getSettingsManager)().getAll();
        if (!settings.crossModelReviewEnabled)
            return;
        const buffer = this.buffers.get(instanceId);
        if (!buffer || buffer.messages.length === 0)
            return;
        const aggregatedContent = buffer.messages.join('\n\n');
        this.buffers.delete(instanceId);
        if (aggregatedContent.length < 50)
            return;
        const lastReview = this.lastReviewTime.get(instanceId) ?? 0;
        if (Date.now() - lastReview < MIN_COOLDOWN_MS) {
            logger.debug('Skipping review due to cooldown', { instanceId });
            return;
        }
        const classification = this.classifier.classify(aggregatedContent);
        if (!classification.shouldReview)
            return;
        const enabledTypes = settings.crossModelReviewTypes;
        if (!enabledTypes.includes(classification.type))
            return;
        let reviewDepth = settings.crossModelReviewDepth;
        if (reviewDepth === 'structured' && classification.isComplex) {
            reviewDepth = 'tiered';
        }
        const selectedReviewers = this.reviewerPool.selectReviewers(buffer.primaryProvider, settings.crossModelReviewMaxReviewers);
        if (selectedReviewers.length === 0) {
            this.emit('review:all-unavailable', { instanceId });
            return;
        }
        const reviewId = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.lastReviewTime.set(instanceId, Date.now());
        this.emit('review:started', { instanceId, reviewId });
        const request = {
            id: reviewId,
            instanceId,
            primaryProvider: buffer.primaryProvider,
            content: (0, review_prompts_1.truncateForReview)(aggregatedContent),
            taskDescription: buffer.firstUserPrompt || 'No task description available',
            classification,
            reviewDepth,
            timestamp: Date.now(),
        };
        this.executeReviews(request, selectedReviewers, settings.crossModelReviewTimeout)
            .catch(err => logger.error('Review execution failed', err, { reviewId }));
    }
    // === Review Execution ===
    async executeReviews(request, reviewerClis, timeoutSeconds) {
        const abort = new AbortController();
        this.pendingReviews.set(request.id, abort);
        this.pendingReviewInstances.set(request.id, request.instanceId);
        try {
            const reviewPromises = reviewerClis.map(cliType => this.executeOneReview(request, cliType, timeoutSeconds, abort.signal));
            const results = await Promise.allSettled(reviewPromises);
            const successfulResults = results
                .filter((r) => r.status === 'fulfilled')
                .map(r => r.value);
            const hasDisagreement = this.detectDisagreement(successfulResults);
            const aggregated = {
                id: request.id,
                instanceId: request.instanceId,
                outputType: request.classification.type,
                reviewDepth: request.reviewDepth,
                reviews: successfulResults,
                hasDisagreement,
                timestamp: Date.now(),
            };
            this.addToHistory(request.instanceId, aggregated);
            this.emit('review:result', aggregated);
        }
        finally {
            this.pendingReviews.delete(request.id);
            this.pendingReviewInstances.delete(request.id);
        }
    }
    async executeOneReview(request, cliType, timeoutSeconds, signal) {
        const startTime = Date.now();
        const breaker = (0, circuit_breaker_1.getCircuitBreakerRegistry)().getBreaker(`cross-review-${cliType}`, {
            failureThreshold: 3,
            resetTimeoutMs: 60000,
        });
        try {
            const response = await breaker.execute(async () => {
                if (signal.aborted)
                    throw new Error('Review cancelled');
                const resolvedCli = await (0, adapter_factory_1.resolveCliType)(cliType);
                const adapter = (0, adapter_factory_1.createCliAdapter)(resolvedCli, {
                    workingDirectory: process.cwd(),
                    timeout: timeoutSeconds * 1000,
                    yoloMode: false,
                });
                if (!isCliAdapterLike(adapter)) {
                    throw new Error(`CLI adapter "${cliType}" does not support sendMessage`);
                }
                const prompt = request.reviewDepth === 'tiered'
                    ? (0, review_prompts_1.buildTieredReviewPrompt)(request.taskDescription, request.content)
                    : (0, review_prompts_1.buildStructuredReviewPrompt)(request.taskDescription, request.content);
                return adapter.sendMessage({ role: 'user', content: prompt });
            });
            this.reviewerPool.recordSuccess(cliType);
            return this.parseReviewResponse(cliType, response.content, request.reviewDepth, Date.now() - startTime);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('429') || message.toLowerCase().includes('rate limit') || message.toLowerCase().includes('quota')) {
                this.reviewerPool.markRateLimited(cliType);
            }
            else {
                this.reviewerPool.recordFailure(cliType);
            }
            logger.warn('Review failed', { cliType, error: message });
            throw err;
        }
    }
    // === Response Parsing ===
    parseReviewResponse(reviewerId, rawResponse, reviewDepth, durationMs) {
        const baseResult = {
            reviewerId,
            reviewType: reviewDepth,
            timestamp: Date.now(),
            durationMs,
        };
        let cleaned = rawResponse;
        const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (fenceMatch)
            cleaned = fenceMatch[1];
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        }
        catch {
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    parsed = JSON.parse(jsonMatch[0]);
                }
                catch {
                    logger.warn('Failed to parse review response', { reviewerId });
                    return {
                        ...baseResult,
                        scores: this.emptyScores(),
                        overallVerdict: 'CONCERNS',
                        summary: 'Unable to parse reviewer response',
                        parseSuccess: false,
                        rawResponse,
                    };
                }
            }
        }
        if (!parsed) {
            return {
                ...baseResult,
                scores: this.emptyScores(),
                overallVerdict: 'CONCERNS',
                summary: 'Unable to parse reviewer response',
                parseSuccess: false,
                rawResponse,
            };
        }
        const schema = reviewDepth === 'tiered' ? cross_model_review_schemas_1.TieredReviewResultJsonSchema : cross_model_review_schemas_1.ReviewResultJsonSchema;
        const validated = schema.safeParse(parsed);
        if (!validated.success) {
            logger.warn('Review response failed schema validation', {
                reviewerId,
                errors: validated.error.issues.slice(0, 3),
            });
            return this.buildPartialResult(baseResult, parsed, durationMs);
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
            overallVerdict: data.overall_verdict,
            summary: data.summary,
            criticalIssues: 'critical_issues' in data ? data.critical_issues : undefined,
            traces: 'traces' in data ? data.traces : undefined,
            boundariesChecked: 'boundaries_checked' in data ? data.boundaries_checked : undefined,
            assumptions: 'assumptions' in data ? data.assumptions : undefined,
            integrationRisks: 'integration_risks' in data ? data.integration_risks : undefined,
            parseSuccess: true,
        };
    }
    buildPartialResult(base, raw, durationMs) {
        const extractScore = (obj) => {
            const o = obj;
            return {
                reasoning: typeof o?.['reasoning'] === 'string' ? o['reasoning'] : 'Unable to parse',
                score: typeof o?.['score'] === 'number' ? Math.min(4, Math.max(1, o['score'])) : 2,
                issues: Array.isArray(o?.['issues']) ? o['issues'] : [],
            };
        };
        const r = raw;
        const scores = (r?.['scores'] ?? r);
        return {
            ...base,
            scores: {
                correctness: extractScore(scores?.['correctness']),
                completeness: extractScore(scores?.['completeness']),
                security: extractScore(scores?.['security']),
                consistency: extractScore(scores?.['consistency']),
            },
            overallVerdict: (['APPROVE', 'CONCERNS', 'REJECT'].includes(r?.['overall_verdict'])
                ? r?.['overall_verdict'] : 'CONCERNS'),
            summary: typeof r?.['summary'] === 'string' ? r['summary'] : 'Partially parsed response',
            parseSuccess: false,
            rawResponse: JSON.stringify(raw),
            timestamp: Date.now(),
            durationMs,
        };
    }
    emptyScores() {
        const empty = { reasoning: 'No data', score: 2, issues: [] };
        return { correctness: { ...empty }, completeness: { ...empty }, security: { ...empty }, consistency: { ...empty } };
    }
    // === Disagreement Detection ===
    detectDisagreement(reviews) {
        if (reviews.length === 0)
            return false;
        if (reviews.some(r => r.overallVerdict !== 'APPROVE'))
            return true;
        for (const review of reviews) {
            const allScores = [
                review.scores.correctness?.score,
                review.scores.completeness?.score,
                review.scores.security?.score,
                review.scores.consistency?.score,
                review.scores.feasibility?.score,
            ].filter((s) => s !== undefined);
            if (allScores.some(s => s === 1))
                return true;
        }
        const verdicts = new Set(reviews.map(r => r.overallVerdict));
        if (verdicts.has('APPROVE') && verdicts.has('REJECT'))
            return true;
        return false;
    }
    // === Review History ===
    getReviewHistory(instanceId) {
        return this.reviewHistory.get(instanceId) ?? [];
    }
    addToHistory(instanceId, review) {
        let history = this.reviewHistory.get(instanceId);
        if (!history) {
            history = [];
            this.reviewHistory.set(instanceId, history);
        }
        history.push(review);
        if (history.length > MAX_REVIEW_HISTORY) {
            history.splice(0, history.length - MAX_REVIEW_HISTORY);
        }
    }
    // === Availability ===
    async refreshAvailability() {
        try {
            const detection = cli_detection_1.CliDetectionService.getInstance();
            const result = await detection.detectAll();
            const available = result.available.map(c => c.name);
            const settings = (0, settings_manager_1.getSettingsManager)().getAll();
            const configured = settings.crossModelReviewProviders;
            const effectiveList = configured.length > 0
                ? configured.filter(p => available.includes(p))
                : available;
            this.reviewerPool.setAvailable(effectiveList);
        }
        catch (err) {
            logger.warn('CLI detection failed', { error: String(err) });
        }
    }
    getStatus() {
        const settings = (0, settings_manager_1.getSettingsManager)().getAll();
        return {
            enabled: settings.crossModelReviewEnabled,
            reviewers: this.reviewerPool.getStatus(),
            pendingReviews: this.pendingReviews.size,
        };
    }
    // === Cleanup ===
    cancelPendingReviews(instanceId) {
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
    }
    shutdown() {
        if (this.rateLimitTimer)
            clearInterval(this.rateLimitTimer);
        if (this.availabilityTimer)
            clearInterval(this.availabilityTimer);
        this.rateLimitTimer = null;
        this.availabilityTimer = null;
        for (const abort of this.pendingReviews.values())
            abort.abort();
        this.pendingReviews.clear();
        this.pendingReviewInstances.clear();
        this.buffers.clear();
        this.reviewHistory.clear();
        this.lastReviewTime.clear();
        this.removeAllListeners();
        this.initialized = false;
    }
}
exports.CrossModelReviewService = CrossModelReviewService;
function getCrossModelReviewService() {
    return CrossModelReviewService.getInstance();
}
//# sourceMappingURL=cross-model-review-service.js.map