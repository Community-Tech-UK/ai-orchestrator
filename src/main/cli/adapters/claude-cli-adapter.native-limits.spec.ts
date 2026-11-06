import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import { _setSettingsReaderForTesting } from './claude-env-pack';
import type { MachineSessionReason } from '../../../shared/utils/machine-session';

const LIMIT_KEYS = ['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION', 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'CLAUDE_CODE_FORK_SUBAGENT'];
const saved: Record<string, string | undefined> = {};

/** The environment the real adapter will give the CLI process. */
const envOf = (options: ConstructorParameters<typeof ClaudeCliAdapter>[0]): Record<string, string> =>
  ((new ClaudeCliAdapter(options) as unknown as { config: { env?: Record<string, string> } }).config.env ?? {});

beforeEach(() => {
  for (const key of LIMIT_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  _setSettingsReaderForTesting(() => undefined);
});
afterEach(() => {
  _setSettingsReaderForTesting(null);
  for (const key of LIMIT_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

describe('native Claude helper limits reach the spawned CLI through the real adapter', () => {
  it.each([['plan-queue', '1', '0'], ['loop', '2', '0'], ['automation', '2', undefined]] as const)('bounds %s sessions', (machineSession, depth, fork) => {
    const env = envOf({ machineSession });
    expect(env['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH']).toBe(depth);
    expect(env['CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION']).toBe('60');
    expect(env['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS']).toBe('6');
    expect(env['CLAUDE_CODE_FORK_SUBAGENT']).toBe(fork);
  });

  it.each([undefined, 'child', 'review', 'ping-pong-review'] as Array<MachineSessionReason | undefined>)('leaves %s sessions on the CLI\'s own limits', (machineSession) => {
    const env = envOf({ machineSession });
    for (const key of LIMIT_KEYS) expect(env).not.toHaveProperty(key);
  });

  it('keeps a limit the caller set', () => {
    const env = envOf({ machineSession: 'plan-queue', env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2' } });
    expect(env['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS']).toBe('2');
    expect(env['CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION']).toBe('60');
  });
});
