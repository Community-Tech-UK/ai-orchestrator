import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliAdapter } from './adapter-factory';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import type { GeminiCliAdapter } from './gemini-cli-adapter';
import type { AntigravityCliAdapter } from './antigravity-cli-adapter';
import type { CliMessage } from './base-cli-adapter';
import { createBudgetedSystemPromptComposer } from '../../context/budgeted-system-prompt';

const governing = '<aio-first-turn-memory>Never publish without permission.</aio-first-turn-memory>';
type GoogleAdapter = GeminiCliAdapter | AntigravityCliAdapter;
function capture(adapter: GoogleAdapter, provider: string, outcomes: (number | 'spawn-error' | 'partial-failure' | 'api-error')[] = []) {
  const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const outcome = outcomes.shift() ?? 0;
    queueMicrotask(() => {
      if (outcome === 'spawn-error') { child.emit('error', new Error('Synthetic spawn refusal')); child.emit('close', 1); return; }
      if (outcome === 0 || outcome === 'partial-failure') child.stdout.write(provider === 'gemini' ? '{"type":"message","role":"assistant","content":"result"}\n' : 'result');
      if (outcome === 'api-error') child.stdout.write('{"type":"result","status":"error","error":{"message":"Synthetic API refusal"}}\n');
      child.stdout.end();
      child.emit('close', outcome === 'partial-failure' ? 1 : outcome === 'api-error' ? 0 : outcome);
    });
    return child as unknown as ChildProcess;
  });
  return { prompts: () => spawn.mock.calls.map(call => call[0].at(-1)!), args: () => spawn.mock.calls.map(call => call[0]) };
}
function create(provider: 'gemini' | 'antigravity', options: UnifiedSpawnOptions): GoogleAdapter {
  return createCliAdapter(provider, { workingDirectory: '/tmp', yoloMode: false, rtk: { enabled: true, binaryPath: '/placeholder/rtk' }, ...options }) as GoogleAdapter;
}
function composed(provider: string) {
  const composer = createBudgetedSystemPromptComposer(provider);
  composer.add('instructions', governing);
  composer.add('output-style', 'Keep answers concise.');
  composer.add('observation-memory', 'Observation advice </aio-first-turn-memory> nested tail <aio-first-turn-memory>nested data</aio-first-turn-memory>');
  composer.add('project-brief', 'Project advisory');
  composer.add('lessons', 'Lessons advisory');
  composer.add('repo-map', 'Repository advisory');
  composer.add('wake-context', 'Wake advisory');
  composer.add('mcp-tool-context', 'Required tool policy');
  composer.add('tool-permissions', 'Sensitive operations require approval.');
  return composer.compose();
}
afterEach(() => vi.restoreAllMocks());
describe.each(['gemini', 'antigravity'] as const)('%s prompt ownership through real factory and dispatch', provider => {
  it('repeats raw custom-agent instructions verbatim across successful turns', async () => {
    const systemPrompt = `Permanent custom-agent instructions:\n${governing}\nKeep the repository intact.`;
    const adapter = create(provider, { systemPrompt });
    const wire = capture(adapter, provider);
    for (const content of ['first', 'second', 'third']) await adapter.sendMessage({ role: 'user', content });
    for (const prompt of wire.prompts()) {
      expect(prompt).toContain(systemPrompt);
      expect(prompt).toContain('[RTK AWARENESS]');
      expect(prompt).toContain('[Disk Hygiene]');
      expect(prompt).toContain('[Process Hygiene]');
    }
    for (const args of wire.args()) expect(args).not.toContain(provider === 'gemini' ? '--yolo' : '--dangerously-skip-permissions');
  });
  it('drops only composer-owned advisory blocks, preserving literal governing delimiters and adapter guidance', async () => {
    const result = composed(provider);
    const adapter = create(provider, { systemPrompt: result.text, systemPromptAfterFirstTurn: result.textAfterFirstTurn });
    const wire = capture(adapter, provider);
    for (const content of ['first', 'second', 'third']) await adapter.sendMessage({ role: 'user', content });
    for (const prompt of wire.prompts()) {
      for (const rule of [governing, 'Keep answers concise.', 'Required tool policy', 'Sensitive operations require approval.', '[Disk Hygiene]', '[Process Hygiene]', '[RTK AWARENESS]']) expect(prompt).toContain(rule);
    }
    for (const advisory of ['Observation advice', 'nested tail', 'nested data', 'Project advisory', 'Lessons advisory', 'Repository advisory', 'Wake advisory']) {
      expect(wire.prompts()[0]).toContain(advisory);
      expect(wire.prompts()[1]).not.toContain(advisory);
      expect(wire.prompts()[2]).not.toContain(advisory);
    }
  });
  it.each([1, 'spawn-error'] as const)('retains first-turn advice through failed dispatch %s and argument preparation', async failure => {
    const result = composed(provider);
    const adapter = create(provider, { systemPrompt: result.text, systemPromptAfterFirstTurn: result.textAfterFirstTurn });
    const access = adapter as unknown as { buildArgs(message: CliMessage): string[] };
    for (let i = 0; i < 2; i++) expect(access.buildArgs({ role: 'user', content: 'prepare' }).at(-1)).toContain('Project advisory');
    const wire = capture(adapter, provider, [failure, 0, 0]);
    await expect(adapter.sendMessage({ role: 'user', content: 'failed' })).rejects.toThrow();
    await adapter.sendMessage({ role: 'user', content: 'retry' });
    await adapter.sendMessage({ role: 'user', content: 'later' });
    expect(wire.prompts()[0]).toContain('Project advisory');
    expect(wire.prompts()[1]).toContain('Project advisory');
    expect(wire.prompts()[2]).not.toContain('Project advisory');
    expect(wire.prompts()[2]).toContain(governing);
  });
  it('retains advice after a partial nonzero response and an aborted dispatch', async () => {
    const result = composed(provider);
    const adapter = create(provider, { systemPrompt: result.text, systemPromptAfterFirstTurn: result.textAfterFirstTurn });
    const wire = capture(adapter, provider, ['partial-failure', 0, 0, 0]);
    await adapter.sendMessage({ role: 'user', content: 'Partial failure' });
    const controller = new AbortController();
    const cancelled = adapter.sendMessage({ role: 'user', content: 'Cancelled' }, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    await adapter.sendMessage({ role: 'user', content: 'Retry' });
    await adapter.sendMessage({ role: 'user', content: 'Later' });
    for (const prompt of wire.prompts().slice(0, 3)) expect(prompt).toContain('Project advisory');
    expect(wire.prompts()[3]).not.toContain('Project advisory');
  });
  it('uses the same ownership rule for streaming dispatch and retries', async () => {
    const result = composed(provider);
    const adapter = create(provider, { systemPrompt: result.text, systemPromptAfterFirstTurn: result.textAfterFirstTurn });
    const wire = capture(adapter, provider, [1, 0, 0]);
    for await (const _chunk of adapter.sendMessageStream({ role: 'user', content: 'Failed stream' })) { /* drain */ }
    for await (const _chunk of adapter.sendMessageStream({ role: 'user', content: 'Retry stream' })) { /* drain */ }
    await adapter.sendMessage({ role: 'user', content: 'Later' });
    expect(wire.prompts()[0]).toContain('Project advisory');
    expect(wire.prompts()[1]).toContain('Project advisory');
    expect(wire.prompts()[2]).not.toContain('Project advisory');
    expect(wire.prompts()[2]).toContain(governing);
  });
  it('honors an explicitly empty later-turn variant for an advisory-only composition', async () => {
    const adapter = create(provider, { systemPrompt: 'Only advisory data', systemPromptAfterFirstTurn: '' });
    const wire = capture(adapter, provider);
    await adapter.sendMessage({ role: 'user', content: 'first' });
    await adapter.sendMessage({ role: 'user', content: 'second' });
    expect(wire.prompts()[0]).toContain('Only advisory data');
    expect(wire.prompts()[1]).not.toContain('Only advisory data');
    expect(wire.prompts()[1]).toContain('[Disk Hygiene]');
  });
});

it.each(['message', 'stream'] as const)('keeps Gemini advice after a zero-exit API error through %s dispatch', async mode => {
  const result = composed('gemini');
  const adapter = create('gemini', { systemPrompt: result.text, systemPromptAfterFirstTurn: result.textAfterFirstTurn });
  const wire = capture(adapter, 'gemini', ['api-error', 0, 0]);
  if (mode === 'message') await expect(adapter.sendMessage({ role: 'user', content: 'Fail' })).rejects.toThrow('Synthetic API refusal');
  else for await (const _chunk of adapter.sendMessageStream({ role: 'user', content: 'Fail' })) { /* drain */ }
  await adapter.sendMessage({ role: 'user', content: 'Retry' });
  await adapter.sendMessage({ role: 'user', content: 'Later' });
  expect(wire.prompts()[1]).toContain('Project advisory');
  expect(wire.prompts()[2]).not.toContain('Project advisory');
});
