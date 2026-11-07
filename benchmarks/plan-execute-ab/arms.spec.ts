import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildClaudeInvocation,
  buildCodexInvocation,
  coderPrompt,
  localEndpointEnv,
  plannerPrompt,
  takeoverPrompt,
  runsPerArmFor,
  ARMS,
  PILOT_ARMS,
} from './arms';
import type { TaskDefinition } from './types';

const task: TaskDefinition = {
  id: 'AIO-01',
  repoId: 'ai-orchestrator',
  commitSha: 'c'.repeat(40),
  parentSha: 'p'.repeat(40),
  commitMessage: 'fix: keep queued saves',
  size: 'small',
  prompt: 'Keep queued disconnect saves during shutdown.',
  hiddenTests: ['src/x.spec.ts'],
  hiddenTestCommand: ['npm', 'run', 'test:quiet', '--', 'src/x.spec.ts'],
  damageCommands: [['npx', 'tsc', '--noEmit']],
  sourceFiles: ['src/x.ts'],
  verification: { failOnParent: true, passOnCommit: true, checkedAt: '', evidenceDir: '' },
};

afterEach(() => vi.unstubAllEnvs());

describe('arms', () => {
  it('removes inherited cloud auth and routing from a local invocation environment', () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'cloud-auth-placeholder');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'Authorization: cloud-placeholder');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'cloud-oauth-placeholder');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    const env = localEndpointEnv({
      modelKey: 'qwen3.8-27b', servedModelName: 'qwen3.8-27b', baseUrl: 'http://127.0.0.1:8900',
      apiKeyEnv: 'PLAN_EX_AB_LOCAL_KEY', configDir: '/tmp/local-config', apiStyle: 'anthropic',
    });
    expect(env['PATH']).toBe(process.env['PATH']);
    for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK']) {
      expect(env[name]).toBeUndefined();
    }
    expect(process.env['ANTHROPIC_AUTH_TOKEN']).toBe('cloud-auth-placeholder');
  });

  it('builds a claude coder invocation with unattended permissions and a turn cap', () => {
    const invocation = buildClaudeInvocation({
      prompt: 'do the thing',
      cwd: '/tmp/x',
      model: 'claude-opus-5-5',
      maxTurns: 75,
    });
    expect(invocation.command[0]).toBe('claude');
    expect(invocation.command).toContain('--print');
    expect(invocation.command).toContain('--dangerously-skip-permissions');
    expect(invocation.command).toContain('--max-turns');
    expect(invocation.command).toContain('75');
    expect(invocation.prompt).toBe('do the thing');
  });

  it('builds a read-only planner invocation that disallows editing and shell tools', () => {
    const invocation = buildClaudeInvocation({
      prompt: 'plan',
      cwd: '/tmp/x',
      model: 'claude-opus-5-5',
      maxTurns: 30,
      readOnly: true,
    });
    const disallowedIndex = invocation.command.indexOf('--disallowedTools');
    expect(disallowedIndex).toBeGreaterThan(-1);
    expect(invocation.command[disallowedIndex + 1]).toContain('Edit');
    expect(invocation.command[disallowedIndex + 1]).toContain('Bash');
    expect(invocation.command).not.toContain('--dangerously-skip-permissions');
  });

  it('builds a codex exec invocation that fails loudly outside git without approvals', () => {
    const invocation = buildCodexInvocation({ prompt: 'go', cwd: '/tmp/x' });
    expect(invocation.command[0]).toBe('codex');
    expect(invocation.command[1]).toBe('exec');
    expect(invocation.command).toContain('--json');
    expect(invocation.command).toContain('--skip-git-repo-check');
    expect(invocation.command).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('gives local arms a separate config dir and no attribution header', () => {
    const env = localEndpointEnv({
      modelKey: 'qwen3.8-27b',
      servedModelName: 'qwen3.8-27b',
      baseUrl: 'http://pc:1234',
      apiKeyEnv: 'PLAN_EX_AB_LOCAL_KEY',
      configDir: '/tmp/separate-config',
      apiStyle: 'openai',
    });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://pc:1234');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/tmp/separate-config');
    expect(env['CLAUDE_CODE_ATTRIBUTION_HEADER']).toBe('0');
  });

  it('includes the frozen plan for plan arms and none for arm A', () => {
    const withPlan = coderPrompt(task, '1. Steps', 'arm label');
    expect(withPlan).toContain('1. Steps');
    const withoutPlan = coderPrompt(task, null, 'arm label');
    expect(withoutPlan).not.toContain('1. Steps');
    expect(withoutPlan).toContain(task.prompt);
  });

  it('keeps the planner prompt read-only and outcome-focused', () => {
    const prompt = plannerPrompt(task);
    expect(prompt).toContain('Do not edit anything');
    expect(prompt).toContain('Done-when');
  });

  it('hands takeover the task and the stall reason', () => {
    const prompt = takeoverPrompt(task, 'last words', '2 failed test runs');
    expect(prompt).toContain('2 failed test runs');
    expect(prompt).toContain(task.prompt);
  });

  it('covers every planned arm and phases F to the full run only', () => {
    expect(Object.keys(ARMS).sort()).toEqual(['A', 'B', 'C1', 'C2', 'D', 'E', 'F', 'G']);
    expect(PILOT_ARMS).toEqual(['A', 'B', 'C1', 'C2', 'D']);
    expect(ARMS.F.phase).toBe('full');
    for (const armId of ['C1', 'C2', 'D', 'E', 'F'] as const) {
      expect(ARMS[armId].usesFrozenPlan).toBe(true);
    }
    expect(ARMS.A.usesFrozenPlan).toBe(false);
    expect(ARMS.B.planner).toBe('none');
  });

  it('runs every arm once per task in the pilot', () => {
    for (const armId of ['A', 'B', 'C1', 'C2', 'D', 'E', 'G', 'F'] as const) {
      expect(runsPerArmFor('pilot', armId)).toBe(1);
    }
  });

  it('gives cloud arms three full-run runs and local arms two (F included)', () => {
    for (const armId of ['A', 'D', 'E', 'G'] as const) {
      expect(runsPerArmFor('full', armId)).toBe(3);
    }
    for (const armId of ['B', 'C1', 'C2', 'F'] as const) {
      expect(runsPerArmFor('full', armId)).toBe(2);
    }
  });

  it('lets --runs override every arm count', () => {
    expect(runsPerArmFor('full', 'A', 5)).toBe(5);
    expect(runsPerArmFor('pilot', 'C1', 2)).toBe(2);
  });
});
