/**
 * Pure helpers for generic `input_required` cards (ACP permission requests,
 * ACP and MCP elicitations, AskUserQuestion). Split out of
 * user-action-request.component.ts to keep that file under its size ceiling.
 */

import type { IpcFacadeService } from '../../core/services/ipc';
import type { UserChoice } from '../../../../shared/utils/request-outcome';
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
  return ['INPUT_REQUIRED_NOT_PENDING', 'USER_ACTION_NOT_PENDING'].includes(String((result as { error?: { code?: unknown } })?.error?.code));
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

/** Optional question-only receipt facts travel separately from permission decisions. */
export function respondToQuestion(
  ipc: Pick<IpcFacadeService, 'respondToInputRequired'>,
  request: UserActionRequest,
  text: string,
  choice?: UserChoice,
) {
  const key = isAcpInputRequired(request) ? request.id : undefined;
  const receipt = choice?.kind === 'skipped' ? { kind: 'skipped' as const }
    : choice?.kind === 'answered' ? { kind: 'answered' as const, summary: choice.answer.slice(0, 2000) } : undefined;
  return receipt
    ? ipc.respondToInputRequired(request.instanceId, request.id, text, key, undefined, undefined, undefined, undefined, receipt)
    : ipc.respondToInputRequired(request.instanceId, request.id, text, key);
}

const ACP_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: typeof ACP_KINDS[number];
  tone: 'allow' | 'reject';
  lasting: boolean;
}

export function acpPermissionOptions(request: { permissionMetadata?: { type?: string; options?: unknown } }): AcpPermissionOption[] | null {
  const meta = request.permissionMetadata;
  if (meta?.type !== 'acp_permission_request' || !Array.isArray(meta.options) || !meta.options.length) return null;
  const options: AcpPermissionOption[] = [];
  const ids = new Set<string>();
  for (const raw of meta.options) {
    if (!raw || typeof raw !== 'object' || typeof raw.optionId !== 'string' || !raw.optionId.trim() || ids.has(raw.optionId)
      || typeof raw.name !== 'string' || !raw.name.trim() || !ACP_KINDS.includes(raw.kind)) return null;
    ids.add(raw.optionId);
    options.push({ optionId: raw.optionId, name: raw.name, kind: raw.kind, tone: raw.kind.startsWith('allow') ? 'allow' : 'reject', lasting: raw.kind.endsWith('_always') });
  }
  return options.sort((a, b) => ACP_KINDS.indexOf(a.kind) - ACP_KINDS.indexOf(b.kind));
}
