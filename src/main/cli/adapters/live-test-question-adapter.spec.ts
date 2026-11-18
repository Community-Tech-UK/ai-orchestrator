import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { PermissionRegistry } from '../../orchestration/permission-registry';
import { LiveTestQuestionAdapter } from './live-test-question-adapter';

interface Card { id: string; prompt: string; metadata: Record<string, unknown> }

function start() {
  const adapter = new LiveTestQuestionAdapter({ workingDirectory: '/tmp', instanceId: 'inst-live-test', yoloMode: true });
  const cards: Card[] = [];
  const resolved: { id: string; reason: string }[] = [];
  const said: string[] = [];
  const statuses: string[] = [];
  adapter.on('status', (status: string) => statuses.push(status));
  adapter.on('input_required', (card: Card) => cards.push(card));
  adapter.on('input_required_resolved', (event: { id: string; reason: string }) => resolved.push(event));
  adapter.on('output', (message: { type: string; content: string }) => { if (message.type === 'assistant') said.push(message.content); });
  return { adapter, cards, resolved, said, statuses };
}

describe('LiveTestQuestionAdapter', () => {
  beforeEach(() => PermissionRegistry._resetForTesting());
  afterEach(() => PermissionRegistry._resetForTesting());

  it('raises an exact-choice question card and consumes the typed choice', async () => {
    const { adapter, cards, said, statuses } = start();
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'ask me a question' });

    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(cards[0]!.metadata['type']).toBe('acp_elicitation');
    expect(cards[0]!.metadata['questions']).toEqual([
      { header: 'colour', question: 'Which colour should the fixture use?', multiSelect: false, options: [{ label: 'red' }, { label: 'blue' }] },
    ]);

    await adapter.sendRaw('blue');
    await turn;
    expect(said.join('')).toContain('Fixture answer received: {"colour":"blue"}');
    // The session must settle: no "busy" after the turn's final "idle", or it never leaves "busy".
    expect(statuses.at(-1)).toBe('idle');
    await adapter.terminate();
  });

  it('raises a free-text question card with no options and consumes the typed answer', async () => {
    const { adapter, cards, said } = start();
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'now ask a free-text question' });

    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(cards[0]!.metadata['type']).toBe('acp_elicitation');
    expect(cards[0]!.metadata['questions']).toEqual([
      { header: 'name', question: 'What should the fixture call you?', multiSelect: false, options: [] },
    ]);

    await adapter.sendRaw('Ada Lovelace');
    await turn;
    expect(said.join('')).toContain('Fixture answer received: {"name":"Ada Lovelace"}');
    await adapter.terminate();
  });

  it('raises a permission card, not a question, even for a YOLO session, and records the decision', async () => {
    const { adapter, cards, said } = start();
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'raise a permission card' });

    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(cards[0]!.metadata['type']).toBe('acp_permission_request');
    expect(cards[0]!.metadata['questions']).toBeUndefined();

    await adapter.sendRaw('Allow once');
    await turn;
    expect(said.join('')).toContain('Fixture permission outcome: selected (allow)');
    await adapter.terminate();
  });

  it('withdraws an unanswered question when the session is removed, and signals no process', async () => {
    const kill = vi.spyOn(process, 'kill');
    const { adapter, cards, resolved } = start();
    await adapter.spawn();
    expect(adapter.getPid()).toBeNull();
    const turn = adapter.sendMessage({ role: 'user', content: 'ask me a question' }).catch(() => undefined);
    await vi.waitFor(() => expect(cards).toHaveLength(1));

    await adapter.terminate();
    await turn;

    expect(resolved).toContainEqual({ id: cards[0]!.id, reason: expect.any(String) });
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it('rejects a typed answer when no question is waiting', async () => {
    const { adapter } = start();
    await adapter.spawn();
    await expect(adapter.sendRaw('red')).rejects.toMatchObject({ code: 'INPUT_REQUIRED_NOT_PENDING' });
    await adapter.terminate();
  });

  it('is available without any installed provider', async () => {
    const { adapter } = start();
    await expect(adapter.checkStatus()).resolves.toEqual({ available: true });
  });

  it('starts a fresh peer after a stop, so a respawn can ask again', async () => {
    const { adapter, cards } = start();
    await adapter.spawn();
    await adapter.terminate();
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'ask me a question' });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    await adapter.sendRaw('red');
    await turn;
    await adapter.terminate();
  });
});
