import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

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

  it('parses the real nested AskUserQuestion schema (questions[] with header/options)', () => {
    const adapter = new ClaudeCliAdapter();
    const onInputRequired = vi.fn();
    adapter.on('input_required', onInputRequired);
    const processCliMessage = (
      adapter as unknown as { processCliMessage: (message: unknown) => void }
    ).processCliMessage.bind(adapter);

    processCliMessage({
      type: 'assistant',
      timestamp: 321,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-ask-nested',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  header: 'Posts',
                  question: 'Which posts should I comment on?',
                  multiSelect: true,
                  options: [
                    { label: 'Robyn Ball', description: 'genuine confusion' },
                    { label: 'Janet Pearce', description: 'real question' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect(onInputRequired).toHaveBeenCalledTimes(1);
    const payload = onInputRequired.mock.calls[0][0] as { prompt: string };
    expect(payload.prompt).toContain('Which posts should I comment on?');
    expect(payload.prompt).toContain('Robyn Ball');
    expect(payload.prompt).toContain('Janet Pearce');
    expect(payload.prompt).toContain('genuine confusion');
    expect(payload.prompt).toContain('select one or more');
    expect(payload.prompt).not.toContain('Claude requested input via AskUserQuestion');
  });

  it('renders multiple AskUserQuestion entries from a single tool call', () => {
    const adapter = new ClaudeCliAdapter();
    const onInputRequired = vi.fn();
    adapter.on('input_required', onInputRequired);
    const processCliMessage = (
      adapter as unknown as { processCliMessage: (message: unknown) => void }
    ).processCliMessage.bind(adapter);

    processCliMessage({
      type: 'assistant',
      timestamp: 654,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-ask-multi',
            name: 'AskUserQuestion',
            input: {
              questions: [
                { header: 'Posts', question: 'Which posts?', options: [{ label: 'Robyn' }] },
                { header: 'Flow', question: 'Which posting flow?', options: [{ label: 'Approve each' }] },
              ],
            },
          },
        ],
      },
    });

    expect(onInputRequired).toHaveBeenCalledTimes(1);
    const payload = onInputRequired.mock.calls[0][0] as { prompt: string };
    expect(payload.prompt).toContain('Which posts?');
    expect(payload.prompt).toContain('Which posting flow?');
    expect(payload.prompt).toContain('Approve each');
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

  it('uses preceding assistant question text when AskUserQuestion input is empty', () => {
    const adapter = new ClaudeCliAdapter();
    const onInputRequired = vi.fn();
    adapter.on('input_required', onInputRequired);
    const processCliMessage = (
      adapter as unknown as { processCliMessage: (message: unknown) => void }
    ).processCliMessage.bind(adapter);

    processCliMessage({
      type: 'assistant',
      timestamp: 789,
      message: {
        content: [
          {
            type: 'text',
            text: [
              'I can continue in two ways.',
              '',
              'How would you like me to proceed on native coverage?',
            ].join('\n'),
          },
          {
            type: 'tool_use',
            id: 'tool-ask-empty',
            name: 'AskUserQuestion',
            input: {},
          },
        ],
      },
    });

    expect(onInputRequired).toHaveBeenCalledTimes(1);
    const payload = onInputRequired.mock.calls[0][0] as { prompt: string; metadata?: Record<string, unknown> };
    expect(payload.prompt).toBe('How would you like me to proceed on native coverage?');
    expect(payload.prompt).not.toContain('Claude requested input via AskUserQuestion');
    expect(payload.metadata?.['type']).toBe('ask_user_question');
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

describe('ClaudeCliAdapter --max-turns backstop', () => {
  function getBuildArgs(adapter: ClaudeCliAdapter): string[] {
    return (
      adapter as unknown as {
        buildArgs: (message: { role: 'user'; content: string }) => string[];
      }
    ).buildArgs({ role: 'user', content: 'test' });
  }

  it('passes --max-turns when maxTurns is set', () => {
    const adapter = new ClaudeCliAdapter({ workingDirectory: '/tmp/x', maxTurns: 100 });
    const args = getBuildArgs(adapter);
    const i = args.indexOf('--max-turns');

    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('100');
  });

  it('omits --max-turns when maxTurns is unset or non-positive', () => {
    expect(getBuildArgs(new ClaudeCliAdapter({ workingDirectory: '/tmp/x' }))).not.toContain('--max-turns');
    expect(getBuildArgs(new ClaudeCliAdapter({ workingDirectory: '/tmp/x', maxTurns: 0 }))).not.toContain('--max-turns');
  });

  it('flows maxTurns through the adapter factory', () => {
    const adapter = createClaudeAdapter({ workingDirectory: '/tmp/x', maxTurns: 42 });
    const args = getBuildArgs(adapter);
    const i = args.indexOf('--max-turns');

    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('42');
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

  // D2 (#6): loop cap wrap-up temporarily denies tool use for one send.
  it('merges the setDisallowedToolsOverride list per send and clears it on null', () => {
    const adapter = new ClaudeCliAdapter({
      workingDirectory: '/tmp/x',
      disallowedTools: ['SomeCallerTool'],
    });

    adapter.setDisallowedToolsOverride(['Bash', 'Edit', 'Write']);
    const withOverride = getDisallowed(getBuildArgs(adapter));
    expect(withOverride).toContain('Bash');
    expect(withOverride).toContain('Edit');
    expect(withOverride).toContain('Write');
    // Additive: existing restrictions survive the override.
    expect(withOverride).toContain('SomeCallerTool');
    expect(withOverride).toContain('CronCreate');

    adapter.setDisallowedToolsOverride(null);
    const cleared = getDisallowed(getBuildArgs(adapter));
    expect(cleared).not.toContain('Bash');
    expect(cleared).toContain('SomeCallerTool');
    expect(cleared).toContain('CronCreate');
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

describe('ClaudeCliAdapter Windows inline-JSON --mcp-config materialization', () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: string) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  afterEach(() => setPlatform(originalPlatform));

  const INLINE = '{"mcpServers":{"chrome-devtools":{"command":"cmd","args":["/c","npx","-y","chrome-devtools-mcp@1.2.0","--browserUrl","http://127.0.0.1:9222"]}}}';

  function mcpConfigArg(adapter: ClaudeCliAdapter): string {
    const args = (
      adapter as unknown as { buildArgs: (m: { role: 'user'; content: string }) => string[] }
    ).buildArgs({ role: 'user', content: '' });
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    return args[i + 1];
  }

  it('on win32, writes inline JSON to a temp file and passes the path (survives cmd.exe)', () => {
    setPlatform('win32');
    const adapter = new ClaudeCliAdapter({ mcpConfig: [INLINE] });
    const arg = mcpConfigArg(adapter);
    expect(arg.startsWith('{')).toBe(false); // not inline JSON
    expect(arg.endsWith('.json')).toBe(true); // a file path
    expect(readFileSync(arg, 'utf-8')).toBe(INLINE); // intact content
  });

  it('off-win32, passes inline JSON unchanged', () => {
    setPlatform('darwin');
    const adapter = new ClaudeCliAdapter({ mcpConfig: [INLINE] });
    expect(mcpConfigArg(adapter)).toBe(INLINE);
  });

  it('leaves a file-path mcp-config entry untouched on win32', () => {
    setPlatform('win32');
    const adapter = new ClaudeCliAdapter({ mcpConfig: ['C:\\cfg\\mcp.json'] });
    expect(mcpConfigArg(adapter)).toBe('C:\\cfg\\mcp.json');
  });
});

describe('ClaudeCliAdapter B7 transcript-verified resume', () => {
  const buildArgsOf = (adapter: ClaudeCliAdapter): string[] =>
    (adapter as unknown as {
      buildArgs: (m: { role: 'user'; content: string }) => string[];
    }).buildArgs({ role: 'user', content: '' });

  const tmpRoots: string[] = [];
  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('falls back to --session-id when no transcript exists for the cwd (B7)', () => {
    const adapter = new ClaudeCliAdapter({
      workingDirectory: '/tmp/aio-b7-missing-xyz',
      sessionId: 'sess-missing',
      resume: true,
    });
    const args = buildArgsOf(adapter);
    expect(args).toContain('--session-id');
    expect(args).not.toContain('--resume');
  });

  it('uses --resume when the transcript exists under the cwd-encoded project dir (B7)', () => {
    // Build the real transcript Claude would scan, under a throwaway cwd.
    const cwd = join(tmpdir(), `aio-b7-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const sessionId = `sess-${Math.floor(Math.random() * 1e9)}`;
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const projectDir = join(homedir(), '.claude', 'projects', encoded);
    tmpRoots.push(projectDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{"type":"summary"}\n');

    const adapter = new ClaudeCliAdapter({ workingDirectory: cwd, sessionId, resume: true });
    const args = buildArgsOf(adapter);
    expect(args).toContain('--resume');
    expect(args).toContain(sessionId);
    expect(args).not.toContain('--session-id');
  });

  it('reports a fresh-fallback resume proof when the transcript is missing (B7)', () => {
    const adapter = new ClaudeCliAdapter({
      workingDirectory: '/tmp/aio-b7-missing-proof',
      sessionId: 'sess-x',
      resume: true,
    });
    // Drive the same decision spawn() uses without launching a process.
    const decided = (adapter as unknown as { shouldUseNativeResume: () => boolean }).shouldUseNativeResume();
    expect(decided).toBe(false);
  });
});

describe('ClaudeCliAdapter rate_limit_event handling', () => {
  type OutputEvent = { type: string; content: string; metadata?: Record<string, unknown> };

  function makeAdapter() {
    const adapter = new ClaudeCliAdapter();
    const outputs: OutputEvent[] = [];
    adapter.on('output', (o: OutputEvent) => outputs.push(o));
    const processCliMessage = (
      adapter as unknown as { processCliMessage: (message: unknown) => void }
    ).processCliMessage.bind(adapter);
    const getLastRateLimitInfo = (
      adapter as unknown as { getLastRateLimitInfo: () => { status?: string } | null }
    ).getLastRateLimitInfo.bind(adapter);
    return { adapter, outputs, processCliMessage, getLastRateLimitInfo };
  }

  it('records an allowed rate_limit_event without emitting a user-visible notice', () => {
    const { outputs, processCliMessage, getLastRateLimitInfo } = makeAdapter();

    processCliMessage({
      type: 'rate_limit_event',
      timestamp: 1,
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1782079200 },
    });

    expect(getLastRateLimitInfo()?.status).toBe('allowed'); // handled (not the unrecognized default)
    expect(outputs).toHaveLength(0); // steady state is quiet
  });

  it('surfaces a one-time notice when the status flips to throttled', () => {
    const { outputs, processCliMessage, getLastRateLimitInfo } = makeAdapter();

    processCliMessage({ type: 'rate_limit_event', timestamp: 1, rate_limit_info: { status: 'allowed' } });
    processCliMessage({
      type: 'rate_limit_event',
      timestamp: 2,
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1782079200 },
    });

    expect(getLastRateLimitInfo()?.status).toBe('rejected');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.type).toBe('system');
    expect(outputs[0]?.metadata?.['rateLimit']).toBe(true);
    expect(outputs[0]?.content).toContain('rate limit');

    // A repeat of the same throttled status must not spam another notice.
    processCliMessage({ type: 'rate_limit_event', timestamp: 3, rate_limit_info: { status: 'rejected' } });
    expect(outputs).toHaveLength(1);
  });
});
