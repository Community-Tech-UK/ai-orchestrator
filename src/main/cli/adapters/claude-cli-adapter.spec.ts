import { describe, expect, it, vi } from 'vitest';

// Mock logger to avoid side-effects from logging stack during tests.
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';
import { createClaudeAdapter } from './adapter-factory';

describe('ClaudeCliAdapter AskUserQuestion handling', () => {
  it('emits input_required when AskUserQuestion appears in assistant content tool_use blocks', () => {
    const adapter = new ClaudeCliAdapter();
    const onInputRequired = vi.fn();
    adapter.on('input_required', onInputRequired);
    const processCliMessage = (
      adapter as unknown as { processCliMessage: (message: unknown) => void }
    ).processCliMessage.bind(adapter);

    processCliMessage({
      type: 'assistant',
      timestamp: 123,
      message: {
        content: [
          { type: 'text', text: 'Now let me ask my first question:' },
          {
            type: 'tool_use',
            id: 'tool-ask-1',
            name: 'AskUserQuestion',
            input: {
              question: 'Which area should we prioritize first?',
              options: [{ label: 'Architecture' }, { label: 'UI polish' }],
            },
          },
        ],
      },
    });

    expect(onInputRequired).toHaveBeenCalledTimes(1);
    const payload = onInputRequired.mock.calls[0][0] as { prompt: string; metadata?: Record<string, unknown> };
    expect(payload.prompt).toContain('Which area should we prioritize first?');
    expect(payload.prompt).toContain('Architecture');
    expect(payload.prompt).toContain('UI polish');
    expect(payload.metadata?.['type']).toBe('ask_user_question');
  });

  it('deduplicates repeated AskUserQuestion events for the same tool_use_id', () => {
    const adapter = new ClaudeCliAdapter();
    const onInputRequired = vi.fn();
    adapter.on('input_required', onInputRequired);
    const processCliMessage = (
      adapter as unknown as { processCliMessage: (message: unknown) => void }
    ).processCliMessage.bind(adapter);

    const askMessage = {
      type: 'tool_use',
      timestamp: 456,
      tool: {
        id: 'tool-ask-2',
        name: 'AskUserQuestion',
        input: {
          question: 'Do you prefer tabs or sections?',
        },
      },
    };

    processCliMessage(askMessage);
    processCliMessage(askMessage);

    expect(onInputRequired).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCliAdapter context window seeding', () => {
  it('seeds the 1M context window before runtime metadata arrives', () => {
    const adapter = new ClaudeCliAdapter({ model: 'sonnet[1m]' });
    const onContext = vi.fn();
    adapter.on('context', onContext);
    const processCliMessage = (
      adapter as unknown as { processCliMessage: (message: unknown) => void }
    ).processCliMessage.bind(adapter);

    expect(adapter.getCapabilities().contextWindow).toBe(1000000);

    processCliMessage({
      type: 'assistant',
      timestamp: 789,
      message: {
        content: [{ type: 'text', text: 'Working...' }],
        usage: {
          input_tokens: 120,
          output_tokens: 30,
        },
      },
    });

    expect(onContext).toHaveBeenCalledWith(
      expect.objectContaining({
        used: 150,
        total: 1000000,
      })
    );
  });
});

describe('ClaudeCliAdapter reasoning effort', () => {
  function getBuildArgs(adapter: ClaudeCliAdapter): string[] {
    return (
      adapter as unknown as {
        buildArgs: (message: { role: 'user'; content: string }) => string[];
      }
    ).buildArgs({ role: 'user', content: 'test' });
  }

  it('passes mapped reasoning effort from the adapter factory to Claude CLI', () => {
    const adapter = createClaudeAdapter({ reasoningEffort: 'xhigh' });
    const args = getBuildArgs(adapter);
    const effortIndex = args.indexOf('--effort');

    expect(effortIndex).toBeGreaterThan(-1);
    expect(args[effortIndex + 1]).toBe('max');
  });

  it('clamps unsupported lower effort levels to Claude low', () => {
    const adapter = new ClaudeCliAdapter({ reasoningEffort: 'none' });
    const args = getBuildArgs(adapter);
    const effortIndex = args.indexOf('--effort');

    expect(effortIndex).toBeGreaterThan(-1);
    expect(args[effortIndex + 1]).toBe('low');
  });
});
