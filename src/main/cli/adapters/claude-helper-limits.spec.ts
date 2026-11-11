import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyClaudeHygieneEnv } from './claude-env-pack';

const LIMIT_KEYS = ['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION', 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'CLAUDE_CODE_FORK_SUBAGENT'];

describe('Claude machine helper limits', () => {
  // A queue, loop or automation session that runs this suite already has these set in its own environment.
  beforeEach(() => { for (const key of LIMIT_KEYS) vi.stubEnv(key, undefined); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it.each(['plan-queue', 'loop', 'automation'] as const)('bounds %s helpers while preserving caller values', (machineSession) => {
    const env: Record<string, string> = { CLAUDE_CODE_TMPDIR: '/tmp', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3' };
    applyClaudeHygieneEnv(env, undefined, { machineSession });
    expect(env['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH']).toBe(machineSession === 'plan-queue' ? '1' : '2');
    expect(env['CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION']).toBe('60');
    expect(env['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS']).toBe('3');
    expect(env['CLAUDE_CODE_FORK_SUBAGENT']).toBe(machineSession === 'automation' ? undefined : '0');
  });
  it.each([undefined, 'child', 'review', 'ping-pong-review'] as const)('leaves %s outside the machine helper limit policy', (machineSession) => {
    const env: Record<string, string> = { CLAUDE_CODE_TMPDIR: '/tmp' };
    applyClaudeHygieneEnv(env, undefined, { machineSession });
    expect(Object.keys(env).filter(key => /MAX_SUBAGENT|MAX_CONCURRENT_SUBAGENT|FORK_SUBAGENT/.test(key))).toEqual([]);
  });
});
