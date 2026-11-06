/**
 * Which waiting requests are an agent asking the person a question, and which
 * are an approval of an action.
 *
 * Main uses this to word the receipt a request leaves behind ("nothing ran" is
 * only true of an approval). The window uses it to decide what the message box
 * may answer: typing "yes" must never be able to allow a tool.
 *
 * Questions are an allowlist, not "everything that is not a known approval", so
 * a new kind of approval is refused as a question until someone decides it is one.
 */

/** The fields of a request these rules read. Both the window's card model and main's fit it. */
export interface RequestShape {
  requestType: string;
  options?: readonly { id: string }[];
  questions?: readonly string[];
  context?: Record<string, unknown>;
  permissionMetadata?: {
    type?: string;
    mode?: string;
    tool_name?: string;
    toolName?: string;
  };
}

const APPROVAL_TYPES = new Set([
  'permission_denial',
  'deferred_permission',
  'codex_mcp_approval',
  'acp_permission_request',
]);
const QUESTION_TYPES = new Set(['ask_user_question', 'acp_elicitation', 'mcp_elicitation']);
const APPROVAL_OPTION_ID = /^(allow|deny)_/;

/**
 * The orchestrator's own tool-permission picker arrives as a `select_option`
 * card (`OrchestrationHandler.handleCallTool`): an approval wearing a choice
 * card's clothes. It is marked in its context and uses allow_/deny_ option ids.
 */
function isToolPermissionChoice(request: RequestShape): boolean {
  const context = request.context;
  if (context?.['permission'] !== undefined || context?.['suppressInjectResponse'] === true) return true;
  const options = request.options ?? [];
  return options.length > 0 && options.every((option) => APPROVAL_OPTION_ID.test(option.id));
}

/** True when the request approves an action (allow, deny, confirm, switch mode). */
export function isApprovalRequest(request: RequestShape): boolean {
  switch (request.requestType) {
    case 'input_required': return APPROVAL_TYPES.has(request.permissionMetadata?.type ?? '');
    case 'select_option': return isToolPermissionChoice(request);
    case 'approve_action':
    case 'confirm':
    case 'switch_mode': return true;
    default: return false;
  }
}

/** True when the message box may answer this request by typing. */
export function isQuestionRequest(request: RequestShape): boolean {
  switch (request.requestType) {
    case 'ask_questions': return (request.questions?.length ?? 0) > 0;
    case 'select_option': return (request.options?.length ?? 0) > 0 && !isToolPermissionChoice(request);
    case 'input_required': {
      const metadata = request.permissionMetadata;
      // A link to open is not something to answer in words.
      return QUESTION_TYPES.has(metadata?.type ?? '') && metadata?.mode !== 'url';
    }
    default: return false;
  }
}

/** The tool an approval is about, when the agent named one. */
export function requestToolName(request: RequestShape): string | undefined {
  const metadata = request.permissionMetadata;
  const resource = request.context?.['permission'] as { resource?: unknown } | undefined;
  const name = metadata?.tool_name || metadata?.toolName || (typeof resource?.resource === 'string' ? resource.resource : '');
  return name.trim() || undefined;
}

/**
 * Prompts the window drops without showing once YOLO is on. A copy of the
 * window's own rule (`shouldClearInputRequiredForYolo`), kept here so main can
 * tell a request nobody saw from one that was shown; a spec keeps the two equal.
 */
export function isAutoHandledByYolo(request: RequestShape): boolean {
  const type = request.permissionMetadata?.type ?? '';
  return request.requestType === 'input_required'
    && type !== 'permission_denial'
    && type !== 'ask_user_question'
    && type !== 'acp_elicitation';
}
