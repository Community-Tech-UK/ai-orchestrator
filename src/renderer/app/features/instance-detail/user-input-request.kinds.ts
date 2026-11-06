/**
 * Which waiting cards are an agent asking the person a question, and which are
 * an approval of an action. The message box may answer the first kind only:
 * typing "yes" must never be able to allow a tool.
 *
 * The rules themselves live in `shared/utils/input-request-types.ts`, because
 * main words the receipt a card leaves behind from the same classification.
 */

import type { AskUserQuestionEntry } from '../../../../shared/types/ask-user-question.types';
import {
  isApprovalRequest,
  isQuestionRequest,
  requestToolName,
} from '../../../../shared/utils/input-request-types';
import type { UserActionRequest } from './user-action-request.types';

/** True when the card approves an action (allow, deny, confirm, switch mode). */
export const isApproval: (request: UserActionRequest) => boolean = isApprovalRequest;

/** True when the message box may answer this card by typing. */
export const isAgentQuestion: (request: UserActionRequest) => boolean = isQuestionRequest;

/** The tool an approval is about, when the agent named one. */
export const toolNameOf: (request: UserActionRequest) => string | undefined = requestToolName;

/** The questions a card asks, as one list; undefined for a card that asks a single free-form thing. */
export function questionSlots(request: UserActionRequest): AskUserQuestionEntry[] | undefined {
  if (request.askQuestions?.length) return request.askQuestions;
  if (request.requestType === 'ask_questions' && request.questions?.length) {
    return request.questions.map((question) => ({ question, multiSelect: false, options: [] }));
  }
  return undefined;
}
