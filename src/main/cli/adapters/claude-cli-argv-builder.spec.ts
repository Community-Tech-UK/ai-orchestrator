import { describe, it, expect, vi } from 'vitest';
import {
  buildClaudeCliArgs,
  buildClaudeSettingsOverlay,
  mapClaudeReasoningEffort,
  type BuildClaudeCliArgsInput,
} from './claude-cli-argv-builder';
import type { ClaudeCliSpawnOptions } from './claude-cli-adapter.types';

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
  it('always includes the fixed stream-json flags', () => {
    const args = buildClaudeCliArgs(baseInput());
    expect(args.slice(0, 6)).toEqual([
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    ]);
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
});
