import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  buildClaudeCliArgs,
  buildClaudeSettingsOverlay,
  mapClaudeReasoningEffort,
  type BuildClaudeCliArgsInput,
} from './claude-cli-argv-builder';
import type { ClaudeCliSpawnOptions } from './claude-cli-adapter.types';
import { CLAUDE_SUBAGENT_WAITING_RULE } from './claude-subagent-policy';
import { readFileSync, statSync } from 'node:fs';
import { _setOutputCapSettingsReaderForTesting } from './claude-output-caps';

const detection = vi.hoisted(() => ({ peekCachedResult: vi.fn((): unknown => null) }));
vi.mock('../cli-detection', () => ({ getCliDetectionService: () => detection }));
// Every test starts with no configured cap and no cached CLI detection.
beforeEach(() => { _setOutputCapSettingsReaderForTesting(() => undefined); detection.peekCachedResult.mockReset().mockReturnValue(null); });
afterEach(() => { _setOutputCapSettingsReaderForTesting(null); });

/**
 * Extracted from `claude-cli-adapter.spec.ts`'s `buildArgs` coverage — these
 * cases exercise the argv-construction logic directly, against explicit
 * inputs, now that it no longer requires standing up an adapter instance.
 */
function baseInput(overrides: Partial<BuildClaudeCliArgsInput> = {}): BuildClaudeCliArgsInput {
  return {
    spawnOptions: {},
    sessionId: null,
    excludeDynamicSectionsSupported: null,
    cliVersion: null,
    disallowedToolsOverride: null,
    shouldUseNativeResume: false,
    shouldUsePermissionHook: false,
    materializeInlineJsonArg: (value: string) => value,
    ...overrides,
  };
}

describe('mapClaudeReasoningEffort', () => {
  it('maps low-tier synonyms to low', () => {
    expect(mapClaudeReasoningEffort('none')).toBe('low');
    expect(mapClaudeReasoningEffort('minimal')).toBe('low');
    expect(mapClaudeReasoningEffort('low')).toBe('low');
  });

  it('maps medium/high/xhigh/max straight through', () => {
    expect(mapClaudeReasoningEffort('medium')).toBe('medium');
    expect(mapClaudeReasoningEffort('high')).toBe('high');
    expect(mapClaudeReasoningEffort('xhigh')).toBe('xhigh');
    expect(mapClaudeReasoningEffort('max')).toBe('max');
  });

  it('returns undefined for workflow (not a CLI --effort value) and unset', () => {
    expect(mapClaudeReasoningEffort('workflow')).toBeUndefined();
    expect(mapClaudeReasoningEffort(undefined)).toBeUndefined();
  });
});

describe('buildClaudeSettingsOverlay', () => {
  it('returns undefined when nothing needs an overlay', () => {
    expect(buildClaudeSettingsOverlay({}, false)).toBeUndefined();
  });

  it('sets ultracode for workflow reasoning effort', () => {
    const overlay = buildClaudeSettingsOverlay({ reasoningEffort: 'workflow' }, false);
    expect(JSON.parse(overlay!)).toEqual({ ultracode: true });
  });

  it('sets fastMode when requested', () => {
    const overlay = buildClaudeSettingsOverlay({ fastMode: true }, false);
    expect(JSON.parse(overlay!)).toEqual({ fastMode: true });
  });

  it('only includes the defer hook when BOTH permissionHookEnabled and a hook path are set', () => {
    expect(buildClaudeSettingsOverlay({ permissionHookPath: '/hook.js' }, false)).toBeUndefined();
    const overlay = buildClaudeSettingsOverlay({ permissionHookPath: '/hook.js' }, true);
    const parsed = JSON.parse(overlay!);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain('/hook.js');
  });
});

