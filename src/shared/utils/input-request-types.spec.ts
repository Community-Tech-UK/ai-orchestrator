import { describe, expect, it } from 'vitest';
import {
  isApprovalRequest,
  isAutoHandledByYolo,
  isQuestionRequest,
  requestToolName,
  type RequestShape,
} from './input-request-types';

const native = (type: string, extra: RequestShape['permissionMetadata'] = {}): RequestShape => ({
  requestType: 'input_required',
  permissionMetadata: { type, ...extra },
});

describe('isApprovalRequest', () => {
  it.each(['permission_denial', 'deferred_permission', 'codex_mcp_approval', 'acp_permission_request'])(
    'treats a %s request as an approval',
    (type) => {
      expect(isApprovalRequest(native(type))).toBe(true);
      expect(isQuestionRequest(native(type))).toBe(false);
    },
  );

  it('treats confirm-style cards as approvals', () => {
    for (const requestType of ['approve_action', 'confirm', 'switch_mode']) {
      expect(isApprovalRequest({ requestType })).toBe(true);
      expect(isQuestionRequest({ requestType })).toBe(false);
    }
  });

  it('sees the orchestrator tool picker as an approval wearing a choice card', () => {
    const byContext: RequestShape = {
      requestType: 'select_option',
      options: [{ id: 'a' }, { id: 'b' }],
      context: { permission: { resource: 'Bash' } },
    };
    const byOptionIds: RequestShape = {
      requestType: 'select_option',
      options: [{ id: 'allow_once' }, { id: 'deny_once' }],
    };
    for (const picker of [byContext, byOptionIds, { requestType: 'select_option', context: { suppressInjectResponse: true } }]) {
      expect(isApprovalRequest(picker)).toBe(true);
      expect(isQuestionRequest(picker)).toBe(false);
    }
  });

  it('never calls an unknown kind an approval or a question', () => {
    expect(isApprovalRequest(native('something_new'))).toBe(false);
    expect(isQuestionRequest(native('something_new'))).toBe(false);
    expect(isApprovalRequest({ requestType: 'secret_required' })).toBe(false);
    expect(isQuestionRequest({ requestType: 'secret_required' })).toBe(false);
  });
});

describe('isQuestionRequest', () => {
  it('accepts the agent question kinds', () => {
    for (const type of ['ask_user_question', 'acp_elicitation', 'mcp_elicitation']) {
      expect(isQuestionRequest(native(type))).toBe(true);
    }
    expect(isQuestionRequest({ requestType: 'ask_questions', questions: ['Which?'] })).toBe(true);
    expect(isQuestionRequest({ requestType: 'select_option', options: [{ id: 'a' }, { id: 'b' }] })).toBe(true);
  });

  it('needs something to ask or choose from', () => {
    expect(isQuestionRequest({ requestType: 'ask_questions', questions: [] })).toBe(false);
    expect(isQuestionRequest({ requestType: 'ask_questions' })).toBe(false);
    expect(isQuestionRequest({ requestType: 'select_option', options: [] })).toBe(false);
  });

  it('leaves a link to open out, because it is not answered in words', () => {
    expect(isQuestionRequest(native('acp_elicitation', { mode: 'url' }))).toBe(false);
    expect(isQuestionRequest(native('acp_elicitation', { mode: 'form' }))).toBe(true);
  });
});

describe('requestToolName', () => {
  it('reads the tool from the request, in the order the adapters name it', () => {
    expect(requestToolName(native('deferred_permission', { tool_name: 'Bash' }))).toBe('Bash');
    expect(requestToolName(native('codex_mcp_approval', { toolName: 'fetch' }))).toBe('fetch');
    expect(requestToolName({
      requestType: 'select_option', context: { permission: { resource: 'WebFetch' } },
    })).toBe('WebFetch');
  });

  it('returns nothing for a blank or missing name', () => {
    expect(requestToolName(native('deferred_permission', { tool_name: '   ' }))).toBeUndefined();
    expect(requestToolName({ requestType: 'confirm' })).toBeUndefined();
  });
});

describe('isAutoHandledByYolo', () => {
  it('covers prompts the window clears itself once YOLO is on', () => {
    for (const type of ['deferred_permission', 'codex_mcp_approval', 'acp_permission_request', 'mcp_elicitation']) {
      expect(isAutoHandledByYolo(native(type))).toBe(true);
    }
  });

  it('keeps denials and real questions on screen', () => {
    for (const type of ['permission_denial', 'ask_user_question', 'acp_elicitation']) {
      expect(isAutoHandledByYolo(native(type))).toBe(false);
    }
    expect(isAutoHandledByYolo({ requestType: 'ask_questions', questions: ['x'] })).toBe(false);
  });
});
