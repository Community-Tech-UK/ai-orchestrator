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

import {
  ClaudeCliAdapter,
  helpAdvertisesExcludeDynamicSections,
  EXCLUDE_DYNAMIC_SECTIONS_FLAG,
} from './claude-cli-adapter';
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
    expect(args[effortIndex + 1]).toBe('xhigh');
  });

  it('passes max as a Claude CLI session-only effort', () => {
    const adapter = createClaudeAdapter({ reasoningEffort: 'max' });
    const args = getBuildArgs(adapter);
    const effortIndex = args.indexOf('--effort');

    expect(effortIndex).toBeGreaterThan(-1);
    expect(args[effortIndex + 1]).toBe('max');
  });

  it('passes workflow as ultracode settings instead of an effort flag', () => {
    const adapter = createClaudeAdapter({ reasoningEffort: 'workflow' });
    const args = getBuildArgs(adapter);

    expect(args).not.toContain('--effort');
    const settingsIndex = args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(JSON.parse(args[settingsIndex + 1] ?? '{}')).toMatchObject({
      ultracode: true,
    });
  });

  it('clamps unsupported lower effort levels to Claude low', () => {
    const adapter = new ClaudeCliAdapter({ reasoningEffort: 'none' });
    const args = getBuildArgs(adapter);
    const effortIndex = args.indexOf('--effort');

    expect(effortIndex).toBeGreaterThan(-1);
    expect(args[effortIndex + 1]).toBe('low');
  });
});

describe('ClaudeCliAdapter host cloud-scheduler denylist', () => {
  function getBuildArgs(adapter: ClaudeCliAdapter): string[] {
    return (
      adapter as unknown as {
        buildArgs: (message: { role: 'user'; content: string }) => string[];
      }
    ).buildArgs({ role: 'user', content: 'test' });
  }

  function getDisallowed(args: string[]): string[] {
    const i = args.indexOf('--disallowedTools');
    return i === -1 ? [] : (args[i + 1] ?? '').split(',');
  }

  it('always denies CronCreate/RemoteTrigger even when no disallowedTools are wired (warm-start adapter)', () => {
    // A consumed warm-start adapter carries only { workingDirectory } — no disallowedTools.
    // The guarantee must still hold because enforcement lives in buildArgs.
    const adapter = new ClaudeCliAdapter({ workingDirectory: '/tmp/x' });
    const disallowed = getDisallowed(getBuildArgs(adapter));

    expect(disallowed).toContain('CronCreate');
    expect(disallowed).toContain('RemoteTrigger');
  });

  it('merges and dedupes with caller-supplied disallowedTools', () => {
    const adapter = new ClaudeCliAdapter({
      workingDirectory: '/tmp/x',
      disallowedTools: ['Bash', 'CronCreate'],
    });
    const disallowed = getDisallowed(getBuildArgs(adapter));

    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('CronCreate');
    expect(disallowed).toContain('RemoteTrigger');
    // CronCreate appears once despite being supplied by both sources.
    expect(disallowed.filter((t) => t === 'CronCreate')).toHaveLength(1);
  });

  it('does not block read-only cron tools (cleanup remains possible)', () => {
    const adapter = new ClaudeCliAdapter({ workingDirectory: '/tmp/x' });
    const disallowed = getDisallowed(getBuildArgs(adapter));

    expect(disallowed).not.toContain('CronList');
    expect(disallowed).not.toContain('CronDelete');
  });
});

