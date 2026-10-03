// @vitest-environment node
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFixtureSpawns, ProcessFixtureRegistry } from '../../../../tests/fixtures/process-fixture';
import type { OutputMessage } from '../../../../shared/types/instance.types';
import { getLogManager } from '../../../logging/logger';
import { AcpCliAdapter } from '../acp-cli-adapter';
import type { CliResponse } from '../base-cli-adapter';
import { normalizeAcpAvailableCommands } from '../acp-session-update-normalizers';

const keyMarker = 'SYNTHETIC_ACP_COMMAND_SOURCE_KEY';
const valueMarker = 'SYNTHETIC_ACP_COMMAND_SOURCE_VALUE';
const manager = getLogManager();
const fixtures = new ProcessFixtureRegistry();
const children: ChildProcess[] = [];
const cleanup: (() => void | Promise<void>)[] = [];
let restoreCapture: () => void;
let previousConfig: ReturnType<typeof manager.getConfig>;
let log: ReturnType<typeof vi.spyOn>;
let logError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  previousConfig = manager.getConfig();
  manager.updateConfig({ globalLevel: 'debug', enableConsole: false, enableFile: false });
  manager.clearBuffer();
  log = vi.spyOn(manager, 'log');
  logError = vi.spyOn(manager, 'logError');
  restoreCapture = captureFixtureSpawns(fixtures, child => children.push(child));
});

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    try { await fixtures.cleanup(); } finally {
      restoreCapture();
      children.length = 0;
      vi.restoreAllMocks();
      manager.clearBuffer();
      manager.updateConfig(previousConfig);
    }
  }
});

