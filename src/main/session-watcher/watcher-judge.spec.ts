import { existsSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_MODELS, CLAUDE_PRICING_MODELS } from '../../shared/types/provider.types';
import { buildClaudeCliArgs } from '../cli/adapters/claude-cli-argv-builder';
import { getAdapterGuidanceBlocks, withBrowserGatewaySystemPrompt } from '../cli/adapters/adapter-spawn-helpers';
import { QUALIFIED_WATCHER_JUDGE_MODEL, watcherJudgeSpawnOptions, watcherJudgeWorkingDirectory } from './watcher-judge-options';

const routed = vi.hoisted(() => ({ attach: vi.fn(), createAdapter: vi.fn(), record: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({ attachProviderRoutes: routed.attach }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: routed.createAdapter }) }));
vi.mock('../providers/automation-provider-exclusions', () => ({ isProviderExcludedFromAutomation: () => false }));
vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall: routed.record }));

describe('the session watcher judge', () => {
  it('is pinned to the exact model that was measured, not to a moving alias', () => {
    expect(QUALIFIED_WATCHER_JUDGE_MODEL).toBe(CLAUDE_PRICING_MODELS.HAIKU_55);
    expect(QUALIFIED_WATCHER_JUDGE_MODEL).not.toBe(CLAUDE_MODELS.HAIKU);
    expect(QUALIFIED_WATCHER_JUDGE_MODEL).toMatch(/^claude-haiku-\d/);
  });

  it('runs as a plain completion in an empty folder, with our prompt in place of the default', () => {
    const options = watcherJudgeSpawnOptions('Judge this stop.');
    expect(options).toMatchObject({
      model: QUALIFIED_WATCHER_JUDGE_MODEL, systemPrompt: 'Judge this stop.', systemPromptMode: 'replace',
      plainCompletion: true, yoloMode: false, timeout: 60_000,
    });
    expect(options.maxBudgetUsd).toBeGreaterThan(0);
    expect(options.workingDirectory).toBe(watcherJudgeWorkingDirectory());
    expect(existsSync(options.workingDirectory)).toBe(true);
    expect(readdirSync(options.workingDirectory)).toEqual([]);
  });

  it('reaches the Claude CLI with no tools, no MCP servers and none of the user\'s settings', () => {
    const args = buildClaudeCliArgs({
      spawnOptions: watcherJudgeSpawnOptions('Judge this stop.'), sessionId: null, excludeDynamicSectionsSupported: null,
      cliVersion: '2.1.300', disallowedToolsOverride: null, shouldUseNativeResume: false, shouldUsePermissionHook: true,
      subagentWaitingRuleOptIn: true, materializeInlineJsonArg: (value: string) => value,
    });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--model') + 1]).toBe(QUALIFIED_WATCHER_JUDGE_MODEL);
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Judge this stop.');
    expect(args).toContain('--strict-mcp-config');
    for (const forbidden of ['acceptEdits', '--allowedTools', '--settings', '--mcp-config', '--dangerously-skip-permissions']) {
      expect(args).not.toContain(forbidden);
    }
  });

  it('runs on the pinned model or not at all, whatever backup model and debug log the user\'s settings ask for', () => {
    // The Claude adapter fills these two in from the settings `claudeFallbackModel` and `claudeCliDebugLogging`.
    const args = buildClaudeCliArgs({
      spawnOptions: { ...watcherJudgeSpawnOptions('Judge this stop.'), fallbackModel: 'some-other-model', debugLogging: true },
      sessionId: null, excludeDynamicSectionsSupported: null, cliVersion: '2.1.300', disallowedToolsOverride: null,
      shouldUseNativeResume: false, shouldUsePermissionHook: true, subagentWaitingRuleOptIn: true,
      materializeInlineJsonArg: (value: string) => value,
    });
    expect(args.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(args[args.indexOf('--model') + 1]).toBe(QUALIFIED_WATCHER_JUDGE_MODEL);
    for (const forbidden of ['--fallback-model', 'some-other-model', '--debug']) expect(args).not.toContain(forbidden);
  });

  it('keeps its prompt exactly as written through the app\'s adapter path, which adds guidance to every other call', () => {
    const judge = watcherJudgeSpawnOptions('Judge this stop.');
    expect(getAdapterGuidanceBlocks(judge)).toEqual([]);
    expect(withBrowserGatewaySystemPrompt(judge)).toBe(judge);
    // The same options without the plain-completion mark do get guidance appended: the check above is not vacuous.
    const ordinary = withBrowserGatewaySystemPrompt({ ...judge, plainCompletion: false });
    expect(ordinary.systemPrompt).not.toBe('Judge this stop.');
    expect(ordinary.systemPrompt?.startsWith('Judge this stop.')).toBe(true);
  });

  describe('the call itself', () => {
    beforeEach(() => { routed.attach.mockReset(); routed.createAdapter.mockReset(); routed.record.mockReset(); });

    it('hands the shared options to the account router and the adapter, and returns the model\'s text', async () => {
      const { ClaudeOneShotWatcherJudge } = await import('./watcher-judge');
      routed.attach.mockImplementation(async (_cli: string, options: unknown) => ({ ...(options as object), routed: true }));
      const sendMessage = vi.fn().mockResolvedValue({ content: '{"verdict":"finished"}', usage: { inputTokens: 10 } });
      routed.createAdapter.mockReturnValue({ sendMessage, terminate: vi.fn().mockResolvedValue(undefined), on: vi.fn(), off: vi.fn() });
      const reply = await new ClaudeOneShotWatcherJudge().judge({ system: 'SYS', user: 'USER' }, 'inst-1', new AbortController().signal);
      expect(routed.attach).toHaveBeenCalledWith('claude', expect.objectContaining({ plainCompletion: true, systemPrompt: 'SYS', model: QUALIFIED_WATCHER_JUDGE_MODEL }), 'internal', { instanceId: 'inst-1' });
      expect(routed.createAdapter).toHaveBeenCalledWith({ cliType: 'claude', options: expect.objectContaining({ plainCompletion: true, routed: true }) });
      expect(sendMessage).toHaveBeenCalledWith({ role: 'user', content: 'USER' });
      expect(reply).toMatchObject({ raw: '{"verdict":"finished"}', provider: 'claude', model: QUALIFIED_WATCHER_JUDGE_MODEL });
      expect(routed.record).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'aux:sessionWatch', outcome: 'success' }));
    });

    it('stops the adapter and rejects when the call is aborted', async () => {
      const { ClaudeOneShotWatcherJudge } = await import('./watcher-judge');
      routed.attach.mockImplementation(async (_cli: string, options: unknown) => options);
      const terminate = vi.fn().mockResolvedValue(undefined);
      let fail!: (error: Error) => void;
      const sendMessage = vi.fn(() => new Promise((_resolve, reject) => { fail = reject; }));
      routed.createAdapter.mockReturnValue({ sendMessage, terminate, on: vi.fn(), off: vi.fn() });
      const controller = new AbortController();
      const pending = new ClaudeOneShotWatcherJudge().judge({ system: 'SYS', user: 'USER' }, 'inst-1', controller.signal);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
      controller.abort();
      expect(terminate).toHaveBeenCalledWith(false);
      fail(new Error('killed'));
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
