import type { ReviewSeverity } from '../../shared/types/review-severity';
import type { AnchorStatus, EvidenceClass, FindingAnchor } from '../../shared/types/review-evidence';

export type HeadlessReviewSeverity = ReviewSeverity;
export type { AnchorStatus, EvidenceClass, FindingAnchor };

export interface HeadlessReviewReviewer {
  provider: string;
  model?: string;
  source?: 'remote' | 'local';
  selectorId?: string;
  /**
   * WS-B9: `cached` is a successful angle reused from `review-coverage.ts`'s
   * per-angle cache instead of re-dispatching the reviewer; `parse_failed` is
   * split out from the generic `failed` so a reviewer whose output could not
   * be parsed is distinguishable from a transport/execution failure in
   * coverage reporting.
   */
  status: 'used' | 'skipped' | 'failed' | 'cached' | 'parse_failed';
  reason?: string;
  /** WS-B9: `ReviewAngle.id` this reviewer was assigned, or `'local-advisory'` for the local pass. */
  angle?: string;
  /** WS-B9: raw (pre-aggregation, pre-anchor) finding count from this reviewer/angle. */
  findingCount?: number;
  /** WS-B9: whether this angle must be `used`/`cached` for the attempt to count as clean coverage. */
  required?: boolean;
}

export interface HeadlessReviewFinding {
  title: string;
  body: string;
  file?: string;
  line?: number;
  severity: HeadlessReviewSeverity;
  confidence: number;
  reviewers?: string[];
  agreementCount?: number;
  advisory?: boolean;
  /**
   * WS-A3: evidence-anchoring. `anchor` is an exact quote (plus best-effort
   * file/line hints) the finding cites from the reviewed material.
   * `evidenceClass` says whether that citation is even possible for this
   * finding; `anchorStatus` — set once an artifact is available to check
   * against — says whether the citation actually checked out. All optional
   * and additive: absence means "not evaluated", never "failed".
   */
  anchor?: FindingAnchor;
  anchorStatus?: AnchorStatus;
  evidenceClass?: EvidenceClass;
}

export interface HeadlessReviewResult {
  target: string;
  cwd: string;
  startedAt: string;
  completedAt: string;
  reviewers: HeadlessReviewReviewer[];
  findings: HeadlessReviewFinding[];
  summary: string;
  infrastructureErrors: string[];
}

export function formatReviewJson(result: HeadlessReviewResult): string {
  return `${JSON.stringify(normalizeResult(result), null, 2)}\n`;
}

function normalizeResult(result: HeadlessReviewResult): HeadlessReviewResult {
  return {
    target: result.target || '',
    cwd: result.cwd || '',
    startedAt: result.startedAt || '',
    completedAt: result.completedAt || '',
    reviewers: (result.reviewers ?? []).map((reviewer) => ({
      provider: reviewer.provider || 'unknown',
      ...(reviewer.model ? { model: reviewer.model } : {}),
      ...(reviewer.source ? { source: reviewer.source } : {}),
      ...(reviewer.selectorId ? { selectorId: reviewer.selectorId } : {}),
      status: reviewer.status,
      ...(reviewer.reason ? { reason: reviewer.reason } : {}),
      ...(reviewer.angle ? { angle: reviewer.angle } : {}),
      ...(typeof reviewer.findingCount === 'number' ? { findingCount: reviewer.findingCount } : {}),
      ...(typeof reviewer.required === 'boolean' ? { required: reviewer.required } : {}),
    })),
    findings: (result.findings ?? []).map((finding) => ({
      title: finding.title || 'Review finding',
      body: finding.body || '',
      ...(finding.file ? { file: finding.file } : {}),
      ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
      severity: finding.severity,
      confidence: Number.isFinite(finding.confidence) ? finding.confidence : 0,
      ...(finding.reviewers ? { reviewers: finding.reviewers } : {}),
      ...(typeof finding.agreementCount === 'number'
        ? { agreementCount: finding.agreementCount }
        : {}),
      ...(typeof finding.advisory === 'boolean' ? { advisory: finding.advisory } : {}),
      ...(finding.anchor ? { anchor: finding.anchor } : {}),
      ...(finding.anchorStatus ? { anchorStatus: finding.anchorStatus } : {}),
      ...(finding.evidenceClass ? { evidenceClass: finding.evidenceClass } : {}),
    })),
    summary: result.summary || '',
    infrastructureErrors: result.infrastructureErrors ?? [],
  };
}
