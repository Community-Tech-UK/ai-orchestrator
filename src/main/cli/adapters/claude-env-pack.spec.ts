import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setSettingsReaderForTesting,
  applyClaudeHygieneEnv,
  resolveClaudeDebugLogging,
  resolveClaudeFallbackModel,
} from './claude-env-pack';

const getSettingMock = vi.fn();
_setSettingsReaderForTesting((key: string) => getSettingMock(key));

const detection = vi.hoisted(() => ({ peekCachedResult: vi.fn((): unknown => null) }));
vi.mock('../cli-detection', () => ({ getCliDetectionService: () => detection }));

describe('applyClaudeHygieneEnv', () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    getSettingMock.mockReturnValue(undefined);
  });

  it('disables background tasks for queue sessions while leaving chat and other roles alone', () => {
    const queue: Record<string, string> = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' };
    applyClaudeHygieneEnv(queue, 'queue', { machineSession: 'plan-queue' });
    expect(queue['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']).toBe('1');
    const chat: Record<string, string> = {};
    applyClaudeHygieneEnv(chat, 'chat');
    expect(chat['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']).toBeUndefined();
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

describe('resolveClaudeDebugLogging', () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    getSettingMock.mockReturnValue(undefined);
  });

  it('is off when the setting is unset', () => {
    expect(resolveClaudeDebugLogging()).toBe(false);
  });

  it('follows the claudeCliDebugLogging setting', () => {
    getSettingMock.mockImplementation((key: string) => key === 'claudeCliDebugLogging');
    expect(resolveClaudeDebugLogging()).toBe(true);
  });

  it('prefers an explicit spawn option over the setting', () => {
    getSettingMock.mockReturnValue(true);
    expect(resolveClaudeDebugLogging(false)).toBe(false);
  });
});

 it('applies a ceiling but preserves explicit and inherited provider windows', () => {
  const options = { contextCeilingTokens: 120_000 };
  const env: Record<string, string> = {};
  applyClaudeHygieneEnv(env, undefined, options);
  expect(env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBe('120000');
  const explicit = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '180000' };
  applyClaudeHygieneEnv(explicit, undefined, options);
  expect(explicit.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('180000');
  vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', '190000');
  try {
    const inherited: Record<string, string> = {};
    applyClaudeHygieneEnv(inherited, undefined, options);
    expect(inherited['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBeUndefined();
  } finally { vi.unstubAllEnvs(); }
 });

describe('security-guidance kill switch for machine sessions (Step 4 item 5)', () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    getSettingMock.mockReturnValue(undefined);
  });

  it('machine sessions get SECURITY_GUIDANCE_DISABLE=1', () => {
    for (const machineSession of ['loop', 'plan-queue', 'review', 'automation'] as const) {
      const env: Record<string, string> = {};
      applyClaudeHygieneEnv(env, 'sess-machine', { machineSession });
      expect(env['SECURITY_GUIDANCE_DISABLE']).toBe('1');
    }
  });

  it('interactive spawns are untouched', () => {
    const own: Record<string, string> = {};
    applyClaudeHygieneEnv(own, 'sess-own', {});
    expect(own).not.toHaveProperty('SECURITY_GUIDANCE_DISABLE');
    const noOptions: Record<string, string> = {};
    applyClaudeHygieneEnv(noOptions, 'sess-own');
    expect(noOptions).not.toHaveProperty('SECURITY_GUIDANCE_DISABLE');
  });

  it('a caller value wins', () => {
    const env: Record<string, string> = { SECURITY_GUIDANCE_DISABLE: '0' };
    applyClaudeHygieneEnv(env, 'sess-machine', { machineSession: 'loop' });
    expect(env['SECURITY_GUIDANCE_DISABLE']).toBe('0');
  });
});