describe('buildClaudeCliArgs', () => {
  it('makes the Claude reviewer read-only even when caller requests auto-approve', () => {
    const args=buildClaudeCliArgs(baseInput({spawnOptions:{readOnlyReview:true,yoloMode:true,allowedTools:['Bash','Write'],permissionHookPath:'/hook'},shouldUsePermissionHook:true}));
    expect(args).toContain('dontAsk');expect(args).toContain('--tools');expect(args).toContain('Read,Grep,Glob,ToolSearch,Skill');
    expect(args).not.toContain('--dangerously-skip-permissions');expect(args).not.toContain('--allowedTools');expect(args).not.toContain('acceptEdits');expect(args).not.toContain('--settings');
  });

  it('always includes the fixed stream-json flags', () => {
    const args = buildClaudeCliArgs(baseInput());
    expect(args.slice(0, 6)).toEqual([
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    ]);
  });

  it('adds --debug only when debug logging is on', () => {
    expect(buildClaudeCliArgs(baseInput())).not.toContain('--debug');
    expect(buildClaudeCliArgs(baseInput({ spawnOptions: { debugLogging: true } }))).toContain('--debug');
  });

  it('passes --dangerously-skip-permissions in YOLO mode and skips acceptEdits', () => {
    const args = buildClaudeCliArgs(baseInput({ spawnOptions: { yoloMode: true } }));
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('uses --permission-mode acceptEdits outside YOLO mode', () => {
    const args = buildClaudeCliArgs(baseInput({ spawnOptions: { yoloMode: false } }));
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('passes --resume and --fork-session together when native resume applies', () => {
    const args = buildClaudeCliArgs(baseInput({
      spawnOptions: { resume: true, forkSession: true },
      sessionId: 'sess-1',
      shouldUseNativeResume: true,
    }));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-1', '--fork-session']));
    expect(args).not.toContain('--session-id');
  });

  it('falls back to --session-id when native resume does not apply but a session id exists', () => {
    const args = buildClaudeCliArgs(baseInput({
      sessionId: 'sess-2',
      shouldUseNativeResume: false,
    }));
    expect(args).toEqual(expect.arrayContaining(['--session-id', 'sess-2']));
    expect(args).not.toContain('--resume');
  });

  it('always merges in the host cloud-scheduler denylist, plus caller and override tools, deduped', () => {
    const args = buildClaudeCliArgs(baseInput({
      spawnOptions: { disallowedTools: ['Bash'] },
      disallowedToolsOverride: ['Bash', 'WebFetch'],
    }));
    const idx = args.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const merged = args[idx + 1].split(',');
    expect(merged).toEqual(expect.arrayContaining(['Bash', 'WebFetch']));
    expect(new Set(merged).size).toBe(merged.length); // deduped
  });

  it('does not pass --system-prompt when resuming', () => {
    const args = buildClaudeCliArgs(baseInput({
      spawnOptions: { resume: true, systemPrompt: 'be helpful' },
      sessionId: 'sess-3',
    }));
    expect(args).not.toContain('--system-prompt');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('uses --append-system-prompt by default and --system-prompt for replace mode', () => {
    const appendArgs = buildClaudeCliArgs(baseInput({
      spawnOptions: { systemPrompt: 'be helpful' },
    }));
    expect(appendArgs).toEqual(expect.arrayContaining(['--append-system-prompt', 'be helpful']));

    const replaceArgs = buildClaudeCliArgs(baseInput({
      spawnOptions: { systemPrompt: 'be helpful', systemPromptMode: 'replace' },
    }));
    expect(replaceArgs).toEqual(expect.arrayContaining(['--system-prompt', 'be helpful']));
  });

  it('routes --settings and --json-schema and --mcp-config through the injected materializer', () => {
    const materialize = vi.fn((value: string) => `materialized:${value}`);
    const spawnOptions: ClaudeCliSpawnOptions = {
      fastMode: true,
      jsonSchema: '{"type":"object"}',
      mcpConfig: ['{"server":"a"}'],
    };
    const args = buildClaudeCliArgs(baseInput({ spawnOptions, materializeInlineJsonArg: materialize }));
    expect(args).toEqual(expect.arrayContaining(['--json-schema', 'materialized:{"type":"object"}']));
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', 'materialized:{"server":"a"}']));
    expect(materialize).toHaveBeenCalledWith(expect.stringContaining('fastMode'));
  });

  it('maps reasoning effort onto --effort', () => {
    const args = buildClaudeCliArgs(baseInput({ spawnOptions: { reasoningEffort: 'high' } }));
    expect(args).toEqual(expect.arrayContaining(['--effort', 'high']));
  });

  it('never passes a fallback model equal to the primary model', () => {
    const args = buildClaudeCliArgs(baseInput({
      spawnOptions: { model: 'claude-x', fallbackModel: 'claude-x' },
    }));
    expect(args).not.toContain('--fallback-model');
  });
  it('applies a finite spend cap only to a fresh print-mode session', () => {
    const fresh = buildClaudeCliArgs(baseInput({spawnOptions:{maxBudgetUsd:0.25}}));
    expect(fresh).toEqual(expect.arrayContaining(['--max-budget-usd','0.25']));
    expect(buildClaudeCliArgs(baseInput({spawnOptions:{maxBudgetUsd:0.25,resume:true}, sessionId:'s',shouldUseNativeResume:true}))).not.toContain('--max-budget-usd');
  });
  it.each([undefined, 0, -1, NaN, Infinity])('omits invalid or unset budget %s', maxBudgetUsd => {
    expect(buildClaudeCliArgs(baseInput({spawnOptions:{maxBudgetUsd}}))).not.toContain('--max-budget-usd');
  });

});


describe('Claude version gates', () => {
  it.each(['2.1.266', '2.1.267', null])('omits the cache flag at %s', cliVersion => {
    expect(buildClaudeCliArgs(baseInput({ cliVersion, excludeDynamicSectionsSupported: true,
      spawnOptions: { excludeDynamicSystemPromptSections: true } }))).not.toContain('--exclude-dynamic-system-prompt-sections');
  });
  it.each(['2.1.268', '2.1.296'])('includes the cache flag at %s only with help support', cliVersion => {
    const input = baseInput({ cliVersion, excludeDynamicSectionsSupported: true,
      spawnOptions: { yoloMode: true, excludeDynamicSystemPromptSections: true } });
    expect(buildClaudeCliArgs(input)).toContain('--exclude-dynamic-system-prompt-sections');
    expect(buildClaudeCliArgs({ ...input, excludeDynamicSectionsSupported: false })).not.toContain('--exclude-dynamic-system-prompt-sections');
  });
  it.each([['2.1.266', true], ['2.1.267', false], [null, false]] as const)('resume at %s carries overlay: %s', (cliVersion, carries) => {
    const args = buildClaudeCliArgs(baseInput({ cliVersion, shouldUseNativeResume: true, sessionId: 'stub-session',
      spawnOptions: { resume: true, systemPrompt: 'STUB_OVERLAY' } }));
    expect(args.includes('--append-system-prompt')).toBe(carries);
  });
});


describe('Claude successful-command output cap', () => {
  it.each(['2.1.261', '2.1.296'])('applies a requested cap at %s', cliVersion => {
    const args = buildClaudeCliArgs(baseInput({ cliVersion, spawnOptions: { bashOutputMaxChars: 12000 } }));
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ bashOutputMaxChars: 12000 });
  });
  it.each([null, '2.1.260', 'invalid'])('omits the cap when support is unconfirmed at %s', cliVersion => {
    expect(buildClaudeCliArgs(baseInput({ cliVersion, spawnOptions: { bashOutputMaxChars: 12000 } }))).not.toContain('--settings');
  });
  it.each([undefined, 0, 3999, 128001, NaN])('omits an invalid cap %s', bashOutputMaxChars => {
    expect(buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296', spawnOptions: { bashOutputMaxChars } }))).not.toContain('--settings');
  });
});


describe('Claude configured output cap', () => {
  it('applies the default to an auto-approve session using the shared detected-version fallback', () => {
    _setOutputCapSettingsReaderForTesting(() => 12_000);
    detection.peekCachedResult.mockReturnValue({ detected: [{ name: 'claude', version: '2.1.296' }] });
    const args = buildClaudeCliArgs(baseInput({ spawnOptions: { yoloMode: true } }));
    expect(args).toContain('--dangerously-skip-permissions');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ bashOutputMaxChars: 12_000 });
  });
  it('applies the configured cap on resume and keeps an explicit override', () => {
    _setOutputCapSettingsReaderForTesting(() => 12_000);
    const args = buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296', sessionId: 'resume-session',
      shouldUseNativeResume: true, spawnOptions: { resume: true, bashOutputMaxChars: 24_000 } }));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'resume-session']));
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ bashOutputMaxChars: 24_000 });
  });
  it('uses the provider default when the setting or an explicit option is zero', () => {
    _setOutputCapSettingsReaderForTesting(() => 0);
    expect(buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296' }))).not.toContain('--settings');
    _setOutputCapSettingsReaderForTesting(() => 12_000);
    expect(buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296', spawnOptions: { bashOutputMaxChars: 0 } }))).not.toContain('--settings');
  });
});

