import type {
  LoopAuditFinding,
  LoopAuditStatus,
  LoopFinalAuditMode,
  LoopFinalAuditResult,
  LoopGoalIntent,
  LoopPlanPacketSummary,
} from '../../shared/types/loop.types';
import type { LoopRepoComparison } from './loop-repo-state';

export interface LoopFinalAuditInput {
  goalIntent: LoopGoalIntent;
  mode: LoopFinalAuditMode;
  verifyStatus: 'passed' | 'failed' | 'skipped';
  repoComparison: LoopRepoComparison;
  ledger: { total: number; open: number; resolved: number };
  planPacket?: LoopPlanPacketSummary | null;
  cleanliness: LoopCleanlinessResult;
  reportPath?: string;
}

export interface LoopCleanlinessResult {
  status: 'passed' | 'failed' | 'skipped';
  findings: LoopAuditFinding[];
}

export function evaluateLoopFinalAudit(input: LoopFinalAuditInput): LoopFinalAuditResult {
  const coverage = buildCoverage(input);
  if (input.mode === 'off') {
    return {
      status: 'skipped',
      ranAt: Date.now(),
      coverage,
      findings: [],
      changedFiles: input.repoComparison.changedFiles,
      ...(input.reportPath ? { reportPath: input.reportPath } : {}),
    };
  }

  const findings: LoopAuditFinding[] = [];
  if (input.verifyStatus === 'failed') {
    findings.push({
      severity: 'blocking',
      code: 'verify-failed',
      message: 'The verify command failed.',
    });
  }
  if (input.ledger.open > 0) {
    findings.push({
      severity: 'blocking',
      code: 'ledger-open',
      message: `LOOP_TASKS.md still has ${input.ledger.open} open item(s).`,
      detail: { total: input.ledger.total, resolved: input.ledger.resolved },
    });
  }
  if (
    input.goalIntent === 'implementation'
    && input.repoComparison.source === 'git'
    && input.repoComparison.changedFiles.length === 0
  ) {
    findings.push({
      severity: 'blocking',
      code: 'no-deliverable-change',
      message: 'No new deliverable repository change was detected.',
    });
  }
  if (input.repoComparison.source !== 'git') {
    findings.push({
      severity: 'review',
      code: 'repo-state-unavailable',
      message: 'Repository state comparison was unavailable; operator review is required.',
    });
  }
  if (
    input.planPacket
    && (input.planPacket.malformed || input.planPacket.criteriaTotal > input.planPacket.criteriaWithEvidence)
  ) {
    const missingCriteria = Math.max(
      0,
      input.planPacket.criteriaTotal - input.planPacket.criteriaWithEvidence,
    );
    findings.push({
      severity: 'review',
      code: 'plan-criteria-unproven',
      message: input.planPacket.malformed
        ? 'The plan packet is malformed; operator review is required.'
        : `${missingCriteria} plan criteria lack evidence.`,
      detail: {
        criteriaTotal: input.planPacket.criteriaTotal,
        criteriaWithEvidence: input.planPacket.criteriaWithEvidence,
        malformed: input.planPacket.malformed,
      },
    });
  }
  if (input.verifyStatus === 'skipped') {
    findings.push({
      severity: 'review',
      code: 'repo-state-unavailable',
      message: 'Verify command did not run; operator review is required before accepting completion.',
    });
  }
  findings.push(...input.cleanliness.findings);

  const status = resolveAuditStatus(findings);
  return {
    status,
    ranAt: Date.now(),
    coverage,
    findings,
    changedFiles: input.repoComparison.changedFiles,
    ...(input.reportPath ? { reportPath: input.reportPath } : {}),
  };
}

