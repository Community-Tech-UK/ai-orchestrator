import { describe, expect, it, vi } from 'vitest';
import {
  UserInputRequestRegistry,
  type QuestionCardHandle,
  type QuestionOfferResult,
} from './user-input-request.registry';

function handle(
  requestId: string,
  overrides: Partial<QuestionCardHandle> = {},
  result: QuestionOfferResult = 'answered',
): QuestionCardHandle & { answer: ReturnType<typeof vi.fn> } {
  return {
    requestId,
    instanceId: 'inst-1',
    createdAt: 1,
    answer: vi.fn(async () => result),
    ...overrides,
  } as QuestionCardHandle & { answer: ReturnType<typeof vi.fn> };
}

describe('UserInputRequestRegistry', () => {
  it('has nothing to say when no question is waiting', async () => {
    expect(await new UserInputRequestRegistry().offer('inst-1', 'hello')).toBe('not-applicable');
  });

  it('leaves blank text alone', async () => {
    const registry = new UserInputRequestRegistry();
    const card = handle('r1');
    registry.replace('owner', [card]);
    expect(await registry.offer('inst-1', '   ')).toBe('not-applicable');
    expect(card.answer).not.toHaveBeenCalled();
  });

  it('hands the trimmed text to the waiting question and returns what it says', async () => {
    const registry = new UserInputRequestRegistry();
    const card = handle('r1', {}, 'partial');
    registry.replace('owner', [card]);
    expect(await registry.offer('inst-1', '  Bun  ')).toBe('partial');
    expect(card.answer).toHaveBeenCalledWith('Bun');
  });

  it('only answers questions for the session being typed into', async () => {
    const registry = new UserInputRequestRegistry();
    const other = handle('r1', { instanceId: 'inst-2' });
    registry.replace('owner', [other]);
    expect(await registry.offer('inst-1', 'Bun')).toBe('not-applicable');
    expect(other.answer).not.toHaveBeenCalled();
  });

  it('answers the oldest waiting question first', async () => {
    const registry = new UserInputRequestRegistry();
    const newer = handle('newer', { createdAt: 20 });
    const older = handle('older', { createdAt: 10 });
    registry.replace('owner', [newer, older]);
    await registry.offer('inst-1', 'Bun');
    expect(older.answer).toHaveBeenCalledTimes(1);
    expect(newer.answer).not.toHaveBeenCalled();
  });

  it('forgets a question when its card closes (timeout, session closed, answered elsewhere)', async () => {
    const registry = new UserInputRequestRegistry();
    const card = handle('r1');
    registry.replace('owner', [card]);
    registry.replace('owner', []);
    expect(await registry.offer('inst-1', 'Bun')).toBe('not-applicable');
    expect(card.answer).not.toHaveBeenCalled();
  });

  it('keeps each list of cards separate, so one closing does not drop another', async () => {
    const registry = new UserInputRequestRegistry();
    const first = handle('r1', { instanceId: 'inst-1' });
    const second = handle('r2', { instanceId: 'inst-2' });
    registry.replace('card list A', [first]);
    registry.replace('card list B', [second]);
    registry.replace('card list A', []);
    expect(await registry.offer('inst-2', 'Bun')).toBe('answered');
    expect(second.answer).toHaveBeenCalledTimes(1);
  });

  it('refuses a second reply while the first is still being delivered', async () => {
    const registry = new UserInputRequestRegistry();
    let finish: (result: QuestionOfferResult) => void = () => undefined;
    const card = handle('r1');
    card.answer.mockImplementationOnce(() => new Promise<QuestionOfferResult>((resolve) => { finish = resolve; }));
    registry.replace('owner', [card]);

    const first = registry.offer('inst-1', 'Bun');
    expect(await registry.offer('inst-1', 'Bun again')).toBe('busy');
    expect(card.answer).toHaveBeenCalledTimes(1);

    finish('answered');
    expect(await first).toBe('answered');
    expect(await registry.offer('inst-1', 'third try')).toBe('answered');
    expect(card.answer).toHaveBeenCalledTimes(2);
  });

  describe('handleComposerText', () => {
    const composer = (text: string) => {
      const state = { text, cleared: 0 };
      return {
        state,
        hooks: { current: () => state.text, clear: () => { state.cleared++; state.text = ''; } },
      };
    };

    it.each(['answered', 'partial'] as const)('clears the box once the text was taken (%s)', async (result) => {
      const registry = new UserInputRequestRegistry();
      registry.replace('owner', [handle('r1', {}, result)]);
      const box = composer('Bun');
      expect(await registry.handleComposerText('inst-1', 'Bun', box.hooks)).toBe(true);
      expect(box.state.cleared).toBe(1);
    });

    it.each(['failed', 'busy'] as const)('keeps the text but still holds back the send (%s)', async (result) => {
      const registry = new UserInputRequestRegistry();
      registry.replace('owner', [handle('r1', {}, result)]);
      const box = composer('Bun');
      expect(await registry.handleComposerText('inst-1', 'Bun', box.hooks)).toBe(true);
      expect(box.state.cleared).toBe(0);
    });

    it('lets the caller send the text itself when no question wants it', async () => {
      const registry = new UserInputRequestRegistry();
      const box = composer('Bun');
      expect(await registry.handleComposerText('inst-1', 'Bun', box.hooks)).toBe(false);
      expect(box.state.cleared).toBe(0);
    });

    it('does not clear text the person has changed while the answer was on its way', async () => {
      const registry = new UserInputRequestRegistry();
      registry.replace('owner', [handle('r1')]);
      const box = composer('Bun');
      const pending = registry.handleComposerText('inst-1', 'Bun', box.hooks);
      box.state.text = 'something new';
      expect(await pending).toBe(true);
      expect(box.state.cleared).toBe(0);
      expect(box.state.text).toBe('something new');
    });
  });

  it('reports a failed delivery instead of losing the text when a card throws', async () => {
    const registry = new UserInputRequestRegistry();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const card = handle('r1', { answer: vi.fn(async () => { throw new Error('boom'); }) });
    registry.replace('owner', [card]);
    expect(await registry.offer('inst-1', 'Bun')).toBe('failed');
    expect(await registry.offer('inst-1', 'Bun')).toBe('failed');
    error.mockRestore();
  });
});