describe('Claude waiting-rule rollout', () => {
  const ruleArgs = (input: BuildClaudeCliArgsInput): string[] => buildClaudeCliArgs(input);
  it('omits the flag by default even on a supported CLI', () => {
    expect(ruleArgs(baseInput({ cliVersion: '2.1.296' }))).not.toContain('--append-subagent-system-prompt-file');
  });
  it.each(['2.1.260', null])('omits the opt-in rule for unsupported version %s', cliVersion => {
    expect(ruleArgs(baseInput({ cliVersion, subagentWaitingRuleOptIn: true }))).not.toContain('--append-subagent-system-prompt-file');
  });
  it.each([false, true])('opt-in wires a private exact-text file on resume=%s', resume => {
    const args = ruleArgs(baseInput({ cliVersion: '2.1.296', subagentWaitingRuleOptIn: true,
      spawnOptions: { resume }, sessionId: 'stub-session', shouldUseNativeResume: resume }));
    const index = args.indexOf('--append-subagent-system-prompt-file');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(readFileSync(args[index + 1], 'utf8')).toBe(CLAUDE_SUBAGENT_WAITING_RULE);
    expect(statSync(args[index + 1]).mode & 0o777).toBe(0o600);
  });
});


describe('Claude Bash cap in final argv (Step 9a)', () => {
  beforeEach(() => {
    detection.peekCachedResult.mockReset().mockReturnValue(null);
    _setOutputCapSettingsReaderForTesting(key => key === 'claudeBashOutputMaxChars' ? 12_000 : undefined);
  });
  afterEach(() => {
    detection.peekCachedResult.mockReset().mockReturnValue(null);
    _setOutputCapSettingsReaderForTesting(null);
  });

  function settings(args: string[]): Record<string, unknown> {
    expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
    return JSON.parse(args[args.indexOf('--settings') + 1]) as Record<string, unknown>;
  }

  it('adds bashOutputMaxChars 12000 to --settings on CLI 2.1.296 without changing approval mode', () => {
    const args = buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296' }));
    expect(settings(args)).toEqual({ bashOutputMaxChars: 12_000 });
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('caps an auto-approve spawn with a null adapter version using cached Claude detection', () => {
    detection.peekCachedResult.mockReturnValue({ detected: [{ name: 'claude', version: '2.1.296' }] });
    const args = buildClaudeCliArgs(baseInput({ cliVersion: null, shouldUsePermissionHook: false,
      spawnOptions: { yoloMode: true, permissionHookPath: '/placeholder-hook.js' } }));
    expect(settings(args)).toEqual({ bashOutputMaxChars: 12_000 });
    expect(detection.peekCachedResult).toHaveBeenCalled();
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it.each([
    { version: '2.1.250', cached: '2.1.296' },
    { version: null, cached: '2.1.250' },
    { version: null, cached: null },
  ])('omits the cap with adapter=$version and detection=$cached', ({ version, cached }) => {
    detection.peekCachedResult.mockReturnValue(cached ? { detected: [{ name: 'claude', version: cached }] } : null);
    const args = buildClaudeCliArgs(baseInput({ cliVersion: version, spawnOptions: { fastMode: true } }));
    expect(settings(args)).toEqual({ fastMode: true });
  });

  it('omits the cap when the setting is zero', () => {
    _setOutputCapSettingsReaderForTesting(() => 0);
    expect(buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296' }))).not.toContain('--settings');
  });

  it.each([8_000, 0])('an explicit spawn value %s overrides the default setting', bashOutputMaxChars => {
    const args = buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296',
      spawnOptions: { fastMode: true, bashOutputMaxChars } }));
    expect(settings(args)).toEqual(bashOutputMaxChars === 0
      ? { fastMode: true } : { fastMode: true, bashOutputMaxChars });
  });

  it('retains the cap on native resume even with a null adapter version', () => {
    detection.peekCachedResult.mockReturnValue({ detected: [{ name: 'claude', version: '2.1.296' }] });
    const args = buildClaudeCliArgs(baseInput({ cliVersion: null, sessionId: 'placeholder-resume',
      shouldUseNativeResume: true, spawnOptions: { resume: true, yoloMode: true, systemPrompt: 'placeholder overlay' } }));
    expect(settings(args)).toEqual({ bashOutputMaxChars: 12_000 });
    expect(args).toEqual(expect.arrayContaining(['--resume', 'placeholder-resume']));
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('materializes the merged cap overlay through the final argv settings argument', () => {
    const materialize = vi.fn(() => '/placeholder-private-settings.json');
    const args = buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296',
      spawnOptions: { fastMode: true }, materializeInlineJsonArg: materialize }));
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2))
      .toEqual(['--settings', '/placeholder-private-settings.json']);
    expect(materialize).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ fastMode: true, bashOutputMaxChars: 12_000 }));
  });
});

