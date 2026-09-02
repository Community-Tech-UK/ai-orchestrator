import { createHash } from 'node:crypto';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import type { HeadlessReviewFinding, HeadlessReviewResult, HeadlessReviewReviewer } from '../cli-entrypoints/review-command-output';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import { aggregateReviewFindings, type AggregatableFinding } from './review-finding-aggregation';
import {
  angleForReviewer,
  buildStructuredReviewPrompt,
  buildTieredReviewPrompt,
  promptVersionForAngle,
  truncateForReview,
} from './review-prompts';
import { createLocalReviewExecutionPlan, runReviewExecutionBatch } from './review-execution-batch';
import { parseCrossModelReviewResponse } from './review-response-parser';
import { serializeReviewResultJsonSchema } from '../../shared/validation/cross-model-review-schemas';
import { summarizeHeadlessReview, toHeadlessFindings } from './headless-review-findings';
import { resolveAntigravityReviewModelPlan } from './antigravity-review-model-routing';
import { resolveReviewWorkingDirectory } from './cross-model-review-service.helpers';
import { redactForEgress } from '../security/content-egress-gate';
import { verifyAnchor } from './review-artifact-anchor';
import { LOCAL_ADVISORY_ANGLE, NO_RULES_HASH } from './review-coverage';
import { resolveReviewerModelOverride, type HeadlessReviewRequest, type ReviewExecutionHost } from '../review/review-execution-host';
import type { CheckerCandidate } from '../review/checker-plan';
import { learnFromCheckerFailure } from '../review/copilot-model-entitlements';

export interface HeadlessReviewRunnerDependencies {
  host: ReviewExecutionHost | null;
  resolveReviewers(request: HeadlessReviewRequest): Promise<CheckerCandidate[]>;
  localEnabled: boolean;
  createLocalPlan(input: {
    workspaceRoot: string;
    taskDescription: string;
    content: string;
    reviewDepth: 'structured' | 'tiered';
    signal: AbortSignal;
  }): ReturnType<typeof createLocalReviewExecutionPlan>;
}

/**
 * Executes the CLI-facing review workflow independently of interactive review
 * history and lifecycle state. The service owns its injected host and local
 * model dependencies; this runner owns only the bounded headless operation.
 */
