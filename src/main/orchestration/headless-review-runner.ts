import { getProviderQuotaService } from '../core/system/provider-quota-service';
import type { HeadlessReviewFinding, HeadlessReviewResult, HeadlessReviewReviewer } from '../cli-entrypoints/review-command-output';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import { aggregateReviewFindings, type AggregatableFinding } from './review-finding-aggregation';
import { angleForReviewer, buildStructuredReviewPrompt, buildTieredReviewPrompt, truncateForReview } from './review-prompts';
import { createLocalReviewExecutionPlan, runReviewExecutionBatch } from './review-execution-batch';
import { parseCrossModelReviewResponse } from './review-response-parser';
import { serializeReviewResultJsonSchema } from '../../shared/validation/cross-model-review-schemas';
import { summarizeHeadlessReview, toHeadlessFindings } from './headless-review-findings';
import { resolveAntigravityReviewModelPlan } from './antigravity-review-model-routing';
import { resolveReviewWorkingDirectory } from './cross-model-review-service.helpers';
import { redactForEgress } from '../security/content-egress-gate';
import { resolveReviewerModelOverride, type HeadlessReviewRequest, type ReviewExecutionHost } from '../review/review-execution-host';

export interface HeadlessReviewRunnerDependencies {
  host: ReviewExecutionHost | null;
  resolveReviewers(request: HeadlessReviewRequest): Promise<string[]>;
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
  const taskDescription = redactForEgress(request.taskDescription, { kind: 'prompt' }).content;
  const reviewDepth = request.reviewDepth ?? 'structured';
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
        for (const reviewer of reviewers) {
          const angle = angleForReviewer(reviewerIndex++);
          const prompt = reviewDepth === 'tiered'
            ? buildTieredReviewPrompt(taskDescription, reviewContent, angle)
            : buildStructuredReviewPrompt(taskDescription, reviewContent, angle);
          try {
            const configuredModel = resolveReviewerModelOverride(reviewer);
            const reviewerModels = reviewer === 'antigravity'
              ? resolveAntigravityReviewModelPlan(
                  configuredModel,
                  getProviderQuotaService().getSnapshot('antigravity'),
                )
              : [configuredModel];
            let lastResponseLength = 0;
            let parsed: ReviewResult | null = null;
            // WS14: Claude reviewers get the verdict schema natively (--json-schema);
            // the host applies it only when the resolved CLI is actually claude.
            const jsonSchema = serializeReviewResultJsonSchema(reviewDepth);
            for (const reviewerModel of reviewerModels) {
              const needsModelOverride = reviewer === 'antigravity' && reviewerModel !== configuredModel;
              const rawResponse = needsModelOverride
                ? await dependencies.host.dispatchReviewerPrompt(
                    reviewer, prompt, cwd, abort.signal, { modelOverride: reviewerModel, jsonSchema },
                  )
                : await dependencies.host.dispatchReviewerPrompt(reviewer, prompt, cwd, abort.signal, { jsonSchema });
              lastResponseLength = rawResponse?.length ?? 0;
              parsed = parseCrossModelReviewResponse(reviewer, rawResponse, reviewDepth, 0);
              if (parsed) break;
            }
            if (!parsed) {
              reviewerStatuses.push({
                provider: reviewer,
                status: 'failed',
                reason: `Reviewer returned unparseable output (${lastResponseLength} chars; expected strict JSON)`,
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
  if (dependencies.localEnabled) {
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
  if (egress.secretsFound) {
    findings.unshift({
      title: 'Potential secret redacted before external review',
      body: `${egress.secretCount} potential secret${egress.secretCount === 1 ? '' : 's'} ` +
        'was redacted from the review payload. Inspect the local diff before approving this change.',
      severity: 'critical',
      confidence: 1,
    });
  }
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
