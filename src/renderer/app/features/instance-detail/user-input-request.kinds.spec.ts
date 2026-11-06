import { describe, expect, it } from 'vitest';
import { isAutoHandledByYolo } from '../../../../shared/utils/input-request-types';
import { isAgentQuestion, isApproval, questionSlots, toolNameOf } from './user-input-request.kinds';
import { shouldClearInputRequiredForYolo } from './user-action-request.rules';
import type { UserActionRequest } from './user-action-request.types';

function request(overrides: Partial<UserActionRequest>): UserActionRequest {
  return {
    id: 'r1',
    instanceId: 'i1',
    requestType: 'input_required',
    title: 'Title',
    message: 'Message',
    createdAt: 1,
    ...overrides,
  };
}

const input = (metadata: UserActionRequest['permissionMetadata'], extra: Partial<UserActionRequest> = {}) =>
  request({ requestType: 'input_required', permissionMetadata: metadata, ...extra });

describe('isAgentQuestion', () => {
  it('accepts the cards where an agent is asking the person something', () => {
    expect(isAgentQuestion(input({ type: 'ask_user_question' }, {
      askQuestions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }] }],
    }))).toBe(true);
    expect(isAgentQuestion(input({ type: 'acp_elicitation', transport: 'acp' }))).toBe(true);
    expect(isAgentQuestion(input({ type: 'mcp_elicitation' }))).toBe(true);
    expect(isAgentQuestion(request({ requestType: 'ask_questions', questions: ['Why?'] }))).toBe(true);
    expect(isAgentQuestion(request({
      requestType: 'select_option',
      options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
    }))).toBe(true);
  });

  it.each([
    'permission_denial',
    'deferred_permission',
    'codex_mcp_approval',
    'acp_permission_request',
  ])('never accepts a %s approval', (type) => {
    expect(isAgentQuestion(input({ type }))).toBe(false);
    expect(isApproval(input({ type }))).toBe(true);
  });

  it('never accepts a secret card, whatever it is asking for', () => {
    expect(isAgentQuestion(request({
      requestType: 'secret_required',
      secretRequest: { name: 'token', label: 'Token', purpose: 'Install' },
    }))).toBe(false);
  });

  it('never accepts an orchestrator approval', () => {
    for (const requestType of ['confirm', 'approve_action', 'switch_mode'] as const) {
      expect(isAgentQuestion(request({ requestType }))).toBe(false);
      expect(isApproval(request({ requestType }))).toBe(true);
    }
  });

  it('keeps the orchestrator tool-permission picker out, because it is an approval in a choice card', () => {
    const options = [
      { id: 'allow_once', label: 'Allow once (Recommended)' },
      { id: 'deny_once', label: 'Deny once' },
    ];
    expect(isAgentQuestion(request({ requestType: 'select_option', options }))).toBe(false);
    expect(isApproval(request({ requestType: 'select_option', options }))).toBe(true);
    expect(isAgentQuestion(request({
      requestType: 'select_option',
      options: [{ id: 'x', label: 'Open the file' }],
      context: { suppressInjectResponse: true, permission: { scope: 'tool_use', resource: 'read_file' } },
    }))).toBe(false);
  });

  it('refuses a card type it does not know, so a new kind of approval cannot slip through', () => {
    expect(isAgentQuestion(input({ type: 'some_future_prompt' }))).toBe(false);
    expect(isAgentQuestion(input(undefined))).toBe(false);
  });

  it('refuses an elicitation that wants a link opened rather than words typed', () => {
    expect(isAgentQuestion(input({ type: 'acp_elicitation', mode: 'url' }))).toBe(false);
    expect(isAgentQuestion(input({ type: 'acp_elicitation', mode: 'form' }))).toBe(true);
  });

  it('refuses choice and question cards with nothing to answer', () => {
    expect(isAgentQuestion(request({ requestType: 'select_option', options: [] }))).toBe(false);
    expect(isAgentQuestion(request({ requestType: 'ask_questions', questions: [] }))).toBe(false);
  });
});

describe('toolNameOf', () => {
  it('reads the tool from whichever field the provider used', () => {
    expect(toolNameOf(input({ type: 'deferred_permission', tool_name: 'Bash' }))).toBe('Bash');
    expect(toolNameOf(input({ type: 'codex_mcp_approval', toolName: 'update_automation' }))).toBe('update_automation');
    expect(toolNameOf(request({
      requestType: 'select_option',
      context: { permission: { scope: 'tool_use', resource: 'read_file' } },
    }))).toBe('read_file');
  });

  it('returns nothing when no tool was named', () => {
    expect(toolNameOf(input({ type: 'acp_elicitation' }))).toBeUndefined();
    expect(toolNameOf(input({ type: 'deferred_permission', tool_name: '   ' }))).toBeUndefined();
  });
});

describe('the YOLO rule main shares with this window', () => {
  it('matches the window\'s own rule for every kind of request', () => {
    const types = [
      undefined, 'permission_denial', 'deferred_permission', 'codex_mcp_approval', 'acp_permission_request',
      'ask_user_question', 'acp_elicitation', 'mcp_elicitation', 'secret_required', 'some_future_prompt',
    ];
    const requestTypes: UserActionRequest['requestType'][] = [
      'input_required', 'ask_questions', 'select_option', 'confirm', 'approve_action', 'switch_mode', 'secret_required',
    ];
    for (const requestType of requestTypes) {
      for (const type of types) {
        const candidate = request({ requestType, permissionMetadata: type ? { type } : undefined });
        expect(isAutoHandledByYolo(candidate), `${requestType}/${type}`).toBe(shouldClearInputRequiredForYolo(candidate));
      }
    }
  });
});

describe('questionSlots', () => {
  it('returns structured questions as they are', () => {
    const askQuestions = [{ question: 'Which?', multiSelect: true, options: [{ label: 'A' }] }];
    expect(questionSlots(input({ type: 'ask_user_question' }, { askQuestions }))).toBe(askQuestions);
  });

  it('turns plain orchestrator questions into free-text slots', () => {
    expect(questionSlots(request({ requestType: 'ask_questions', questions: ['One?', 'Two?'] }))).toEqual([
      { question: 'One?', multiSelect: false, options: [] },
      { question: 'Two?', multiSelect: false, options: [] },
    ]);
  });

  it('returns nothing for a card with no questions list', () => {
    expect(questionSlots(input({ type: 'acp_elicitation' }))).toBeUndefined();
  });
});
