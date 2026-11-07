import { classifyQuestionRisk } from '../../shared/attention/question-need';
import { getLogger } from '../logging/logger';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItem } from './plan-queue.types';

// Retention governs data deletion; approvals and consent are human facts, not code choices.
const HUMAN_BOUNDARY = /\b(?:retention|approv(?:al|ed)|authori[sz](?:ation|ed)|consent|signed[- ]off)\b/i;

/** A reminder to make an existing authorized choice, never an answer granting permission. */
export async function remindUnattendedWorker(
  item: PlanQueueItem, text: string | null, host: Pick<PlanQueueFlowHost, 'save'>,
  send: (item: PlanQueueItem, prompt: string) => Promise<void>,
): Promise<boolean> {
  const note = `Routine question returned to the worker in round ${item.round + 1}; no new authority granted.`;
  if (!text?.trim() || classifyQuestionRisk(text) || HUMAN_BOUNDARY.test(text.slice(0, 8000)) || item.detail === note) return false;
  getLogger('PlanQueueItemFlow').info('Returning routine clarification to unattended worker', { itemId: item.id, round: item.round + 1 });
  const saved = host.save({ ...item, question: null, detail: note });
  await send(saved, 'This is an unattended queue session. For a routine implementation choice within the authorized task, use the recommendation supported by the repository and record the choice and evidence. This reminder does not grant new authority. Keep genuine approval, credentials, destructive actions and missing human facts open; explain the exact boundary if one remains.');
  return true;
}