describe('ClaudeCliAdapter deferred-permission tool_input', () => {
  function makeAdapter() {
    return new ClaudeCliAdapter();
  }

  function processCliMessage(adapter: ClaudeCliAdapter, message: unknown): void {
    (adapter as unknown as { processCliMessage: (m: unknown) => void })
      .processCliMessage(message);
  }

  it('carries tool_input from toolUseContexts when the assistant block was captured before deferral', () => {
    const adapter = makeAdapter();
    const onInputRequired = vi.fn();
    adapter.on('input_required', onInputRequired);

    // Simulate the assistant message that records the tool_use context.
    processCliMessage(adapter, {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tuid-1',
            name: 'Bash',
            input: { command: 'rm -rf /tmp/test' },
          },
        ],
      },
    });

    // Now simulate the result message with stop_reason: tool_deferred.
    processCliMessage(adapter, {
      type: 'result',
      stop_reason: 'tool_deferred',
      session_id: 'sess-abc',
      deferred_tool_use: {
        id: 'tuid-1',
        name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
      },
    });

    expect(onInputRequired).toHaveBeenCalledTimes(1);
    const payload = onInputRequired.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(payload.metadata?.['type']).toBe('deferred_permission');
    expect(payload.metadata?.['tool_input']).toEqual({ command: 'rm -rf /tmp/test' });
  });

  it('falls back to deferred_tool_use.input when toolUseContexts has no entry for the id', () => {
    const adapter = makeAdapter();
    const onInputRequired = vi.fn();
    adapter.on('input_required', onInputRequired);

    // No prior assistant message — toolUseContexts is empty.
    processCliMessage(adapter, {
      type: 'result',
      stop_reason: 'tool_deferred',
      session_id: 'sess-xyz',
      deferred_tool_use: {
        id: 'tuid-2',
        name: 'Bash',
        input: { command: 'echo hello' },
      },
    });

    expect(onInputRequired).toHaveBeenCalledTimes(1);
    const payload = onInputRequired.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(payload.metadata?.['type']).toBe('deferred_permission');
    expect(payload.metadata?.['tool_input']).toEqual({ command: 'echo hello' });
  });

  it('omits tool_input when neither toolUseContexts nor deferred.input provides a value', () => {
    const adapter = makeAdapter();
    const onInputRequired = vi.fn();
    adapter.on('input_required', onInputRequired);

    // deferred_tool_use with no input field — simulates a tool that has no arguments.
    processCliMessage(adapter, {
      type: 'result',
      stop_reason: 'tool_deferred',
      session_id: 'sess-empty',
      deferred_tool_use: {
        id: 'tuid-3',
        name: 'NoArgTool',
        // input is intentionally absent
      },
    });

    expect(onInputRequired).toHaveBeenCalledTimes(1);
    const payload = onInputRequired.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(payload.metadata?.['type']).toBe('deferred_permission');
    expect(Object.prototype.hasOwnProperty.call(payload.metadata, 'tool_input')).toBe(false);
  });
});

describe('helpAdvertisesExcludeDynamicSections (C1 remote-worker fix)', () => {
  it('detects the flag in a supporting CLI --help output', () => {
    expect(
      helpAdvertisesExcludeDynamicSections(
        'Options:\n  --version\n  --exclude-dynamic-system-prompt-sections  Move sections\n  --help',
      ),
    ).toBe(true);
  });

  it('returns false when an older CLI --help omits the flag', () => {
    expect(
      helpAdvertisesExcludeDynamicSections('Usage: claude [options]\n  --version\n  --help'),
    ).toBe(false);
  });
});

describe('ClaudeCliAdapter exclude-dynamic-sections capability gating', () => {
  function getBuildArgs(adapter: ClaudeCliAdapter): string[] {
    return (
      adapter as unknown as {
        buildArgs: (message: { role: 'user'; content: string }) => string[];
      }
    ).buildArgs({ role: 'user', content: 'test' });
  }
  function setSupport(adapter: ClaudeCliAdapter, value: boolean | null): void {
    (adapter as unknown as { excludeDynamicSectionsSupported: boolean | null })
      .excludeDynamicSectionsSupported = value;
  }

  it('includes the flag only when the CLI is confirmed to support it', () => {
    const adapter = createClaudeAdapter({});
    setSupport(adapter, true);
    expect(getBuildArgs(adapter)).toContain(EXCLUDE_DYNAMIC_SECTIONS_FLAG);
  });

  it('omits the flag when the CLI does NOT support it (older remote worker)', () => {
    const adapter = createClaudeAdapter({});
    setSupport(adapter, false);
    expect(getBuildArgs(adapter)).not.toContain(EXCLUDE_DYNAMIC_SECTIONS_FLAG);
  });

  it('omits the flag when support is unprobed (null) — safe default', () => {
    const adapter = createClaudeAdapter({});
    setSupport(adapter, null);
    expect(getBuildArgs(adapter)).not.toContain(EXCLUDE_DYNAMIC_SECTIONS_FLAG);
  });
});
