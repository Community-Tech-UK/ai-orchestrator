/**
 * Plan Queue DTOs and the messages sent to the parent session.
 *
 * The parent session is the one that called `plan_queue_start`. It is told
 * about questions (so it can ask James with its own structured-question tool)
 * and gets one summary when the run ends. The panel shows the same data and is
 * authoritative.
 */

import type {
  PlanQueueItemDto,
  PlanQueueNeedJamesEntry,
  PlanQueueQuestion,
  PlanQueueRunDto,
} from '@contracts/schemas/plan-queue';
import { documentStem } from './plan-queue-item-flow';
import { relaxedSettingsFor } from './plan-queue-relaxation';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

export function itemToDto(item: PlanQueueItem): PlanQueueItemDto {
  return {
    id: item.id,
    runId: item.runId,
    documentPath: item.documentPath,
    state: item.state,
    round: item.round,
    erroredRounds: item.erroredRounds,
    branchName: item.branchName,
    worktreePath: item.worktreePath,
    baseCommit: item.baseCommit,
    checkpointCommit: item.checkpointCommit,
    landedCommit: item.landedCommit,
    workerInstanceId: item.workerInstanceId,
    verifierInstanceId: item.verifierInstanceId,
    question: item.question,
    answer: item.answer,
    parkReason: item.parkReason,
    detail: item.detail,
    verdict: item.verdict,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function runToDto(run: PlanQueueRun, items: readonly PlanQueueItem[]): PlanQueueRunDto {
  return {
    id: run.id,
    parentInstanceId: run.parentInstanceId,
    kind: run.kind,
    workspaceCwd: run.workspaceCwd,
    status: run.status,
    config: run.config,
    workerProvider: run.workerProvider,
    relaxedSettings: relaxedSettingsFor(run),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    items: items.map(itemToDto),
  };
}

/** Every readiness question offers a way to leave the document alone. */
export function withSkipOption(question: PlanQueueQuestion): PlanQueueQuestion {
  if (question.options.some((option) => option.id === 'skip') || question.options.length >= 4) return question;
  return { ...question, options: [...question.options, { id: 'skip', label: 'Leave this document for now' }] };
}

export function notReadyQuestion(documentPath: string, reason: string): PlanQueueQuestion {
  return {
    question: `${documentStem(documentPath)}: ${reason}. What should the queue do?`,
    options: [
      { id: 'proceed', label: 'Work on it anyway' },
      { id: 'skip', label: 'Leave it for now' },
    ],
  };
}

export function untriagedQuestion(documentPath: string): PlanQueueQuestion {
  return {
    question: `${documentStem(documentPath)}: the triage agent could not classify this document. Should a worker start on it?`,
    options: [
      { id: 'proceed', label: 'Start a worker on it' },
      { id: 'skip', label: 'Leave it for now' },
    ],
  };
}

export function buildQuestionsMessage(items: readonly PlanQueueItem[]): string {
  const asked = items.filter((item) => item.question);
  const lines = asked.map((item, index) => {
    const question = item.question!;
    const options = question.options.map((option) => `option_id "${option.id}": ${option.label}`).join('; ');
    return `${index + 1}. ${question.question}\n   item_id "${item.id}" — ${options}`;
  });
  return [
    `Plan Queue needs James to decide on ${asked.length} document(s) before they can start. The other documents are running.`,
    '',
    'Ask James each question below, using your structured-question tool if you have one, then record each answer with the plan_queue_answer tool (item_id, option_id). James can also answer in the Plan Queue panel.',
    '',
    ...lines,
  ].join('\n');
}

function needJamesLines(items: readonly PlanQueueItem[]): { real: string[]; policyGated: number } {
  const real: string[] = [];
  let policyGated = 0;
  for (const item of items) {
    const entries: PlanQueueNeedJamesEntry[] = item.verdict?.needJames ?? [];
    for (const entry of entries) {
      if (entry.classification === 'real') {
        real.push(`- ${documentStem(item.documentPath)}: ${entry.check} — ${entry.reason}`);
      } else if (entry.classification === 'policy-gated') {
        policyGated += 1;
      }
    }
  }
  return { real, policyGated };
}

export function buildRunSummaryMessage(run: PlanQueueRun, items: readonly PlanQueueItem[]): string {
  const count = (state: PlanQueueItem['state']) => items.filter((item) => item.state === state).length;
  const parked = items.filter((item) => item.state === 'parked');
  const lines = [
    `Plan Queue run ${run.id} (${run.kind}) ended: ${run.status}. Landed ${count('landed')}, parked ${parked.length}, skipped ${count('skipped')}.`,
  ];
  if (parked.length) {
    lines.push('', 'Parked (work is on the named branch; Resume, Land anyway or Discard in the Plan Queue panel):');
    for (const item of parked) {
      lines.push(`- ${documentStem(item.documentPath)}: ${item.parkReason ?? 'unknown'}${item.branchName ? ` on \`${item.branchName}\`` : ''}${item.detail ? ` — ${item.detail.slice(0, 300)}` : ''}`);
    }
  }
  if (run.kind === 'livetests') {
    const { real, policyGated } = needJamesLines(items);
    lines.push('', real.length ? 'Checks that genuinely need James:' : 'No check genuinely needs James.');
    lines.push(...real);
    if (policyGated) {
      lines.push(`${policyGated} further check(s) are policy-gated (blocked by a setting or approval rule, not by James himself); they are listed in the panel.`);
    }
  }
  return lines.join('\n');
}