export async function runHeadlessReviewCommand(
  request: HeadlessReviewRequest,
  dependencies: HeadlessReviewRunnerDependencies,
): Promise<HeadlessReviewResult> {
  const startedAt = new Date();
  const cwd = resolveReviewWorkingDirectory(request.cwd);
  const reviewers = await dependencies.resolveReviewers(request);
  const abort = new AbortController();
  const externalSignal = request.signal;
  const abortFromExternal = (): void => abort.abort(externalSignal?.reason);
  const timeoutMs = Math.max(1, request.timeoutSeconds ?? 60) * 1000;
  const reviewerStatuses: HeadlessReviewReviewer[] = [];
  const egress = redactForEgress(request.content, { kind: 'diff', preserveDiffMarkers: true });
  const reviewContent = truncateForReview(egress.content);
  // WS-B9: the exact, redacted, size-bounded material every reviewer this
  // call actually sees. One component of the per-angle cache key — an
  // identical hash means an identical review payload, so a cached verdict
  // for the same reviewer/model/angle/prompt is safe to reuse.
  const workHash = createHash('sha256').update(reviewContent).digest('hex');
  const taskDescription = redactForEgress(request.taskDescription, { kind: 'prompt' }).content;
  const reviewDepth = request.reviewDepth ?? 'structured';
  const reviewCache = request.reviewCache;
  const localPlan = dependencies.createLocalPlan({
    workspaceRoot: cwd,
    taskDescription,
    content: reviewContent,
    reviewDepth,
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
        if (!dependencies.host) throw new Error('Headless review host is not configured.');
        const successful: ReviewResult[] = [];
        let reviewerIndex = 0;
        for (const checker of reviewers) {
          const reviewer = checker.provider;
          // Set only when the checking policy CHANGED this checker's model.
          // Absent leaves the existing resolution path untouched, including
          // Antigravity's quota-aware multi-model fallback plan.
          const plannedModel = checker.rationale === 'unchanged' ? undefined : checker.model;
          const angle = angleForReviewer(reviewerIndex++);
          const promptVersion = promptVersionForAngle(reviewDepth, angle);
          const prompt = reviewDepth === 'tiered'
            ? buildTieredReviewPrompt(taskDescription, reviewContent, angle)
            : buildStructuredReviewPrompt(taskDescription, reviewContent, angle);
          try {
            const configuredModel = plannedModel ?? resolveReviewerModelOverride(reviewer);
            const reviewerModels = reviewer === 'antigravity' && !plannedModel
              ? resolveAntigravityReviewModelPlan(
                  configuredModel,
                  getProviderQuotaService().getSnapshot('antigravity'),
                )
              : [configuredModel];
            // WS-B9: caching needs one unambiguous model identity for the key.
            // Antigravity's runtime fallback plan can try several concrete
            // models within a single call and the identity isn't known until
            // AFTER dispatch, so cache participation is deliberately skipped
            // for that narrow multi-model-fallback case rather than caching
            // under an ambiguous "auto" identity.
            const cacheModel = reviewCache && reviewerModels.length === 1
              ? (configuredModel ?? 'auto')
              : undefined;
            if (reviewCache && cacheModel) {
              const cached = reviewCache.lookup({
                reviewerProvider: reviewer,
                model: cacheModel,
                angleId: angle.id,
                promptVersion,
                rulesHash: NO_RULES_HASH,
                workHash,
              });
              if (cached) {
                successful.push(cached.review);
                reviewerStatuses.push({
                  provider: reviewer,
                  status: 'cached',
                  angle: angle.id,
                  required: true,
                  ...(configuredModel ? { model: configuredModel } : {}),
                  reason: cached.activationReason,
                  findingCount: toHeadlessFindings(cached.review).length,
                });
                continue;
              }
            }
            let lastResponseLength = 0;
            let parsed: ReviewResult | null = null;
            let usedModel: string | undefined;
            // WS14: Claude reviewers get the verdict schema natively (--json-schema);
            // the host applies it only when the resolved CLI is actually claude.
            const jsonSchema = serializeReviewResultJsonSchema(reviewDepth);
            for (const reviewerModel of reviewerModels) {
              const needsModelOverride = plannedModel !== undefined
                || (reviewer === 'antigravity' && reviewerModel !== configuredModel);
              const rawResponse = needsModelOverride
                ? await dependencies.host.dispatchReviewerPrompt(
                    reviewer, prompt, cwd, abort.signal, { modelOverride: reviewerModel, jsonSchema },
                  )
                : await dependencies.host.dispatchReviewerPrompt(reviewer, prompt, cwd, abort.signal, { jsonSchema });
              lastResponseLength = rawResponse?.length ?? 0;
              parsed = parseCrossModelReviewResponse(reviewer, rawResponse, reviewDepth, 0);
              if (parsed) {
                usedModel = reviewerModel;
                break;
              }
            }
            if (!parsed) {
              // WS-B9: split from the generic 'failed' below — an unparseable
              // response is a distinct coverage outcome from a transport/
              // execution error, and (per house style) a parse failure is
              // never cached.
              reviewerStatuses.push({
                provider: reviewer,
                status: 'parse_failed',
                angle: angle.id,
                required: true,
                reason: `Reviewer returned unparseable output (${lastResponseLength} chars; expected strict JSON)`,
              });
              continue;
            }
            successful.push(parsed);
            if (reviewCache && cacheModel) {
              reviewCache.store({
                reviewerProvider: reviewer,
                model: cacheModel,
                angleId: angle.id,
                promptVersion,
                rulesHash: NO_RULES_HASH,
                workHash,
                review: parsed,
              });
            }
            reviewerStatuses.push({
              provider: reviewer,
              status: 'used',
              angle: angle.id,
              required: true,
              ...(usedModel ? { model: usedModel } : {}),
              findingCount: toHeadlessFindings(parsed).length,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A Copilot seat only reveals what it will actually serve by
            // refusing something: `copilot help config` returns the same static
            // roster for every account. Learn from the refusal so the next plan
            // for this seat skips the model instead of failing again.
            learnFromCheckerFailure(checker.copilotProfileId, message);
            reviewerStatuses.push({
              provider: reviewer,
              status: 'failed',
              angle: angle.id,
              required: true,
              reason: message,
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
  if (dependencies.localEnabled) {
    reviewerStatuses.push({
      provider: 'local-model',
      source: 'local',
      status: localParticipant.status,
      ...(localParticipant.model ? { model: localParticipant.model } : {}),
      ...(localParticipant.selectorId ? { selectorId: localParticipant.selectorId } : {}),
      ...(localParticipant.reason ? { reason: localParticipant.reason } : {}),
      // WS-B9: the local pass has no `ReviewAngle` and its findings are
      // always advisory (see `loop-fresh-eyes-reviewer.ts`) — never required
      // coverage.
      angle: LOCAL_ADVISORY_ANGLE,
      required: false,
      findingCount: batch.localOutcome.status === 'used' ? toHeadlessFindings(batch.localOutcome.review).length : 0,
    });
  }
  const localReviews = batch.localOutcome.status === 'used'
    ? [{ ...batch.localOutcome.review, source: 'local' as const }]
    : [];
  const successfulReviews = [...batch.remoteReviews, ...localReviews];
  // WS-A3: verify each finding's cited quote against `reviewContent` — the
  // exact material every reviewer this call actually saw — BEFORE
  // aggregation, so clustering's weakest-anchor-status rule has real values
  // to roll up. This covers both the standalone CLI review command and any
  // caller (including the loop's fresh-eyes gate) that reaches this runner;
  // a caller that also durably persists its OWN reviewed artifact (the loop
  // completion gate does, via `review-artifact-anchor.ts`) re-verifies
  // against that persisted copy before treating a finding as blocking.
  const taggedFindings: AggregatableFinding[] = successfulReviews.flatMap((review) =>
    toHeadlessFindings(review).map((finding) => ({
      ...finding,
      ...(finding.anchor ? { anchorStatus: verifyAnchor(reviewContent, finding.anchor).status } : {}),
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
    ...(finding.anchor ? { anchor: finding.anchor } : {}),
    ...(finding.anchorStatus ? { anchorStatus: finding.anchorStatus } : {}),
    ...(finding.evidenceClass ? { evidenceClass: finding.evidenceClass } : {}),
  }));
  if (egress.secretsFound) {
    findings.unshift({
      title: 'Potential secret redacted before external review',
      body: `${egress.secretCount} potential secret${egress.secretCount === 1 ? '' : 's'} ` +
        'was redacted from the review payload. Inspect the local diff before approving this change.',
      severity: 'critical',
      confidence: 1,
      // WS-A3: a hard-coded, non-LLM safety check — always blocks (when
      // severity-eligible) regardless of anchor state; there is nothing to
      // "cite" since it isn't a model judgement.
      evidenceClass: 'deterministic-gate',
    });
  }
  // WS-B9: 'parse_failed' is a split-out sibling of 'failed' (see above) —
  // both are infra-worthy failures for this rollup, so it must match both.
  const isFailureStatus = (status: HeadlessReviewReviewer['status']): boolean =>
    status === 'failed' || status === 'parse_failed';
  const failedReasons = reviewerStatuses
    .filter((reviewer) => reviewer.source !== 'local' && isFailureStatus(reviewer.status) && reviewer.reason)
    .map((reviewer) => `${reviewer.provider}: ${reviewer.reason}`);
  const localFailureReasons = reviewerStatuses
    .filter((reviewer) => reviewer.source === 'local' && isFailureStatus(reviewer.status) && reviewer.reason)
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
  const noReviewers = reviewers.length === 0 && batch.localOutcome.status === 'skipped';

  return {
    target: request.target,
    cwd,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    reviewers: reviewerStatuses,
    findings,
    summary: noReviewers
      ? 'No reviewers available for headless review.'
      : summarizeHeadlessReview(successfulReviews.length, findings.length, infrastructureErrors.length),
    infrastructureErrors,
  };
}
