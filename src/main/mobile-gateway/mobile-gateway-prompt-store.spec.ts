import { describe, expect, it, vi } from 'vitest';
import { MobileGatewayPromptStore } from './mobile-gateway-prompt-store';

describe('MobileGatewayPromptStore copy', () => {
  it.each([['Bash', 'Needs your approval: Bash'], [undefined, 'Needs your approval']])
  ('publishes the canonical permission title with tool %s', (toolName, title) => {
    const deps = { broadcast: vi.fn(), scheduleSnapshotBroadcast: vi.fn(), sendPush: vi.fn() };
    const store = new MobileGatewayPromptStore(deps);
    store.handleInputRequired({ instanceId: 'session', requestId: 'request', prompt: 'Choose whether to allow this action.',
      metadata: { tool_name: toolName } });
    const prompt = store.get('request');
    expect(prompt).toMatchObject({ title, message: 'Choose whether to allow this action.', kind: 'permission' });
    expect(deps.broadcast).toHaveBeenCalledWith({ type: 'permission-prompt', data: prompt });
    expect(deps.sendPush).toHaveBeenCalledWith(prompt);
    store.handleInputRequiredResolved({ requestId: 'request' });
    expect(store.values()).toEqual([]);
  });

  it('publishes a question fallback and keeps the supplied request wording', () => {
    const store = new MobileGatewayPromptStore({ broadcast: vi.fn(), scheduleSnapshotBroadcast: vi.fn(), sendPush: vi.fn() });
    store.handleUserAction({ id: 'question', instanceId: 'session', requestType: 'ask_questions' });
    expect(store.get('question')).toMatchObject({ title: 'Needs your answer', message: 'This session needs your answer.' });
    store.handleUserAction({ id: 'question', instanceId: 'session', requestType: 'ask_questions', title: 'Which folder?', message: 'Choose a folder.' });
    expect(store.get('question')).toMatchObject({ title: 'Which folder?', message: 'Choose a folder.' });
  });
});