const catalog = ['  trimmed-command  ', { name: valueMarker, description: valueMarker }];
const cases = [
  { name: 'camelCase catalog', fields: { availableCommands: catalog }, commandCount: 2 },
  { name: 'legacy catalog', fields: { commands: catalog }, commandCount: 2 },
  { name: 'canonical precedence', fields: { availableCommands: ['canonical'], commands: catalog }, commandCount: 1 },
  { name: 'null canonical fallback', fields: { availableCommands: null, commands: catalog }, commandCount: 2 },
  { name: 'missing catalog', fields: {}, commandCount: 0, keyCount: 2 },
  { name: 'null catalog', fields: { availableCommands: null }, commandCount: 0, keyCount: 3 },
  { name: 'source string catalog', fields: { availableCommands: valueMarker }, commandCount: 0, keyCount: 3 },
  { name: 'source object catalog', fields: { availableCommands: { [keyMarker]: { body: valueMarker } } }, commandCount: 0, keyCount: 3 },
  { name: 'boolean catalog', fields: { availableCommands: false }, commandCount: 0, keyCount: 3 },
  { name: 'numeric catalog', fields: { availableCommands: 42 }, commandCount: 0, keyCount: 3 },
  { name: 'malformed canonical blocks legacy fallback', fields: { availableCommands: { body: valueMarker }, commands: catalog }, commandCount: 0, keyCount: 4 },
  { name: 'empty canonical blocks legacy fallback', fields: { availableCommands: [], commands: catalog }, commandCount: 0 },
  { name: 'mixed catalog entries', fields: { availableCommands: [null, false, 42, [], {}, '', '  ', { name: 42 }, { name: 'valid', description: { body: valueMarker } }, ' trimmed-command '] }, commandCount: 2 },
];

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'aio-acp-command-diagnostics-'));
  cleanup.push(async () => {
    await fixtures.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Keep native spawn, stdin callbacks, stdout framing, normalization and Logger real. */
async function nativeTurns(fields: Record<string, unknown>) {
  const dir = temporaryDirectory();
  const receipt = join(dir, 'receipt.json');
  const child = join(dir, 'child.cjs');
  const updates = [
    { sessionUpdate: 'available_commands_update', availableCommands: catalog },
    { sessionUpdate: 'available_commands_update', ...fields, [keyMarker]: { body: valueMarker } },
  ];
  writeFileSync(child, String.raw`const fs = require('node:fs');
    const requests = [];
    const updates = ${JSON.stringify(updates)};
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
    const notify = update => send({ method: 'session/update', params: { sessionId: 'native-session', update } });
    const rl = require('node:readline').createInterface({ input: process.stdin });
    let turn = 0;
    rl.on('line', line => {
      const request = JSON.parse(line);
      requests.push(request);
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(requests));
      if (request.method === 'initialize') return send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
      if (request.method === 'session/new') return send({ id: request.id, result: { sessionId: 'native-session' } });
      if (request.method === 'session/prompt') {
        notify(updates[turn]);
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native answer ' + (++turn) } });
        return send({ id: request.id, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } });
      }
    });
    rl.on('close', () => process.exit(0));`);
  const adapter = new AcpCliAdapter({
    command: process.execPath, args: [child], adapterName: 'native-acp', workingDirectory: dir,
  });
  cleanup.push(() => adapter.terminate(false));
  const output: OutputMessage[] = [];
  const errors: Error[] = [];
  const statuses: string[] = [];
  const complete: CliResponse[] = [];
  let heartbeats = 0;
  adapter.on('output', message => output.push(message));
  adapter.on('error', error => errors.push(error));
  adapter.on('status', status => statuses.push(status));
  adapter.on('complete', response => complete.push(response));
  adapter.on('heartbeat', () => { heartbeats += 1; });
  await adapter.spawn();
  expect(children).toHaveLength(1);
  const wire: string[] = [];
  children[0].stdout!.on('data', chunk => wire.push(String(chunk)));
  const prompts = [`first ${valueMarker}`, `second ${valueMarker}`];
  const first = await adapter.sendMessage({ role: 'user', content: prompts[0] });
  const second = await adapter.sendMessage({ role: 'user', content: prompts[1] });

  // Regressions in native acceptance or silent metadata must fail before privacy assertions.
  expect(first.content).toBe('native answer 1');
  expect(second.content).toBe('native answer 2');
  expect(complete).toHaveLength(2);
  expect(complete[0]).toBe(first);
  expect(complete[1]).toBe(second);
  expect(output.map(message => [message.type, message.content, message.metadata?.['streaming']])).toEqual([
    ['assistant', 'native answer 1', true], ['assistant', 'native answer 1', false],
    ['assistant', 'native answer 2', true], ['assistant', 'native answer 2', false],
  ]);
  expect(errors).toEqual([]);
  expect(statuses).toEqual(['ready', 'busy', 'idle', 'busy', 'idle']);
  expect(heartbeats).toBe(4);
  expect(adapter.getSessionId()).toBe('native-session');
  for (const response of [first, second]) {
    expect(response.usage).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(response.metadata?.['stopReason']).toBe('end_turn');
    expect(response.metadata?.['turnEnding']).toMatchObject({ reason: 'completed' });
  }
  const requests = JSON.parse(readFileSync(receipt, 'utf8')) as { method: string; params: unknown }[];
  expect(requests.map(request => request.method)).toEqual(['initialize', 'session/new', 'session/prompt', 'session/prompt']);
  expect(requests.slice(2).map(request => request.params)).toEqual([
    { sessionId: 'native-session', prompt: [{ type: 'text', text: prompts[0] }] },
    { sessionId: 'native-session', prompt: [{ type: 'text', text: prompts[1] }] },
  ]);
  const packets = wire.join('').trim().split('\n').map(line => JSON.parse(line)) as { params?: { update?: { sessionUpdate: string } } }[];
  expect(packets.filter(packet => packet.params?.update?.sessionUpdate === 'available_commands_update')
    .map(packet => packet.params?.update)).toEqual(updates);
  await adapter.terminate(false);
  await fixtures.waitForExit();
  expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
  return dir;
}

describe('ACP native available-command diagnostics', () => {
  // Restoring raw Object.keys(update) leaks the source key in all three sinks.
  it.each(cases)('preserves $name while keeping native source out of diagnostics', async test => {
    const dir = await nativeTurns(test.fields);
    const counts = manager.getRecentLogs().filter(entry => entry.message === 'ACP available_commands_update');
    expect(counts.map(entry => entry.data?.['commandCount'])).toEqual([2, test.commandCount]);
    const missing = manager.getRecentLogs().filter(entry => entry.message === 'ACP available_commands_update missing commands array');
    expect(missing.map(entry => entry.data)).toEqual(test.keyCount === undefined ? [] : [{ keyCount: test.keyCount }]);
    const rawMissing = log.mock.calls.filter(call => call[2] === 'ACP available_commands_update missing commands array');
    expect(rawMissing.map(call => call[3])).toEqual(test.keyCount === undefined ? [] : [{ keyCount: test.keyCount }]);
    const exported = join(dir, 'logs.jsonl');
    manager.exportLogs(exported);
    for (const source of [keyMarker, valueMarker]) {
      expect(inspect({ log: log.mock.calls, logError: logError.mock.calls }, { depth: null })).not.toContain(source);
      expect(JSON.stringify(manager.getRecentLogs())).not.toContain(source);
      expect(readFileSync(exported, 'utf8')).not.toContain(source);
    }
  });

  it.each(['availableCommands', 'commands'])('retains exact tolerant %s parsing', field => {
    const update = { [field]: [
      '  trimmed-command  ', { name: valueMarker, description: valueMarker },
      { name: 'valid', description: { body: valueMarker } }, null, false, 42, [], {}, '', ' ', { name: 42 },
    ] };
    expect(normalizeAcpAvailableCommands(update)).toEqual([
      { name: 'trimmed-command' }, { name: valueMarker, description: valueMarker },
      { name: 'valid', description: undefined },
    ]);
  });

  it('keeps ordinary source retention in the generic Logger as a positive control', () => {
    const dir = temporaryDirectory();
    manager.getLogger('AvailableCommandsPositiveControl').debug('generic source control', { [keyMarker]: valueMarker });
    const exported = join(dir, 'logs.jsonl');
    manager.exportLogs(exported);
    for (const source of [keyMarker, valueMarker]) {
      expect(inspect(log.mock.calls, { depth: null })).toContain(source);
      expect(JSON.stringify(manager.getRecentLogs())).toContain(source);
      expect(readFileSync(exported, 'utf8')).toContain(source);
    }
  });
});
