export type HeadlessReviewSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface HeadlessReviewReviewer {
  provider: string;
  model?: string;
  status: 'used' | 'skipped' | 'failed';
  reason?: string;
}

export interface HeadlessReviewFinding {
  title: string;
  body: string;
  file?: string;
  line?: number;
  severity: HeadlessReviewSeverity;
  confidence: number;
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
      status: reviewer.status,
      ...(reviewer.reason ? { reason: reviewer.reason } : {}),
    })),
    findings: (result.findings ?? []).map((finding) => ({
      title: finding.title || 'Review finding',
      body: finding.body || '',
      ...(finding.file ? { file: finding.file } : {}),
      ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
      severity: finding.severity,
      confidence: Number.isFinite(finding.confidence) ? finding.confidence : 0,
    })),
    summary: result.summary || '',
    infrastructureErrors: result.infrastructureErrors ?? [],
  };
}