export function scanAddedLinesForCleanliness(diff: string): LoopCleanlinessResult {
  if (!diff.trim()) {
    return { status: 'skipped', findings: [] };
  }
  const findings: LoopAuditFinding[] = [];
  for (const rawLine of diff.split(/\r?\n/)) {
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++ ')) continue;
    const line = rawLine.slice(1);
    const detail = { line: line.slice(0, 240) };
    if (line.includes('<<<<<<<') || line.includes('=======') || line.includes('>>>>>>>')) {
      findings.push({
        severity: 'blocking',
        code: 'cleanliness-blocking',
        message: 'Added line contains a git conflict marker.',
        detail,
      });
    }
    if (/\.only\s*\(/.test(line)) {
      findings.push({
        severity: 'blocking',
        code: 'cleanliness-blocking',
        message: 'Added line contains a focused test.',
        detail,
      });
    }
    if (/\bconsole\.log\s*\(/.test(line) || /\bdebugger\s*;/.test(line)) {
      findings.push({
        severity: 'blocking',
        code: 'cleanliness-blocking',
        message: 'Added line contains debug-only code.',
        detail,
      });
    }
    if (/\b(fixme|hack)\b/i.test(line)) {
      findings.push({
        severity: 'review',
        code: 'cleanliness-blocking',
        message: 'Added line contains a temporary marker comment.',
        detail,
      });
    }
  }
  return {
    status: findings.some((finding) => finding.severity === 'blocking') ? 'failed' : 'passed',
    findings,
  };
}

export function renderLoopFinalAuditMarkdown(result: LoopFinalAuditResult): string {
  const lines = [
    '# Loop Final Audit',
    '',
    `- Status: ${result.status}`,
    `- Criteria verified: ${result.coverage.criteriaVerified} / ${result.coverage.criteriaTotal}`,
    `- Verify command ran: ${result.coverage.verifyCommandRan ? 'yes' : 'no'}`,
    `- Repo comparison ran: ${result.coverage.repoComparisonRan ? 'yes' : 'no'}`,
    `- Repo comparison source: ${result.coverage.repoComparisonRan ? 'git' : 'none'}`,
    `- Cleanliness scan ran: ${result.coverage.cleanlinessScanRan ? 'yes' : 'no'}`,
    '',
  ];
  appendFindingSection(lines, 'Blocking Findings', result.findings.filter((f) => f.severity === 'blocking'));
  appendFindingSection(lines, 'Review Findings', result.findings.filter((f) => f.severity === 'review'));
  appendFindingSection(lines, 'Info Findings', result.findings.filter((f) => f.severity === 'info'));
  lines.push('## Changed Files', '');
  if (result.changedFiles.length === 0) {
    lines.push('- (none)');
  } else {
    lines.push(...result.changedFiles.map((file) => `- ${file}`));
  }
  lines.push('');
  return lines.join('\n');
}

function buildCoverage(input: LoopFinalAuditInput): LoopFinalAuditResult['coverage'] {
  const criteriaTotal = input.planPacket?.criteriaTotal ?? input.ledger.total;
  const criteriaVerified = input.planPacket?.criteriaWithEvidence ?? input.ledger.resolved;
  return {
    criteriaTotal,
    criteriaVerified,
    criteriaUnverified: Math.max(0, criteriaTotal - criteriaVerified),
    verifyCommandRan: input.verifyStatus !== 'skipped',
    repoComparisonRan: input.repoComparison.source === 'git',
    cleanlinessScanRan: input.cleanliness.status !== 'skipped',
  };
}

function resolveAuditStatus(findings: LoopAuditFinding[]): LoopAuditStatus {
  if (findings.some((finding) => finding.severity === 'blocking')) return 'failed';
  if (findings.some((finding) => finding.severity === 'review')) return 'needs-review';
  return 'passed';
}

function appendFindingSection(lines: string[], title: string, findings: LoopAuditFinding[]): void {
  lines.push(`## ${title}`, '');
  if (findings.length === 0) {
    lines.push('- (none)', '');
    return;
  }
  for (const finding of findings) {
    const file = finding.file ? ` (${finding.file})` : '';
    lines.push(`- ${finding.code}${file}: ${finding.message}`);
  }
  lines.push('');
}