// The id as it appears in a real `enabledPlugins` key of Claude's settings.json
// (`<plugin>@<marketplace>`); read-only check of the installed marketplace on
// 20 Oct 2026 found the `security-guidance` plugin under `claude-plugins-official`.
const SECURITY_PLUGIN_ID = 'security-guidance@claude-plugins-official';

describe('security-guidance plugin switch-off in the --settings overlay (Step 4 item 5)', () => {
  beforeEach(() => { detection.peekCachedResult.mockReset().mockReturnValue(null); });

  function overlayOf(args: string[]): Record<string, unknown> | undefined {
    const index = args.indexOf('--settings');
    return index === -1 ? undefined : JSON.parse(args[index + 1]) as Record<string, unknown>;
  }

  it('machineSession adds enabledPlugins security-guidance false to --settings', () => {
    const overlay = JSON.parse(buildClaudeSettingsOverlay({ machineSession: 'loop' }, false)!);
    // Harness-started Claude sessions also stop the CLI summarising in the background (Oct-2 T13 step 6; claude-precompact-overlay.spec.ts).
    expect(overlay).toEqual({ enabledPlugins: { [SECURITY_PLUGIN_ID]: false }, precomputeCompactionEnabled: false });

    const args = buildClaudeCliArgs(baseInput({ spawnOptions: { machineSession: 'plan-queue', yoloMode: true } }));
    expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
    expect(overlayOf(args)).toEqual({ enabledPlugins: { [SECURITY_PLUGIN_ID]: false }, precomputeCompactionEnabled: false });
  });

  it.each(['loop', 'review', 'plan-queue', 'automation', 'ping-pong-review'] as const)(
    'switches the plugin off for the %s machine session',
    machineSession => {
      expect(JSON.parse(buildClaudeSettingsOverlay({ machineSession }, false)!).enabledPlugins)
        .toEqual({ [SECURITY_PLUGIN_ID]: false });
    },
  );

  it("an interactive spawn's overlay has no enabledPlugins key", () => {
    expect(buildClaudeSettingsOverlay({}, false)).toBeUndefined();
    // Even with other overlay content present, an own chat never mentions plugins.
    const overlay = JSON.parse(buildClaudeSettingsOverlay({ fastMode: true, reasoningEffort: 'workflow' }, false)!);
    expect(overlay).not.toHaveProperty('enabledPlugins');
    const args = buildClaudeCliArgs(baseInput({ cliVersion: '2.1.296', spawnOptions: { yoloMode: true, fastMode: true } }));
    expect(overlayOf(args)).not.toHaveProperty('enabledPlugins');
    expect(JSON.stringify(args)).not.toContain('security-guidance');
  });

  it('the permission hook and enabledPlugins coexist in one overlay', () => {
    const overlay = JSON.parse(buildClaudeSettingsOverlay({
      machineSession: 'automation',
      permissionHookPath: '/hook.js',
      fastMode: true,
      reasoningEffort: 'workflow',
    }, true)!);
    expect(overlay.enabledPlugins).toEqual({ [SECURITY_PLUGIN_ID]: false });
    expect(overlay.fastMode).toBe(true);
    expect(overlay.ultracode).toBe(true);
    expect(overlay.hooks.PreToolUse).toHaveLength(1);
    expect(overlay.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(overlay.hooks.PreToolUse[0].hooks[0].command).toContain('/hook.js');

    // The same merge through the final argv for an auto-approve machine session with RTK.
    const args = buildClaudeCliArgs(baseInput({ spawnOptions: {
      machineSession: 'loop', yoloMode: true, rtk: { enabled: true, binaryPath: '/placeholder/rtk', yoloHookPath: '/placeholder/rtk-defer-hook.mjs' },
    } }));
    const merged = overlayOf(args) as { enabledPlugins: Record<string, boolean>; hooks: { PreToolUse: unknown[] } };
    expect(merged.enabledPlugins).toEqual({ [SECURITY_PLUGIN_ID]: false });
    expect(merged.hooks.PreToolUse).toHaveLength(1);
  });
});

describe('Claude version fallback reaches an auto-approve spawn with no primed version (Step 2 item 3)', () => {
  beforeEach(() => { detection.peekCachedResult.mockReset().mockReturnValue(null); });
  afterEach(() => { detection.peekCachedResult.mockReset().mockReturnValue(null); });
  const autoApprove = (cliVersion: string | null): BuildClaudeCliArgsInput => baseInput({
    cliVersion,
    subagentWaitingRuleOptIn: true,
    shouldUsePermissionHook: false,
    spawnOptions: { yoloMode: true, permissionHookPath: '/placeholder-hook.js' },
  });
  const detected = (version: string): { detected: { name: string; version: string }[] } =>
    ({ detected: [{ name: 'claude', version }] });

  it('an auto-approve spawn with no primed adapter version still gets the flag when detection says 2.1.296', () => {
    detection.peekCachedResult.mockReturnValue(detected('2.1.296'));
    const args = buildClaudeCliArgs(autoApprove(null));
    const index = args.indexOf('--append-subagent-system-prompt-file');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(readFileSync(args[index + 1], 'utf8')).toBe(CLAUDE_SUBAGENT_WAITING_RULE);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(detection.peekCachedResult).toHaveBeenCalled();
  });

  it.each([
    { adapter: null, cached: null },
    { adapter: null, cached: '2.1.260' },
  ])('omits the flag when neither knows a new enough version (adapter=$adapter, detection=$cached)', ({ adapter, cached }) => {
    detection.peekCachedResult.mockReturnValue(cached ? detected(cached) : null);
    expect(buildClaudeCliArgs(autoApprove(adapter))).not.toContain('--append-subagent-system-prompt-file');
  });

  it('prefers the adapter version over detection', () => {
    detection.peekCachedResult.mockReturnValue(detected('2.1.296'));
    expect(buildClaudeCliArgs(autoApprove('2.1.260'))).not.toContain('--append-subagent-system-prompt-file');
  });
});

describe('Claude Bash PreToolUse hook by approval mode (Step 18b item 3)', () => {
  beforeEach(() => { detection.peekCachedResult.mockReset().mockReturnValue(null); });
  const RTK_HOOK = '/placeholder/hooks/rtk-defer-hook.mjs';
  const DEFER_HOOK = '/placeholder/hooks/defer-permission-hook.mjs';
  const rtk = (yoloHookPath?: string): NonNullable<ClaudeCliSpawnOptions['rtk']> =>
    ({ enabled: true, binaryPath: '/placeholder/rtk', ...(yoloHookPath ? { yoloHookPath } : {}) });

  function hooksOf(args: string[]): { matcher: string; hooks: { type: string; command: string }[] }[] | undefined {
    const index = args.indexOf('--settings');
    if (index === -1) return undefined;
    return (JSON.parse(args[index + 1]) as { hooks?: { PreToolUse: never[] } }).hooks?.PreToolUse;
  }

  it('auto-approve with rtk.yoloHookPath produces exactly one Bash PreToolUse hook running the rewrite-only script', () => {
    const args = buildClaudeCliArgs(baseInput({
      shouldUsePermissionHook: true,
      spawnOptions: { yoloMode: true, permissionHookPath: DEFER_HOOK, rtk: rtk(RTK_HOOK) },
    }));
    const hooks = hooksOf(args);
    expect(hooks).toHaveLength(1);
    expect(hooks![0].matcher).toBe('Bash');
    expect(hooks![0].hooks).toHaveLength(1);
    expect(hooks![0].hooks[0].type).toBe('command');
    expect(hooks![0].hooks[0].command).toMatch(/^node /);
    expect(hooks![0].hooks[0].command).toContain(RTK_HOOK);
    expect(hooks![0].hooks[0].command).not.toContain(DEFER_HOOK);
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it.each([
    ['rtk without a yoloHookPath', rtk()],
    ['no rtk config', undefined],
    ['rtk disabled', { enabled: false, binaryPath: '/placeholder/rtk', yoloHookPath: RTK_HOOK }],
  ])('auto-approve with %s produces no hooks', (_label, rtkConfig) => {
    const args = buildClaudeCliArgs(baseInput({
      shouldUsePermissionHook: true,
      spawnOptions: { yoloMode: true, permissionHookPath: DEFER_HOOK, ...(rtkConfig ? { rtk: rtkConfig } : {}) },
    }));
    expect(hooksOf(args)).toBeUndefined();
    expect(args.join(' ')).not.toContain(RTK_HOOK);
    expect(args.join(' ')).not.toContain(DEFER_HOOK);
  });

  it('non-auto-approve still gets the defer hook, not the rewrite-only script', () => {
    const args = buildClaudeCliArgs(baseInput({
      shouldUsePermissionHook: true,
      spawnOptions: { yoloMode: false, permissionHookPath: DEFER_HOOK, rtk: rtk(RTK_HOOK) },
    }));
    const hooks = hooksOf(args);
    expect(hooks).toHaveLength(1);
    expect(hooks![0].hooks).toHaveLength(1);
    expect(hooks![0].hooks[0].command).toContain(DEFER_HOOK);
    expect(hooks![0].hooks[0].command).not.toContain(RTK_HOOK);
  });
});
