import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification-service';
import { registerInputRequiredNotifier } from './input-required-notifier';

function harness(options: { focused?: boolean; yoloMode?: boolean; automationId?: string } = {}) {
  const events = new EventEmitter();
  const instance = { id: 'a', displayName: 'Fix login', status: 'waiting_for_input',
    yoloMode: options.yoloMode, metadata: { automationId: options.automationId } };
  const manager = Object.assign(events, { getInstance: (id: string) => (id === 'a' ? instance : { ...instance, id }) });
  const desktop = { isSupported: () => true, show: vi.fn() };
  const notifications = new NotificationService({ desktop });
  const window = { isMainWindowFocused: () => options.focused ?? false, drawAttention: vi.fn() };
  const cleanup = registerInputRequiredNotifier({ instanceManager: manager as never, windowManager: window, notifications });
  return { events, notifications, desktop, window, cleanup, instance };
}
const request = { instanceId: 'a', requestId: 'r', prompt: 'Bash: PRIVATE_COMMAND /private/file',
  timestamp: 1, metadata: { type: 'deferred_permission', tool_name: 'Bash' } };
describe('input-required notifier', () => {
  it('names session and tool without prompt content; distinct sessions each deliver within cooldown', () => {
    const h = harness();
    h.events.emit('instance:input-required', request);
    h.events.emit('instance:input-required', { ...request, instanceId: 'b' });
    expect(h.desktop.show).toHaveBeenCalledTimes(2);
    expect(h.notifications.list()).toEqual([
      expect.objectContaining({ instanceId: 'a', title: 'Fix login needs your OK', body: 'Wants to use Bash', resolveKey: 'input:a:r' }),
      expect.objectContaining({ instanceId: 'b', title: 'Fix login needs your OK', body: 'Wants to use Bash', resolveKey: 'input:b:r' }),
    ]);
    expect(JSON.stringify(h.desktop.show.mock.calls)).not.toContain('PRIVATE_COMMAND');
    h.events.emit('instance:input-required-resolved', { instanceId: 'a', requestId: 'r' });
    expect(h.notifications.list()[0].resolvedAt).toBeDefined();
    expect(h.notifications.list()[1].resolvedAt).toBeUndefined();
    h.cleanup(); h.notifications.dispose();
    h.events.emit('instance:input-required', { ...request, requestId: 'after-cleanup' });
    expect(h.desktop.show).toHaveBeenCalledTimes(2);
  });
  it('resolves only the one session when independent connections reuse a request id', () => {
    const h = harness();
    h.events.emit('instance:input-required', { ...request, requestId: 'acp_permission:1' });
    h.events.emit('instance:input-required', { ...request, instanceId: 'b', requestId: 'acp_permission:1' });
    expect(h.notifications.list().map((r) => [r.instanceId, r.resolveKey])).toEqual([
      ['a', 'input:a:acp_permission:1'], ['b', 'input:b:acp_permission:1'],
    ]);
    h.events.emit('instance:input-required-resolved', { instanceId: 'a', requestId: 'acp_permission:1' });
    expect(h.notifications.list().find((r) => r.instanceId === 'a')?.resolvedAt).toBeDefined();
    expect(h.notifications.list().find((r) => r.instanceId === 'b')?.resolvedAt).toBeUndefined();
    h.events.emit('instance:input-required-resolved', { instanceId: 'b', requestId: 'acp_permission:1' });
    expect(h.notifications.list().every((r) => r.resolvedAt !== undefined)).toBe(true);
    h.cleanup(); h.notifications.dispose();
  });
  it('resolves an answered ordinary question when the turn leaves the waiting states', () => {
    const h = harness();
    h.events.emit('instance:input-required', { instanceId: 'a', requestId: 'question-1', prompt: 'Which option?',
      timestamp: 1, metadata: { type: 'ask_user_question' } });
    expect(h.notifications.list().filter(r => r.resolvedAt === undefined)).toHaveLength(1);
    // Answered AskUserQuestion turns emit no input-required-resolved event;
    // the turn completing past the prompt must still close the notification.
    for (const status of ['busy', 'idle']) {
      h.instance.status = status;
      h.events.emit('instance:state-changed', { instanceId: 'a', status });
    }
    expect(h.notifications.list().filter(r => r.resolvedAt === undefined && r.seenAt === undefined)).toHaveLength(0);
    h.cleanup(); h.notifications.dispose();
  });
  it('keeps a still-pending prompt open while the session only moves between waiting states', () => {
    const h = harness();
    h.events.emit('instance:input-required', { instanceId: 'a', requestId: 'question-2', prompt: 'Which option?',
      timestamp: 1, metadata: { type: 'ask_user_question' } });
    h.instance.status = 'waiting_for_permission';
    h.events.emit('instance:state-changed', { instanceId: 'a', status: 'waiting_for_permission' });
    expect(h.notifications.list()[0].resolvedAt).toBeUndefined();
    h.cleanup(); h.notifications.dispose();
  });
  it('resolves outstanding prompts when the session is removed', () => {
    const h = harness();
    h.events.emit('instance:input-required', { instanceId: 'a', requestId: 'question-3', prompt: 'Which option?',
      timestamp: 1, metadata: { type: 'ask_user_question' } });
    h.events.emit('instance:removed', 'a');
    expect(h.notifications.list()[0].resolvedAt).toBeDefined();
    h.cleanup(); h.notifications.dispose();
  });
  it.each([{ focused: true }, { yoloMode: true }, { automationId: 'automation' }])('skips foreground and unattended prompts: %j', options => {
    const h = harness(options); h.events.emit('instance:input-required', request);
    expect(h.desktop.show).not.toHaveBeenCalled(); expect(h.window.drawAttention).not.toHaveBeenCalled(); h.cleanup();
  });
  it.each([
    ['acp_permission_request', { toolName: 'Read' }, 'OK', 'Wants to use Read'],
    ['ask_user_question', {}, 'answer', ''],
    ['mcp_elicitation', {}, 'answer', ''],
    ['unknown', { tool_name: '/private/file' }, 'you', ''],
  ] as const)('classifies %s without leaking arbitrary metadata', (type, metadata, suffix, body) => {
    const h = harness();
    h.events.emit('instance:input-required', { ...request, metadata: { ...metadata, type } });
    expect(h.notifications.list()[0]).toMatchObject({ title: `Fix login needs ${suffix === 'you' ? 'you' : 'your ' + suffix}`, body });
    h.cleanup(); h.notifications.dispose();
  });
});
