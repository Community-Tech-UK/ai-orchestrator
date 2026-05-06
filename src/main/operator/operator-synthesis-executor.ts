import type {
  OperatorGitBatchSummary,
  OperatorRunGraph,
  OperatorRunStatus,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';

export interface OperatorSynthesisResult {
  status: OperatorRunStatus;
  summaryMarkdown: string;
  completedWork: string[];
  skippedWork: string[];
  failedWork: string[];
  verification: string | null;
}

export function synthesizeOperatorRun(graph: OperatorRunGraph): OperatorSynthesisResult {
  const result = graph.run.resultJson ?? {};
  const completedWork: string[] = [];
  const skippedWork: string[] = [];
  const failedWork: string[] = [];
  let verification: string | null = null;

  const gitSummary = readGitSummary(result);
  if (gitSummary) {
    completedWork.push(`Pulled ${gitSummary.pulled} repositories`);
    if (gitSummary.upToDate > 0) completedWork.push(`${gitSummary.upToDate} repositories were already up to date`);
    if (gitSummary.skipped > 0) skippedWork.push(`Skipped ${gitSummary.skipped} repositories`);
    if (gitSummary.failed > 0) failedWork.push(`${gitSummary.failed} repositories failed`);
  }

  const repoJob = asRecord(result['repoJob']);
  const repoJobResult = asRecord(repoJob?.['result']);
  const repoJobStatus = typeof repoJob?.['status'] === 'string' ? repoJob['status'] : null;
  if (repoJobStatus === 'completed' && typeof repoJobResult?.['summary'] === 'string') {
    completedWork.push(repoJobResult['summary']);
  } else if (repoJobStatus === 'completed') {
    completedWork.push('Repository job completed');
  } else if (repoJobStatus) {
    failedWork.push(`Repository job finished with status ${repoJobStatus}`);
  }

  const projectAgent = asRecord(result['projectAgent']);
  if (typeof projectAgent?.['outputPreview'] === 'string' && projectAgent['outputPreview']) {
    completedWork.push(projectAgent['outputPreview']);
  }
  const projectAgentChangedFiles = readStringArray(projectAgent?.['changedFiles']);
  if (projectAgentChangedFiles.length > 0) {
    completedWork.push(`Changed files: ${projectAgentChangedFiles.join(', ')}`);
  }

  const projectResults = Array.isArray(result['projectResults'])
    ? result['projectResults'] as Record<string, unknown>[]
    : [];
  for (const projectResult of projectResults) {
    const displayName = typeof projectResult['displayName'] === 'string'
      ? projectResult['displayName']
      : 'Project';
    const outputPreview = typeof projectResult['outputPreview'] === 'string'
      ? projectResult['outputPreview']
      : null;
    const status = typeof projectResult['status'] === 'string' ? projectResult['status'] : 'completed';
    if (status === 'completed' && outputPreview) {
      completedWork.push(`${displayName}: ${outputPreview}`);
    } else if (status === 'completed') {
      completedWork.push(`${displayName}: completed`);
    } else {
      failedWork.push(`${displayName}: ${status}`);
    }
  }

  const verificationSummary = asRecord(result['verification']) as OperatorVerificationSummary | null;
  if (verificationSummary?.status) {
    verification = `Verification: ${verificationSummary.status}`;
    if (verificationSummary.status === 'passed' || verificationSummary.status === 'skipped') {
      completedWork.push(verification);
    } else {
      failedWork.push(`${verification} (${verificationSummary.requiredFailed} required failures)`);
    }
  }

  if (graph.run.error) {
    failedWork.push(graph.run.error);
  }

  const sections = [
    `Status: ${graph.run.status}`,
    listSection('Completed', completedWork),
    listSection('Skipped', skippedWork),
    listSection('Failed or blocked', failedWork),
  ].filter(Boolean);

  return {
    status: graph.run.status,
    summaryMarkdown: sections.join('\n\n'),
    completedWork,
    skippedWork,
    failedWork,
    verification,
  };
}

function readGitSummary(value: Record<string, unknown>): OperatorGitBatchSummary | null {
  if (
    typeof value['total'] === 'number'
    && typeof value['pulled'] === 'number'
    && typeof value['skipped'] === 'number'
    && typeof value['failed'] === 'number'
  ) {
    return value as unknown as OperatorGitBatchSummary;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function listSection(label: string, values: string[]): string {
  if (values.length === 0) return '';
  return `${label}:\n${values.map((value) => `- ${value}`).join('\n')}`;
}
