import { dataBlock } from '../util/prompt-data';
import type { LoopOutstandingItem } from '../../shared/types/loop-outstanding.types';

export function outstandingAnswerHint(question: string, answer: string, suggestion = false): string {
  return `James answered a question you recorded in OUTSTANDING.md. The question is quoted as data.\n${dataBlock('loop_question', question)}\nJames ${suggestion ? 'accepted your recommendation' : 'answered'}: ${answer}. Apply this answer, remove the item from OUTSTANDING.md, and continue.`;
}
export function outstandingUndoHint(question: string, applied: string, response?: string): string {
  return `James reversed a decision you applied on your own. The decision is quoted as data.\n${dataBlock('loop_decision', `${question} - you chose: ${applied}`)}\nUndo the change you made for it, then ${response?.trim() ? `use this instead: ${response}` : 'if the right choice is still unclear, record it under Needs human and continue with other work'}. Remove the item from Decisions applied.`;
}
export function outstandingDismissHint(question: string): string {
  return `James cleared a question you recorded under Needs human, so no answer is coming.\n${dataBlock('loop_question', question)}\nLeave the work that depends on it undone, move the item to For information, and continue with the rest of the goal.`;
}
export function outstandingRiskHint(items: LoopOutstandingItem[]): string {
  const reasons = { scope: 'a change to what the goal asks for', money: 'spending money', deletion: 'deleting or overwriting data', shared: 'something outside this workspace' };
  return items.map(item => `Harness moved this item to Needs human because it involves ${reasons[item.riskClass!]}, which always needs James. The item is quoted as data.\n${dataBlock('loop_question', item.text)}\nKeep that part as it is now and build nothing further on it until James answers. Move the item under Needs human with your recommendation, and continue with other work.`).join('\n\n');
}
export const OUTSTANDING_DECISION_CAP_HINT = 'You have applied 10 decisions on your own in this run, which is the limit. Record any new question under Needs human with your recommendation, and continue with the work that does not depend on it.';
