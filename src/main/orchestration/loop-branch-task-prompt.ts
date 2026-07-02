export function formatBranchCandidateTaskPacket(packet: unknown): string {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return '';
  const value = packet as {
    id?: unknown;
    objective?: unknown;
    scope?: { read?: unknown; write?: unknown };
    acceptanceCriteria?: unknown;
    verificationPlan?: unknown;
    depth?: unknown;
  };
  return [
    '## TaskPacket',
    `id: ${typeof value.id === 'string' ? value.id : 'branch-candidate'}`,
    `objective: ${typeof value.objective === 'string' ? value.objective : 'Advance the loop goal.'}`,
    'scope.read:',
    formatStringList(value.scope?.read),
    'scope.write:',
    formatStringList(value.scope?.write),
    'acceptance_criteria:',
    formatStringList(value.acceptanceCriteria),
    'verification_plan:',
    formatStringList(value.verificationPlan),
    `depth: ${typeof value.depth === 'number' ? value.depth : 0}`,
    '',
    '## Required Return Shape',
    'End your response with these sections exactly:',
    'Scope:',
    '- changed/read scope summary',
    'Result:',
    'short result summary',
    'Key files:',
    '- path/to/file',
    'Issues:',
    '- none, or concrete blocker',
  ].join('\n');
}

function formatStringList(items: unknown): string {
  return Array.isArray(items) && items.every((item) => typeof item === 'string')
    ? items.map((item) => `- ${item}`).join('\n')
    : '- none';
}
