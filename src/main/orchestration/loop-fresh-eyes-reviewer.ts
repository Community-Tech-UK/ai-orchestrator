import type {
  LoopCrossModelReviewConfig,
  LoopTerminalIntent,
} from '../../shared/types/loop.types';

/**
 * Severity of a fresh-eyes review finding. Mirrors
 * `HeadlessReviewFinding.severity` from
 * `src/main/cli-entrypoints/review-command-output.ts` but is kept as a local
 * type so importing the coordinator does not eagerly pull in headless review.
 */
export type FreshEyesSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface FreshEyesFinding {
  title: string;
  body: string;
  severity: FreshEyesSeverity;
  file?: string;
  confidence: number;
}

export interface FreshEyesReviewerInput {
  loopRunId: string;
  workspaceCwd: string;
  /** The user's actual goal — fed to the reviewer as taskDescription. */
  goal: string;
  /**
   * Excerpt of the iteration output that claimed completion.
   *
   * NB: this is the agent's own self-narration. The default reviewer
   * deliberately does NOT forward it as review context — reviewers judge the
   * actual `diff`, not the optimistic transcript. Retained on the input for
   * observability and for alternate reviewer implementations.
   */
  iterationOutput: string;
  /**
   * Unified git diff of the cumulative change under review (vs HEAD, plus
   * untracked files). This is the *preferred* review payload — reviewers see
   * ground truth instead of the parent transcript. Empty when the workspace
   * is not a git repository (`diffSource === 'none'`).
   */
  diff?: string;
  /** Where {@link diff} came from. 'none' means no git repo / no diff. */
  diffSource?: 'git' | 'none';
  /** Files changed across the run (best-effort, can be empty). */
  filesChangedThisIteration: readonly string[];
  /** Plan files that started uncompleted in this run. */
  uncompletedPlanFilesAtStart: readonly string[];
  /** Verify output passed-in for context. */
  verifyOutputExcerpt: string;
  /** Coordinator's signal that fired this completion attempt. */
  signal: string;
  /** Explicit terminal intent that caused the completion attempt, if present. */
  terminalIntent?: LoopTerminalIntent;
  /** Review configuration (reviewers, severities, depth, timeout). */
  config: LoopCrossModelReviewConfig;
}

export interface FreshEyesReviewerResult {
  findings: FreshEyesFinding[];
  /** Provider names actually used as reviewers. Empty when none available. */
  reviewersUsed: string[];
  /** Plain-English summary returned by the review service. */
  summary: string;
  /** Whether the underlying review infrastructure failed entirely. */
  infrastructureError?: string;
}

export type FreshEyesReviewer = (
  input: FreshEyesReviewerInput,
) => Promise<FreshEyesReviewerResult>;

/**
 * Default implementation — lazily imports `CrossModelReviewService` and
 * dispatches a headless review. Returns an empty findings list when the
 * service has no reviewers available (degrades safely).
 */
export const defaultFreshEyesReviewer: FreshEyesReviewer = async (input) => {
  // Lazy import to avoid pulling the review service into test paths that
  // mock `getCrossModelReviewService`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCrossModelReviewService } = require(
    './cross-model-review-service',
  ) as typeof import('./cross-model-review-service');
  const service = getCrossModelReviewService();

  const filesBlock =
    input.filesChangedThisIteration.length > 0
      ? `\n\nFiles changed during the run:\n${input.filesChangedThisIteration.slice(0, 50).map((f) => `  - ${f}`).join('\n')}`
      : '';
  const plansBlock =
    input.uncompletedPlanFilesAtStart.length > 0
      ? `\n\nPlan files that existed at loop start (the agent was asked to address these):\n${input.uncompletedPlanFilesAtStart.map((f) => `  - ${f}`).join('\n')}`
      : '';
  const intentBlock = input.terminalIntent
    ? `\n\nExplicit terminal intent:\n  - kind: ${input.terminalIntent.kind}\n  - summary: ${input.terminalIntent.summary}\n`
    : '';

  // The review payload is the *diff* + goal, NOT the agent's transcript. When
  // no git diff is available, fall back to the changed-file list so the
  // reviewer still has something concrete to anchor on.
  const diffText = (input.diff ?? '').trim();
  const hasDiff = diffText.length > 0;
  const changeBlock = hasDiff
    ? `## Change under review (git diff vs HEAD)\n${diffText}`
    : `## Change under review\n(No git diff available — this workspace may not be a git repository. ` +
      `Review against the goal and the changed-file list below.)${filesBlock}`;

  const content =
    `# Fresh-eyes review request\n\n` +
    `A long-running autonomous loop has signalled completion via "${input.signal}" and ` +
    `verify (build/test/lint) passed. Before the loop terminates, review the actual change ` +
    `below with fresh eyes — judge the diff itself, not any summary of it.\n\n` +
    `## What to look for\n` +
    `- Items the goal asked for that are NOT actually implemented in code (orphan modules, stubs returning constants, "completed" docs with no real wiring).\n` +
    `- Specs that say one thing but code does another.\n` +
    `- Half-done features or TODOs left behind.\n` +
    `- Integration gaps: new code that is never imported or invoked outside its own tests.\n` +
    `- Regressions or unsafe edits introduced by the change.\n\n` +
    `## What blocks completion\n` +
    `Mark a finding as **critical** or **high** severity ONLY for blocking issues that would make a reasonable reviewer say "no, this isn't done yet."\n` +
    `Use **medium** or **low** for nice-to-haves, style nits, or follow-up suggestions — those do not block completion.\n\n` +
    `${changeBlock}${hasDiff ? filesBlock : ''}${plansBlock}${intentBlock}\n\n` +
    `## Verify output (already green — for context)\n${input.verifyOutputExcerpt}\n`;

  try {
    const result = await service.runHeadlessReview({
      target: `loop:${input.loopRunId}`,
      cwd: input.workspaceCwd,
      content,
      taskDescription: input.goal,
      reviewers: input.config.reviewers,
      reviewDepth: input.config.reviewDepth,
      timeoutSeconds: input.config.timeoutSeconds,
    });

    return {
      findings: result.findings.map((f) => ({
        title: f.title,
        body: f.body,
        severity: f.severity,
        file: f.file,
        confidence: f.confidence,
      })),
      reviewersUsed: result.reviewers
        .filter((r) => r.status === 'used')
        .map((r) => r.provider),
      summary: result.summary,
      infrastructureError:
        result.infrastructureErrors && result.infrastructureErrors.length > 0
          ? result.infrastructureErrors.join('; ')
          : undefined,
    };
  } catch (err) {
    return {
      findings: [],
      reviewersUsed: [],
      summary: 'Fresh-eyes review threw.',
      infrastructureError: err instanceof Error ? err.message : String(err),
    };
  }
};
