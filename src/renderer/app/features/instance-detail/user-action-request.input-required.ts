/**
 * Pure helpers for generic `input_required` cards (ACP permission requests,
 * ACP and MCP elicitations, AskUserQuestion). Split out of
 * user-action-request.component.ts to keep that file under its size ceiling.
 */

import type { AskUserQuestionEntry } from '../../../../shared/types/ask-user-question.types';
import type { UserActionRequest } from './user-action-request.types';
import type { InputRequiredEvent } from '../../core/services/ipc/ipc-event-bus.service';
import { coerceSecretRequest } from './user-action-request.secret-card';

/**
 * ACP cards answer over `session/request_permission` / `elicitation/create`,
 * where a `cancel` reply has a defined meaning (outcome `cancelled`). Other
 * generic cards send the reply as plain input, so Cancel must not send text.
 */
export function isAcpInputRequired(request: UserActionRequest): boolean {
  return request.permissionMetadata?.transport === 'acp';
}

/**
 * The request was already settled (timed out, auto-approved, turn cancelled)
 * before this reply arrived, so the card is stale rather than failed.
 */
export function isInputRequiredNotPending(result: unknown): boolean {
  return (result as { error?: { code?: unknown } })?.error?.code === 'INPUT_REQUIRED_NOT_PENDING';
}

/**
 * Validate and normalize the structured `questions` array shipped on
 * AskUserQuestion `input_required` metadata. Returns undefined when nothing
 * actionable is present so the card falls back to the freeform text box.
 */
export function coerceAskQuestions(value: unknown): AskUserQuestionEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: AskUserQuestionEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const question = typeof obj['question'] === 'string' ? obj['question'] : '';
    const header = typeof obj['header'] === 'string' ? obj['header'] : undefined;
    const options = Array.isArray(obj['options'])
      ? obj['options']
          .filter(
            (opt): opt is { label: string; description?: string } =>
              !!opt && typeof opt === 'object' && typeof (opt as { label?: unknown }).label === 'string'
          )
          .map((opt) => ({
            label: opt.label,
            description: typeof opt.description === 'string' ? opt.description : undefined
          }))
      : [];
    if (!question && !header && options.length === 0) {
      continue;
    }
    entries.push({
      header,
      question: question || header || 'Please choose an option',
      multiSelect: obj['multiSelect'] === true,
      options
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/** Build the same actionable card for a live event and for a late-mounted panel. */
export function toInputRequiredRequest(payload: InputRequiredEvent): UserActionRequest {
  const metadata = payload.metadata as UserActionRequest['permissionMetadata'];
  const isPermissionPrompt = ['permission_denial', 'deferred_permission', 'codex_mcp_approval'].includes(metadata?.type ?? '');
  const askQuestions = metadata?.type === 'ask_user_question' || metadata?.type === 'acp_elicitation'
    ? coerceAskQuestions(payload.metadata?.['questions']) : undefined;
  const secretRequest = metadata?.type === 'secret_required' ? coerceSecretRequest(payload.metadata) : undefined;
  return {
    id: payload.requestId,
    instanceId: payload.instanceId,
    requestType: secretRequest ? 'secret_required' : 'input_required',
    title: secretRequest ? (secretRequest.label || 'Secure secret required')
      : askQuestions?.length ? 'Agent has a question'
        : isPermissionPrompt ? 'Permission Required' : 'Input Required',
    message: payload.prompt,
    createdAt: payload.timestamp,
    permissionMetadata: metadata,
    askQuestions,
    secretRequest,
  };
}
