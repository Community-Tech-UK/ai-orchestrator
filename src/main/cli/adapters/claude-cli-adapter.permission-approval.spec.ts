import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';

function feed(adapter: ClaudeCliAdapter, message: unknown): void {
  (adapter as unknown as { handleStdout(chunk: Buffer): void }).handleStdout(
    Buffer.from(`${JSON.stringify(message)}\n`),
  );
}

function feedBashCall(adapter: ClaudeCliAdapter): void {
  feed(adapter, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool-approval', name: 'Bash', input: { command: 'pwd' } }] },
  });
}

function toolResult(content: string, isError = true): unknown {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-approval', is_error: isError, content }] },
  };
}

describe('Claude CLI approval-required tool results', () => {
  it('emits an actionable permission request with the original tool context', () => {
    const adapter = new ClaudeCliAdapter({ yoloMode: false });
    const requested = vi.fn();
    const status = vi.fn();
    adapter.on('input_required', requested);
    adapter.on('status', status);
    feedBashCall(adapter);

    feed(adapter, toolResult('This command requires approval'));

    expect(requested).toHaveBeenCalledTimes(1);
    expect(requested).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        type: 'permission_denial',
        tool_use_id: 'tool-approval',
        tool_name: 'Bash',
        action: 'bash',
        full_path: 'pwd',
      }),
    }));
    expect(status).toHaveBeenCalledWith('waiting_for_input');
  });

  it.each([
    { name: 'a successful tool result', content: 'This command requires approval', isError: false, yoloMode: false },
    { name: 'a YOLO session', content: 'This command requires approval', isError: true, yoloMode: true },
    { name: 'an executed command', content: 'Exit code 1\nThis command requires approval', isError: true, yoloMode: false },
    { name: 'quoted command output', content: 'compiler: This command requires approval', isError: true, yoloMode: false },
  ])('does not request approval for $name', ({ content, isError, yoloMode }) => {
    const adapter = new ClaudeCliAdapter({ yoloMode });
    const requested = vi.fn();
    adapter.on('input_required', requested);
    feedBashCall(adapter);

    feed(adapter, toolResult(content, isError));

    expect(requested).not.toHaveBeenCalled();
  });
});
