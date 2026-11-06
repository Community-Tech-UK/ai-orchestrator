import { describe, expect, it } from 'vitest';
import { applyClaudeHygieneEnv } from './claude-env-pack';

describe('Claude machine helper limits', () => {
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
