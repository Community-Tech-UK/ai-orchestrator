import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  LoopFinalAuditResult,
  LoopIteration,
  LoopPhaseRecoveryState,
  LoopState,
} from '../../shared/types/loop.types';
import { createLoopPendingInput } from '../../shared/types/loop.types';
import { isReviewDrivenProductionChange } from './loop-coordinator-completion-gates';
import { readLoopPlanPacket } from './loop-plan-packet';
import type { LoopStageMachine } from './loop-stage-machine';
import { parseOutstandingSections } from './loop-stage-markdown';

export interface LoopPhaseRecoveryDecision {
  status: 'continue' | 'handoff';
  terminalStatus?: 'completed-needs-review' | 'no-progress';
  reason?: string;
  fixSpecPath?: string;
}

export async function applyLoopPhaseRecovery(params: {
  state: LoopState;
  iteration: LoopIteration | undefined;
  finalAudit: LoopFinalAuditResult;
  stageMachine: LoopStageMachine;
}): Promise<LoopPhaseRecoveryDecision> {
  const { state, iteration, finalAudit, stageMachine } = params;
  if (finalAudit.status === 'passed' || finalAudit.status === 'skipped') {
    return { status: 'continue' };
  }

  const phaseId = await resolveCurrentPhaseId(stageMachine);
  const findingCodes = finalAudit.findings.map((finding) => finding.code).sort();
  const madeProductionChange = iteration?.filesChanged.some((file) =>
    isReviewDrivenProductionChange(file.path),
  ) === true;
  const phaseRecovery = (state.phaseRecovery ??= {});
  const previous = phaseRecovery[phaseId];
  const repeated = previous
    && sameCodes(previous.lastFindingCodes, findingCodes)
    && !madeProductionChange;
  const next: LoopPhaseRecoveryState = {
    phaseId,
    consecutiveFailures: repeated ? previous.consecutiveFailures + 1 : 1,
    lastFailureAt: Date.now(),
    lastFindingCodes: findingCodes,
  };
  phaseRecovery[phaseId] = next;

  if (next.consecutiveFailures === 2) {
    const fixSpecPath = await writePhaseFixSpec(stageMachine, phaseId, finalAudit);
    state.pendingInterventions.push(createLoopPendingInput(
      `Phase recovery: ${phaseId} has failed the same completion audit twice. ` +
        `Work only from the narrow fix spec at ${fixSpecPath}, then rerun the required evidence and re-declare completion.`,
      { source: 'phase-recovery' },
    ));
    return { status: 'continue', fixSpecPath };
  }

  if (next.consecutiveFailures >= 3) {
    const fixSpecPath = await writePhaseFixSpec(stageMachine, phaseId, finalAudit);
    const terminalStatus = finalAudit.status === 'needs-review' ? 'completed-needs-review' : 'no-progress';
    const reason =
      `Phase recovery handoff for ${phaseId}: the same final-audit findings repeated ` +
      `${next.consecutiveFailures} times without new production changes. Fix spec: ${fixSpecPath}`;
    await appendPhaseRecoveryOutstanding(stageMachine, phaseId, reason, fixSpecPath);
    return { status: 'handoff', terminalStatus, reason, fixSpecPath };
  }

  return { status: 'continue' };
}

async function resolveCurrentPhaseId(stageMachine: LoopStageMachine): Promise<string> {
  try {
    const packet = await readLoopPlanPacket(stageMachine.paths);
    const unresolved = packet?.phases.find((phase) =>
      phase.evidence.length < phase.acceptanceCriteria.length,
    );
    if (unresolved) return unresolved.id;
    if (packet?.phases[0]) return packet.phases[0].id;
  } catch {
    // Fall through to the ledger heuristic.
  }
  try {
    const ledger = await stageMachine.readTaskLedger();
    const text = ledger.nextTodo ?? '';
    const match = text.match(/\bphase\s*(\d+)\b/i);
    if (match) return `phase-${Number(match[1])}`;
  } catch {
    // Fall through to unscoped recovery.
  }
  return 'unscoped';
}

async function writePhaseFixSpec(
  stageMachine: LoopStageMachine,
  phaseId: string,
  finalAudit: LoopFinalAuditResult,
): Promise<string> {
  await fsp.mkdir(stageMachine.paths.phasesDir, { recursive: true });
  const fixSpecPath = path.join(stageMachine.paths.phasesDir, `${safePhaseId(phaseId)}.fix.md`);
  const findings = finalAudit.findings.length > 0
    ? finalAudit.findings
    : [{ code: 'audit-internal-error', message: 'Final audit failed without detailed findings.' }];
  const lines = [
    `# Phase Fix Spec: ${phaseId}`,
    '',
    '## Blocking Findings',
    '',
    ...findings.map((finding) => `- ${finding.code}: ${finding.message}`),
    '',
    '## Required Next Attempt',
    '',
    'Work only on this phase. Do not broaden scope. Fix the blocking findings, ' +
      'update evidence, rerun required commands, then attempt completion again.',
    '',
  ];
  await fsp.writeFile(fixSpecPath, lines.join('\n'), 'utf8');
  return fixSpecPath;
}

async function appendPhaseRecoveryOutstanding(
  stageMachine: LoopStageMachine,
  phaseId: string,
  reason: string,
  fixSpecPath: string,
): Promise<void> {
  let existing = '';
  try {
    existing = await fsp.readFile(stageMachine.paths.outstanding, 'utf8');
  } catch {
    // Create the file below.
  }
  const sections = parseOutstandingSections(existing);
  const needsHuman = [
    ...sections.needsHuman.map((entry) => renderOutstandingEntry(entry.text, entry.recommendation)),
    renderOutstandingEntry(
      reason,
      `Review ${fixSpecPath}, decide whether to narrow or defer ${phaseId}, then resume the loop with that decision.`,
    ),
  ];
  const openQuestions = sections.openQuestions.map((entry) =>
    renderOutstandingEntry(entry.text, entry.recommendation),
  );
  const next = [
    '## Needs human',
    ...needsHuman,
    '',
    '## Open questions',
    ...(openQuestions.length > 0 ? openQuestions : ['- (none)']),
    '',
  ].join('\n');
  await fsp.mkdir(path.dirname(stageMachine.paths.outstanding), { recursive: true });
  await fsp.writeFile(stageMachine.paths.outstanding, next, 'utf8');
}

function renderOutstandingEntry(text: string, recommendation: string | null): string {
  return recommendation
    ? `- ${text}\n  - Recommendation: ${recommendation}`
    : `- ${text}`;
}

function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function safePhaseId(phaseId: string): string {
  return phaseId.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unscoped';
}
