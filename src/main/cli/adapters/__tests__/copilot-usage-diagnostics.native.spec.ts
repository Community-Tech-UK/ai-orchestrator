// @vitest-environment node
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogManager } from '../../../logging/logger';
import { CopilotCliAdapter } from '../copilot-cli-adapter';
import type { CliAdapterConfig, CliResponse } from '../base-cli-adapter';
import type { ContextUsage, OutputMessage } from '../../../../shared/types/instance.types';

const marker = 'SYNTHETIC_COPILOT_USAGE_SOURCE';
const prompt = `native request ${marker}`;
const fields = ['premiumRequests', 'totalApiDurationMs', 'sessionDurationMs'] as const;
const manager = getLogManager();
const cleanup: (() => void | Promise<void>)[] = [];
let log: ReturnType<typeof vi.spyOn>;
let logError: ReturnType<typeof vi.spyOn>;
let previousConfig: ReturnType<typeof manager.getConfig>;

beforeEach(() => {
  previousConfig = manager.getConfig();
  manager.updateConfig({ globalLevel: 'debug', enableConsole: false, enableFile: false });
  manager.clearBuffer();
  log = vi.spyOn(manager, 'log');
  logError = vi.spyOn(manager, 'logError');
});

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
    manager.clearBuffer();
    manager.updateConfig(previousConfig);
  }
});

