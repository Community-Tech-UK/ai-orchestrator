import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setSettingsReaderForTesting,
  applyClaudeHygieneEnv,
  resolveClaudeFallbackModel,
} from './claude-env-pack';

const getSettingMock = vi.fn();
_setSettingsReaderForTesting((key: string) => getSettingMock(key));

describe('applyClaudeHygieneEnv', () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    getSettingMock.mockReturnValue(undefined);
  });

  it('sets DISABLE_UPDATES and a per-session CLAUDE_CODE_TMPDIR that exists on disk', () => {
    const env: Record<string, string> = {};
    applyClaudeHygieneEnv(env, 'sess-abc');

    expect(env['DISABLE_UPDATES']).toBe('1');
    expect(env['CLAUDE_CODE_TMPDIR']).toBe(path.join(os.tmpdir(), 'aio-claude-tmp', 'sess-abc'));
    expect(fs.existsSync(env['CLAUDE_CODE_TMPDIR'])).toBe(true);
  });

  it('never clobbers caller-provided values', () => {
    const env: Record<string, string> = {
      DISABLE_UPDATES: '0',
      CLAUDE_CODE_TMPDIR: '/custom/tmp',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
    };
    getSettingMock.mockImplementation((key: string) => key === 'claudeSubprocessEnvScrub');
    applyClaudeHygieneEnv(env, 'sess-abc');

    expect(env['DISABLE_UPDATES']).toBe('0');
    expect(env['CLAUDE_CODE_TMPDIR']).toBe('/custom/tmp');
    expect(env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('0');
  });

  it('gates the subprocess env scrub behind its default-OFF setting', () => {
    const off: Record<string, string> = {};
    applyClaudeHygieneEnv(off, 'sess-1');
    expect(off['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBeUndefined();

    getSettingMock.mockImplementation((key: string) => key === 'claudeSubprocessEnvScrub');
    const on: Record<string, string> = {};
    applyClaudeHygieneEnv(on, 'sess-1');
    expect(on['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('1');
  });

  it('uses a shared tmp bucket when no session id is known', () => {
    const env: Record<string, string> = {};
    applyClaudeHygieneEnv(env, undefined);
    expect(env['CLAUDE_CODE_TMPDIR']).toBe(path.join(os.tmpdir(), 'aio-claude-tmp', 'shared'));
  });
});

describe('resolveClaudeFallbackModel', () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    getSettingMock.mockReturnValue(undefined);
  });

  it('prefers the explicit spawn option over the setting', () => {
    getSettingMock.mockReturnValue('claude-sonnet-5');
    expect(resolveClaudeFallbackModel('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('falls back to the claudeFallbackModel setting', () => {
    getSettingMock.mockImplementation((key: string) =>
      key === 'claudeFallbackModel' ? 'claude-sonnet-5' : undefined,
    );
    expect(resolveClaudeFallbackModel(undefined)).toBe('claude-sonnet-5');
  });

  it('resolves empty/whitespace to undefined (flag omitted)', () => {
    getSettingMock.mockReturnValue('   ');
    expect(resolveClaudeFallbackModel('')).toBeUndefined();
    expect(resolveClaudeFallbackModel(undefined)).toBeUndefined();
  });
});