describe('CLAUDE_CODE_SUBAGENT_MODEL wiring (Step 2 item 2)', () => {
  // Session ids end in a hex digit: '0'-'7' is the Sonnet group, '8'-'f' is same-as-session.
  const SONNET_GROUP_SESSION = '3f1c2a47-9d0e-4b6a-8c15-0a7e5d2b9c10';
  const SAME_AS_SESSION_GROUP = '3f1c2a47-9d0e-4b6a-8c15-0a7e5d2b9c1f';
  const OPUS = 'claude-opus-4-8';

  const detectedVersion = (version: string | null): void => {
    detection.peekCachedResult.mockReturnValue(version ? { detected: [{ name: 'claude', version }] } : null);
  };
  const withSetting = (value: unknown): void => {
    getSettingMock.mockImplementation((key: string) => (key === 'claudeHelperAgentModel' ? value : undefined));
  };

  beforeEach(() => {
    getSettingMock.mockReset();
    getSettingMock.mockReturnValue(undefined);
    detection.peekCachedResult.mockReset().mockReturnValue(null);
    vi.stubEnv('CLAUDE_CODE_SUBAGENT_MODEL', '');
    vi.stubEnv('CLAUDE_CODE_SUBAGENT_MODEL_FORCE', '');
    withSetting('trial');
    detectedVersion('2.1.296');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    detection.peekCachedResult.mockReset().mockReturnValue(null);
  });

  it('adds the subagent model for a Sonnet-group Opus session on a known 2.1.296', () => {
    const env: Record<string, string> = {};
    applyClaudeHygieneEnv(env, SONNET_GROUP_SESSION, { model: OPUS });
    expect(env['CLAUDE_CODE_SUBAGENT_MODEL']).toBe('sonnet');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
  });

  it.each(['claude-sonnet-5', 'sonnet', 'claude-haiku-4-5', 'haiku'])('a %s session gets nothing', model => {
    const env: Record<string, string> = {};
    applyClaudeHygieneEnv(env, SONNET_GROUP_SESSION, { model });
    expect(env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');
  });

  it('a caller value wins, in the spawn env or Harness\'s own environment', () => {
    const own: Record<string, string> = { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' };
    applyClaudeHygieneEnv(own, SONNET_GROUP_SESSION, { model: OPUS });
    expect(own['CLAUDE_CODE_SUBAGENT_MODEL']).toBe('haiku');

    const forced: Record<string, string> = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'opus' };
    applyClaudeHygieneEnv(forced, SONNET_GROUP_SESSION, { model: OPUS });
    expect(forced).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');

    vi.stubEnv('CLAUDE_CODE_SUBAGENT_MODEL', 'opus');
    const inherited: Record<string, string> = {};
    applyClaudeHygieneEnv(inherited, SONNET_GROUP_SESSION, { model: OPUS });
    expect(inherited).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');
  });

  it.each([null, '2.1.250'])('an unknown or older CLI version (%s) gets nothing', version => {
    detectedVersion(version);
    const env: Record<string, string> = {};
    applyClaudeHygieneEnv(env, SONNET_GROUP_SESSION, { model: OPUS });
    expect(env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');
  });

  it('gets the version from detection at 2.1.251 and not before', () => {
    detectedVersion('2.1.251');
    const env: Record<string, string> = {};
    applyClaudeHygieneEnv(env, SONNET_GROUP_SESSION, { model: OPUS });
    expect(env['CLAUDE_CODE_SUBAGENT_MODEL']).toBe('sonnet');
    expect(detection.peekCachedResult).toHaveBeenCalled();
  });

  it('follows the setting and the trial group', () => {
    const run = (setting: unknown, sessionId?: string): Record<string, string> => {
      withSetting(setting);
      const env: Record<string, string> = {};
      applyClaudeHygieneEnv(env, sessionId, { model: OPUS });
      return env;
    };
    expect(run('trial', SAME_AS_SESSION_GROUP)).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');
    expect(run('trial', undefined)).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');
    expect(run('parent', SONNET_GROUP_SESSION)).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');
    expect(run(undefined, SONNET_GROUP_SESSION)).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL');
    expect(run('sonnet', SAME_AS_SESSION_GROUP)['CLAUDE_CODE_SUBAGENT_MODEL']).toBe('sonnet');
  });
});