/** Keep the production spawn/parser/logger; substitute only the native executable. */
async function nativeTurn(usageJson: string, newline = true, sessionId?: { json: string | undefined; captured: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-copilot-usage-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const receipt = join(dir, 'receipt.json');
  const child = join(dir, 'child.cjs');
  const sessionIdField = !sessionId ? '"sessionId":"native-session",'
    : sessionId.json === undefined ? '' : `"sessionId":${sessionId.json},`;
  const stdout = JSON.stringify({
    type: 'assistant.message', data: { messageId: 'native-answer', content: 'native answer', outputTokens: 7 },
  }) + '\n' + `{"type":"result",${sessionIdField}"exitCode":0,"usage":${usageJson}}`
    + (newline ? '\n' : '');
  writeFileSync(child, `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));
    process.stdout.write(${JSON.stringify(stdout)});`);

  const adapter = new CopilotCliAdapter({ workingDir: dir });
  const access = adapter as unknown as { config: CliAdapterConfig };
  access.config = { ...access.config, command: process.execPath, args: [child] };
  Object.assign(adapter, { launchResolved: true });
  cleanup.push(() => adapter.terminate(false));
  const output: OutputMessage[] = [];
  const context: ContextUsage[] = [];
  const complete: CliResponse[] = [];
  const errors: Error[] = [];
  adapter.on('output', message => output.push(message));
  adapter.on('context', usage => context.push(usage));
  adapter.on('complete', response => complete.push(response));
  adapter.on('error', error => errors.push(error));
  const response = await adapter.sendMessage({ role: 'user', content: prompt });

  // These positives precede every privacy assertion, including the close-time final line.
  expect(response.content).toBe('native answer');
  expect(response.raw).toBe(stdout);
  expect(complete).toHaveLength(1);
  expect(complete[0]).toBe(response);
  expect(output.filter(message => message.type === 'assistant').map(message => message.content))
    .toEqual(['native answer']);
  expect(errors).toEqual([]);
  const argv = JSON.parse(readFileSync(receipt, 'utf8')) as string[];
  expect(argv[argv.indexOf('--prompt') + 1]).toBe(prompt);
  expect(context).toEqual([{
    used: 4, total: 128_000, percentage: 0.003125, cumulativeTokens: 4, isEstimated: true,
  }]);
  expect(response.usage).toMatchObject({ inputTokens: 0, outputTokens: 7, totalTokens: 7 });
  expect(response.usage?.duration).toEqual(expect.any(Number));
  if (sessionId) {
    expect(adapter.getCopilotSessionId()).toEqual(sessionId.captured);
    const nativeResult = JSON.parse((response.raw as string).trim().split('\n').at(-1)!) as Record<string, unknown>;
    if (sessionId.json === undefined) expect(nativeResult).not.toHaveProperty('sessionId');
    else expect(nativeResult['sessionId']).toEqual(JSON.parse(sessionId.json));
  } else {
    expect(adapter.getCopilotSessionId()).toBe('native-session');
  }

  const completionCalls = log.mock.calls.filter(call => call[2] === 'Copilot turn complete');
  const completions = manager.getRecentLogs().filter(entry => entry.message === 'Copilot turn complete');
  expect(completionCalls).toHaveLength(1);
  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({ level: 'debug', subsystem: 'CopilotCliAdapter' });
  const raw = inspect({ log: log.mock.calls, logError: logError.mock.calls }, { depth: null });
  expect(raw).not.toContain(marker);
  expect(JSON.stringify(manager.getRecentLogs())).not.toContain(marker);
  return { rawData: completionCalls[0][3], sinkData: completions[0].data, response };
}

function stringDescription(value: string) {
  return {
    valueKind: 'string', textChars: value.length,
    textHash: createHash('sha256').update(value.slice(0, 8192)).digest('hex').slice(0, 16),
  };
}

const longSource = `${marker}${'x'.repeat(9000)}`;
const malformedCases = [
  { name: 'source string', json: JSON.stringify(marker), diagnostic: stringDescription(marker) },
  { name: 'empty string', json: '""', diagnostic: stringDescription('') },
  { name: 'long source string', json: JSON.stringify(longSource), diagnostic: stringDescription(longSource) },
  { name: 'nested object', json: JSON.stringify({ [marker]: { body: marker } }), diagnostic: { valueKind: 'object' } },
  { name: 'nested array', json: JSON.stringify([marker, { body: marker }]), diagnostic: { valueKind: 'array' } },
  { name: 'null', json: 'null', diagnostic: { valueKind: 'null' } },
  { name: 'true', json: 'true', diagnostic: { valueKind: 'boolean' } },
  { name: 'false', json: 'false', diagnostic: { valueKind: 'boolean' } },
  // Valid JSON number grammar can overflow JS numeric range at the native parser.
  { name: 'positive nonfinite exponent', json: '1e400', diagnostic: { valueKind: 'number' } },
  { name: 'negative nonfinite exponent', json: '-1e400', diagnostic: { valueKind: 'number' } },
  { name: 'missing', json: undefined, diagnostic: undefined },
];

describe('Copilot native usage diagnostic boundary', () => {
  it.each(fields.flatMap(field => malformedCases.map(test => ({ field, ...test }))))(
    'describes $name in $field without logging source or changing native usage',
    async ({ field, json, diagnostic }) => {
      const usageJson = '{' + fields.flatMap(key => {
        if (key === field) return json === undefined ? [] : [`"${key}":${json}`];
        return [`"${key}":${key === 'premiumRequests' ? 1 : key === 'totalApiDurationMs' ? 20 : 30}`];
      }).join(',') + '}';
      const { rawData, sinkData, response } = await nativeTurn(usageJson);
      const expected = { sessionId: 'native-session', premiumRequests: 1, totalApiDurationMs: 20, sessionDurationMs: 30, [field]: diagnostic };
      expect(rawData).toEqual(expected);
      expect(sinkData).toEqual(expected);
      const nativeResult = JSON.parse((response.raw as string).trim().split('\n').at(-1)!) as { usage: Record<string, unknown> };
      expect(nativeResult.usage).toEqual(JSON.parse(usageJson));
    },
  );

  it('retains finite numeric metrics exactly, including zero and fractional values', async () => {
    const { rawData, sinkData } = await nativeTurn('{"premiumRequests":0,"totalApiDurationMs":20.5,"sessionDurationMs":-3}');
    const expected = { sessionId: 'native-session', premiumRequests: 0, totalApiDurationMs: 20.5, sessionDurationMs: -3 };
    expect(rawData).toEqual(expected);
    expect(sinkData).toEqual(expected);
  });

  it('retains absent optional counters on an empty native usage object', async () => {
    const { rawData, sinkData } = await nativeTurn('{}');
    const expected = { sessionId: 'native-session', premiumRequests: undefined, totalApiDurationMs: undefined, sessionDurationMs: undefined };
    expect(rawData).toEqual(expected);
    expect(sinkData).toEqual(expected);
  });

  it('projects source counters when the final result has no newline', async () => {
    const { rawData, sinkData } = await nativeTurn(JSON.stringify({
      premiumRequests: marker, totalApiDurationMs: { body: marker }, sessionDurationMs: [marker],
    }), false);
    const expected = {
      sessionId: 'native-session', premiumRequests: stringDescription(marker),
      totalApiDurationMs: { valueKind: 'object' }, sessionDurationMs: { valueKind: 'array' },
    };
    expect(rawData).toEqual(expected);
    expect(sinkData).toEqual(expected);
  });

  it('keeps generic logger source retention as a positive control', () => {
    manager.getLogger('CopilotUsagePositiveControl').debug('generic source control', { body: marker });
    expect(inspect(log.mock.calls, { depth: null })).toContain(marker);
    expect(manager.getRecentLogs().find(entry => entry.message === 'generic source control')?.data?.['body'])
      .toBe(marker);
  });
});

const resultSessionCases = [
  { name: 'native string', json: '"native-session-metadata"', captured: 'native-session-metadata', diagnostic: 'native-session-metadata' },
  { name: 'empty string', json: '""', captured: null, diagnostic: '' },
  { name: 'missing', json: undefined, captured: null, diagnostic: undefined },
  { name: 'nested object', json: JSON.stringify({ [marker]: { body: marker } }), captured: { [marker]: { body: marker } }, diagnostic: { valueKind: 'object' } },
  { name: 'nested array', json: JSON.stringify([marker, { body: marker }]), captured: [marker, { body: marker }], diagnostic: { valueKind: 'array' } },
  { name: 'null', json: 'null', captured: null, diagnostic: { valueKind: 'null' } },
  { name: 'true', json: 'true', captured: true, diagnostic: { valueKind: 'boolean' } },
  { name: 'false', json: 'false', captured: null, diagnostic: { valueKind: 'boolean' } },
  { name: 'zero', json: '0', captured: null, diagnostic: { valueKind: 'number' } },
  { name: 'fractional number', json: '20.5', captured: 20.5, diagnostic: { valueKind: 'number' } },
  { name: 'negative number', json: '-3', captured: -3, diagnostic: { valueKind: 'number' } },
  { name: 'positive nonfinite exponent', json: '1e400', captured: Infinity, diagnostic: { valueKind: 'number' } },
  { name: 'negative nonfinite exponent', json: '-1e400', captured: -Infinity, diagnostic: { valueKind: 'number' } },
];

describe('Copilot native result session diagnostic boundary', () => {
  it.each(resultSessionCases)('retains useful IDs and safely describes $name without changing native session state', async test => {
    const { rawData, sinkData } = await nativeTurn('{"premiumRequests":1,"totalApiDurationMs":20,"sessionDurationMs":30}', true, test);
    const expected = { sessionId: test.diagnostic, premiumRequests: 1, totalApiDurationMs: 20, sessionDurationMs: 30 };
    expect(rawData).toEqual(expected);
    expect(sinkData).toEqual(expected);
  });

  it('describes a malformed ID when the final result has no newline', async () => {
    const { rawData, sinkData } = await nativeTurn('{"premiumRequests":1,"totalApiDurationMs":20,"sessionDurationMs":30}', false, {
      json: JSON.stringify({ body: marker }), captured: { body: marker },
    });
    const expected = { sessionId: { valueKind: 'object' }, premiumRequests: 1, totalApiDurationMs: 20, sessionDurationMs: 30 };
    expect(rawData).toEqual(expected);
    expect(sinkData).toEqual(expected);
  });
});

describe('Copilot native resume argument diagnostic boundary', () => {
  // Removing the spawn-log projection leaks native object/array source on the next turn.
  // The disposable child proves Node delivery, not real Copilot account resume compatibility.
  it.each([
    { name: 'useful native ID', sessionId: 'native-session-first', argvResume: 'native-session-first', diagnostic: 'native-session-first', newline: true },
    { name: 'nested object', sessionId: { [marker]: { body: marker } }, argvResume: '[object Object]', diagnostic: { valueKind: 'object' }, newline: true },
    { name: 'nested array', sessionId: [marker, { body: marker }], argvResume: marker + ',[object Object]', diagnostic: { valueKind: 'array' }, newline: true },
    { name: 'unterminated result object', sessionId: { body: marker }, argvResume: '[object Object]', diagnostic: { valueKind: 'object' }, newline: false },
  ])('safely logs $name across two native turns while preserving delivery', async ({ sessionId, argvResume, diagnostic, newline }) => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-copilot-resume-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const receipt = join(dir, 'receipts.json');
    const child = join(dir, 'child.cjs');
    const usage = { premiumRequests: 1, totalApiDurationMs: 20, sessionDurationMs: 30 };
    const results = [
      { type: 'result', sessionId, exitCode: 0, usage },
      { type: 'result', sessionId: 'native-session-second', exitCode: 0, usage },
    ];
    const stdout = results.map((result, i) => JSON.stringify({
      type: 'assistant.message', data: { messageId: `native-answer-${i}`, content: 'native answer', outputTokens: 7 },
    }) + '\n' + JSON.stringify(result) + (i !== 0 || newline ? '\n' : ''));
    writeFileSync(child, `const fs = require('node:fs');
      const file = ${JSON.stringify(receipt)};
      const receipts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      const turn = receipts.length;
      receipts.push(process.argv.slice(2));
      fs.writeFileSync(file, JSON.stringify(receipts));
      process.stdout.write(${JSON.stringify(stdout)}[turn]);`);
    const adapter = new CopilotCliAdapter({ workingDir: dir });
    const access = adapter as unknown as { config: CliAdapterConfig; spawnProcess(args: string[]): ChildProcess };
    access.config = { ...access.config, command: process.execPath, args: [child] };
    Object.assign(adapter, { launchResolved: true });
    cleanup.push(() => adapter.terminate(false));
    const spawn = vi.spyOn(access, 'spawnProcess'); // Call through to the real native child.
    const output: OutputMessage[] = [];
    const context: ContextUsage[] = [];
    const complete: CliResponse[] = [];
    const errors: Error[] = [];
    adapter.on('output', message => output.push(message));
    adapter.on('context', value => context.push(value));
    adapter.on('complete', response => complete.push(response));
    adapter.on('error', error => errors.push(error));
    const prompts = [`first ${marker}`, `second ${marker}`];
    const first = await adapter.sendMessage({ role: 'user', content: prompts[0] });
    expect(first.content).toBe('native answer');
    expect(first.raw).toBe(stdout[0]);
    expect(adapter.getCopilotSessionId()).toEqual(sessionId);
    const second = await adapter.sendMessage({ role: 'user', content: prompts[1] });
    expect(second.content).toBe('native answer');
    expect(second.raw).toBe(stdout[1]);
    expect(complete).toHaveLength(2);
    expect(complete[0]).toBe(first);
    expect(complete[1]).toBe(second);
    expect(output.filter(message => message.type === 'assistant').map(message => message.content))
      .toEqual(['native answer', 'native answer']);
    expect(errors).toEqual([]);
    expect(adapter.getCopilotSessionId()).toBe('native-session-second');
    const argv = JSON.parse(readFileSync(receipt, 'utf8')) as string[][];
    expect(argv).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(argv[0]).not.toContain('--resume');
    for (let i = 0; i < 2; i++) {
      expect(argv[i][argv[i].indexOf('--prompt') + 1]).toBe(prompts[i]);
      expect(JSON.parse(([first, second][i].raw as string).trim().split('\n').at(-1)!)).toEqual(results[i]);
      expect([first, second][i].usage).toMatchObject({ inputTokens: 0, outputTokens: 7, totalTokens: 7 });
      expect([first, second][i].usage?.duration).toEqual(expect.any(Number));
    }
    expect(argv[1][argv[1].indexOf('--resume') + 1]).toBe(argvResume);
    const runtimeArgs = spawn.mock.calls[1][0];
    expect(runtimeArgs[runtimeArgs.indexOf('--resume') + 1]).toEqual(sessionId);
    expect(context).toEqual([
      { used: 4, total: 128_000, percentage: 0.003125, cumulativeTokens: 4, isEstimated: true },
      { used: 8, total: 128_000, percentage: 0.00625, cumulativeTokens: 8, isEstimated: true },
    ]);

    // Exact flags and useful native ID survive only the diagnostic projection.
    const flags = ['--allow-all-tools', '--allow-all-paths', '--allow-all-urls', '--output-format', 'json',
      '--stream', 'on', '--no-auto-update', '--log-level', 'none', '-s'];
    const expected = [
      { args: [...flags, '--prompt', '<redacted 36 chars>'], hasResumeId: false },
      { args: [...flags, '--resume', diagnostic, '--prompt', '<redacted 37 chars>'], hasResumeId: true },
    ];
    const spawnCalls = log.mock.calls.filter(call => call[2] === 'Spawning copilot');
    const spawnRows = manager.getRecentLogs().filter(row => row.message === 'Spawning copilot');
    expect(spawnCalls.map(call => call[3])).toEqual(expected);
    expect(spawnRows.map(row => row.data)).toEqual(expected);
    expect(inspect({ log: log.mock.calls, logError: logError.mock.calls }, { depth: null })).not.toContain(marker);
    expect(JSON.stringify(manager.getRecentLogs())).not.toContain(marker);
  });
});
