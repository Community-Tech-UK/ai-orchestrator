import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/test', isPackaged: false } }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';

function feed(adapter: ClaudeCliAdapter, payload: Record<string, unknown>): void {
  (adapter as unknown as { handleStdout(chunk: Buffer): void })
    .handleStdout(Buffer.from(`${JSON.stringify(payload)}\n`));
}

function feedToolResult(adapter: ClaudeCliAdapter, content: string, isError = true): void {
  feed(adapter, {
    type: 'assistant',
    message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tool-approval', name: 'Bash', input: { command: 'pwd' } },
    ] },
  });
  feed(adapter, {
    type: 'user',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-approval', is_error: isError, content },
    ] },
  });
}

describe('Claude permission requests through the NDJSON stream', () => {
  it('surfaces a genuine approval-required error with the original tool context', () => {
    const adapter = new ClaudeCliAdapter({ yoloMode: false });
    const inputRequired = vi.fn();
    adapter.on('input_required', inputRequired);

    feedToolResult(adapter, 'This command requires approval');

    expect(inputRequired).toHaveBeenCalledOnce();
    expect(inputRequired).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('restart the session'),
      metadata: expect.objectContaining({
        type: 'permission_denial', tool_name: 'Bash', tool_use_id: 'tool-approval', full_path: 'pwd',
      }),
    }));
  });

  it.each([
    { yoloMode: true, isError: true, content: 'This command requires approval' },
    { yoloMode: false, isError: false, content: 'This command requires approval' },
    { yoloMode: false, isError: true, content: 'Exit code 1\nThis command requires approval' },
  ])('does not ask for an override for $content (yolo=$yoloMode, error=$isError)', ({ yoloMode, isError, content }) => {
    const adapter = new ClaudeCliAdapter({ yoloMode });
    const inputRequired = vi.fn();
    adapter.on('input_required', inputRequired);

    feedToolResult(adapter, content, isError);

    expect(inputRequired).not.toHaveBeenCalled();
  });

  it('keeps hook-deferred requests on the deferred approval path', () => {
    const adapter = new ClaudeCliAdapter({ yoloMode: false });
    const inputRequired = vi.fn();
    adapter.on('input_required', inputRequired);

    feed(adapter, {
      type: 'result', session_id: 'session-approval', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'tool-deferred', name: 'Bash', input: { command: 'pwd' } },
    });

    expect(inputRequired).toHaveBeenCalledOnce();
    expect(inputRequired).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        type: 'deferred_permission', tool_name: 'Bash', tool_input: { command: 'pwd' },
      }),
    }));
    expect(adapter.getDeferredToolUse()).toMatchObject({ toolUseId: 'tool-deferred' });
  });
});
