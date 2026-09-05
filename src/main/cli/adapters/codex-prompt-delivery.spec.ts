import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import { collectStdin, queueCodexRun } from './codex-cli-adapter.test-helpers';
import { createBudgetedSystemPromptComposer } from '../../context/budgeted-system-prompt';
import { wrapCodexSystemInstructions } from './codex/codex-prompt-blocks';

describe('Codex prompt delivery through exec stdin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prices exec fallback cache/reasoning buckets at the offline Astra rates', async () => {
    const adapter = new CodexCliAdapter({ model: 'gpt-6-astra', workingDir: '/tmp/project' });
    const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
    queueCodexRun(spawn, { stdoutLines: [
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":4}}',
    ] });
    const response = await adapter.sendMessage({ role: 'user', content: 'Apply the known fix' });
    expect(response.usage?.totalTokens).toBe(120);
    expect(response.usage?.cost).toBeCloseTo(0.00128, 10);
  });

  it('delivers the complete budgeted prompt and does not reinject it on native resume', async () => {
    const composer = createBudgetedSystemPromptComposer('codex');
    composer.add('instructions', 'Governing instruction\n'.repeat(300));
    composer.add('project-brief', 'PROJECT BRIEF: known fix, avoid repeating failed work');
    composer.add('tool-permissions', 'Preserve approval boundaries');
    const systemPrompt = composer.compose().text;
    const adapter = new CodexCliAdapter({ systemPrompt, workingDir: '/tmp/project' });
    const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
    const run = () => queueCodexRun(spawn, { stdoutLines: [
      '{"type":"thread.started","thread_id":"prompt-thread"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
    ] });
    const firstInput = collectStdin(run());
    await adapter.sendMessage({ role: 'user', content: 'Apply the known fix' });
    expect(await firstInput).toBe(wrapCodexSystemInstructions(systemPrompt, 'Apply the known fix'));
    const secondInput = collectStdin(run());
    await adapter.sendMessage({ role: 'user', content: 'Continue' });
    expect(await secondInput).toBe('Continue');
  });
});
