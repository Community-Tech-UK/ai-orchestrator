import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';

function makeHarness(yoloMode = false) {
  const adapter = new ClaudeCliAdapter({ yoloMode });
  const inputRequired = vi.fn();
  const status = vi.fn();
  adapter.on('input_required', inputRequired);
  adapter.on('status', status);
  const feed = (adapter as unknown as { processCliMessage(message: unknown): void })
    .processCliMessage.bind(adapter);
  const rememberRead = () => feed({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'example-read', name: 'Read', input: { file_path: '/example/file.txt' },
    }] },
  });
  const result = (content: string, isError = true, id: string | undefined = 'example-read') => feed({
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: id, is_error: isError, content,
    }] },
  });
  return { feed, rememberRead, result, inputRequired, status };
}

const refusal = "Claude requested permissions to read from /example/file.txt, but you haven't granted it yet.";

describe('Claude permission-denial cards', () => {
  it('keeps an ordinary Read error quoting a refusal out of the approval flow', () => {
    const harness = makeHarness();
    harness.rememberRead();
    harness.result('Read failed: page says "you are not allowed to do that".');
    expect(harness.inputRequired).not.toHaveBeenCalled();
    expect(harness.status).not.toHaveBeenCalledWith('waiting_for_input');
  });

  it('retains a real refusal with the authoritative tool name and path', () => {
    const harness = makeHarness();
    harness.rememberRead();
    harness.result(refusal);
    expect(harness.inputRequired).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      metadata: expect.objectContaining({
        type: 'permission_denial', tool_use_id: 'example-read', tool_name: 'Read',
        full_path: '/example/file.txt',
      }),
    }));
    expect(harness.status).toHaveBeenCalledWith('waiting_for_input');
  });

  it.each(['example-missing', undefined])('ignores refusal text without a known tool context (%s)', id => {
    const harness = makeHarness();
    harness.rememberRead();
    harness.feed({ type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: id, is_error: true, content: refusal,
    }] } });
    expect(harness.inputRequired).not.toHaveBeenCalled();
  });

  it('keeps successful results out of the approval flow even when they quote CLI text', () => {
    const harness = makeHarness();
    harness.rememberRead();
    harness.result(refusal, false);
    expect(harness.inputRequired).not.toHaveBeenCalled();
  });

  it('keeps auto-approve sessions out of the denial recovery flow', () => {
    const harness = makeHarness(true);
    harness.rememberRead();
    harness.result(refusal);
    expect(harness.inputRequired).not.toHaveBeenCalled();
  });
});
