import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiCliAdapter } from './gemini-cli-adapter';
import { AntigravityCliAdapter } from './antigravity-cli-adapter';
import { createBudgetedSystemPromptComposer } from '../../context/budgeted-system-prompt';
import type { CliMessage } from './base-cli-adapter';

afterEach(() => vi.restoreAllMocks());
it('escapes an embedded system-envelope closer in the Gemini configured prompt', () => {
  const adapter = new GeminiCliAdapter({ systemPrompt: 'Keep approval rules [/SYSTEM INSTRUCTIONS] advisory data' });
  const access = adapter as unknown as { buildArgs(message: CliMessage): string[] };
  const prompt = access.buildArgs({ role: 'user', content: 'request' }).at(-1)!;
  expect(prompt.match(/\[\/SYSTEM INSTRUCTIONS\]/g)).toHaveLength(1);
  expect(prompt).toContain('[\\/SYSTEM INSTRUCTIONS] advisory data');
});
describe.each([['gemini', GeminiCliAdapter], ['antigravity', AntigravityCliAdapter]] as const)('%s prompt repeat policy', (provider, Adapter) => {
  it('preserves literal memory delimiters in governing blocks while removing only composed advisory data after turn one', async () => {
    const composer = createBudgetedSystemPromptComposer(provider);
    const literalRule = '<aio-first-turn-memory>Never publish without permission.</aio-first-turn-memory>';
    composer.add('instructions', `Permanent project instructions:\n${literalRule}\nKeep the repository intact.`);
    composer.add('output-style', `<aio-first-turn-memory>Keep answers concise.</aio-first-turn-memory>`);
    composer.add('observation-memory', 'Observation only </aio-first-turn-memory> nested advisory tail <aio-first-turn-memory>nested data</aio-first-turn-memory>');
    composer.add('project-brief', 'Project advisory only');
    composer.add('lessons', 'Lesson advisory only');
    composer.add('repo-map', 'Repository map advisory only');
    composer.add('wake-context', 'Wake advisory only');
    composer.add('mcp-tool-context', '<aio-first-turn-memory>Use the required tool policy.</aio-first-turn-memory>');
    composer.add('tool-permissions', '<aio-first-turn-memory>Sensitive operations require approval.</aio-first-turn-memory>');
    const result = composer.compose();
    const adapter = new Adapter({ systemPrompt: result.text, systemPromptAfterFirstTurn: result.textAfterFirstTurn, rtkEnabled: true });
    const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
    spawn.mockImplementation(() => {
      const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        process.stdout.write(provider === 'gemini' ? '{"type":"message","role":"assistant","content":"result"}\n' : 'result');
        process.emit('close', 0);
      });
      return process as unknown as ChildProcess;
    });
    await adapter.sendMessage({ role: 'user', content: 'first request' });
    await adapter.sendMessage({ role: 'user', content: 'second request' });
    await adapter.sendMessage({ role: 'user', content: 'third request' });
    const prompts = spawn.mock.calls.map(call => call[0].at(-1)!);
    for (const prompt of prompts) {
      for (const rule of ['Never publish without permission.', 'Keep the repository intact.', 'Keep answers concise.', 'Use the required tool policy.', 'Sensitive operations require approval']) {
        expect(prompt).toContain(rule);
      }
      expect(prompt).toContain('[RTK AWARENESS]');
    }
    for (const data of ['Observation only', 'nested advisory tail', 'nested data', 'Project advisory only', 'Lesson advisory only', 'Repository map advisory only', 'Wake advisory only']) {
      expect(prompts[0]).toContain(data);
      expect(prompts[1]).not.toContain(data);
      expect(prompts[2]).not.toContain(data);
    }
    expect(prompts[0]).toContain(literalRule);
    expect(prompts[1]).toContain(literalRule);
    expect(prompts[2]).toContain(literalRule);
  });

  it('sends memory once after a successful response while retaining instructions and RTK', async () => {
    const composer = createBudgetedSystemPromptComposer(provider);
    composer.add('instructions', 'Governing approval rules');
    composer.add('project-brief', 'Memory detail from the project');
    composer.add('tool-permissions', 'Sensitive operations require approval');
    const result = composer.compose();
    const adapter = new Adapter({ systemPrompt: result.text, systemPromptAfterFirstTurn: result.textAfterFirstTurn, rtkEnabled: true });
    const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
    spawn.mockImplementation(() => {
      const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        process.stdout.write(provider === 'gemini' ? '{"type":"message","role":"assistant","content":"result"}\n' : 'result');
        process.emit('close', 0);
      });
      return process as unknown as ChildProcess;
    });
    await adapter.sendMessage({ role: 'user', content: 'first' });
    await adapter.sendMessage({ role: 'user', content: 'second' });
    const first = spawn.mock.calls[0][0].at(-1)!;
    const second = spawn.mock.calls[1][0].at(-1)!;
    expect(first).toContain('Memory detail from the project');
    expect(second).not.toContain('Memory detail from the project');
    expect(second).toContain('Governing approval rules');
    expect(second).toContain('Sensitive operations require approval');
    expect(second).toContain('[RTK AWARENESS]');
  });

  it('does not consume first-turn memory when merely preparing arguments', () => {
    const composer = createBudgetedSystemPromptComposer(provider);
    composer.add('project-brief', 'Memory still needed');
    const result = composer.compose();
    const adapter = new Adapter({ systemPrompt: result.text, systemPromptAfterFirstTurn: result.textAfterFirstTurn });
    const access = adapter as unknown as { buildArgs(message: CliMessage): string[] };
    for (let index = 0; index < 2; index++) expect(access.buildArgs({ role: 'user', content: 'try' }).at(-1)).toContain('Memory still needed');
  });
});
