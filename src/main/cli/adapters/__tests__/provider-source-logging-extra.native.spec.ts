// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { inspect } from 'node:util';
import { getLogManager } from '../../../logging/logger';
import { CodexCliAdapter } from '../codex-cli-adapter';
import { CopilotCliAdapter, resetCopilotModelDiscoveryCache } from '../copilot-cli-adapter';
import { CursorCliAdapter } from '../cursor-cli-adapter';
import { _resetCursorModelCacheForTesting } from '../cursor-cli-adapter.models';
import { connectToAppServer } from '../codex/app-server-client';
import type { AppServerClient } from '../codex/app-server-client';
import type { BaseCliAdapter, CliAdapterConfig } from '../base-cli-adapter';
import type { OutputMessage } from '../../../../shared/types/instance.types';

const marker = 'SYNTHETIC_EXTRA_SOURCE_MARKER';
const prompt = `Native input ${marker}`;
const manager = getLogManager();
const cleanup: (() => void | Promise<void>)[] = [];
let log: ReturnType<typeof vi.spyOn>;
let logError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  manager.updateConfig({ globalLevel: 'debug', enableConsole: false, enableFile: false });
  manager.clearBuffer();
  log = vi.spyOn(manager, 'log'); logError = vi.spyOn(manager, 'logError');
  resetCopilotModelDiscoveryCache(); _resetCursorModelCacheForTesting();
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); manager.clearBuffer();
});
function verify(label: string, messages: string[]) {
  const entries = manager.getRecentLogs();
  const raw = inspect({ log: log.mock.calls, logError: logError.mock.calls }, { depth: null });
  expect(JSON.stringify(entries), label).not.toContain(marker);
  expect(raw, label).not.toContain(marker);
  for (const message of messages) {
    const matching = entries.filter(entry => entry.message === message);
    expect(matching.length, label).toBeGreaterThan(0);
    for (const entry of matching) {
      expect(entry.data?.['textChars']).toEqual(expect.any(Number));
      expect(entry.data?.['textHash']).toMatch(/^[a-f0-9]{16}$/);
      expect(entry.error).toBeUndefined();
    }
  }
}
function fixture(code: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-native-extra-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const receipt = join(dir, 'receipt.json');
  const path = join(dir, 'fixture.cjs');
  writeFileSync(path, `const fs = require('node:fs'); const receipt = ${JSON.stringify(receipt)}; const marker = ${JSON.stringify(marker)}; ${code}`);
  return { dir, path, receipt };
}
function redirect<T extends BaseCliAdapter>(adapter: T, path: string) {
  const access = adapter as unknown as { config: CliAdapterConfig };
  access.config = { ...access.config, command: process.execPath, args: [path] };
  const output: OutputMessage[] = [];
  adapter.on('output', (message: OutputMessage) => output.push(message));
  adapter.on('error', () => undefined);
  cleanup.push(() => adapter.terminate(false));
  return { adapter, output };
}
const goodExec = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: marker } }) + '\n';

async function rpcFixture(mode: string) {
  const native = fixture(`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const requests = [];
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const notify = (method, params) => send({ method, params });
    rl.on('line', line => {
      const request = JSON.parse(line); requests.push(request); fs.writeFileSync(receipt, JSON.stringify(requests));
      if (!request.id) return;
      if (request.method === 'initialize') return send({ id: request.id, result: {} });
      if (request.method === 'thread/resume') return send({ id: request.id, error: { code: -32000, message: 'thread not found ' + marker } });
      if (request.method === 'thread/start') {
        if (${JSON.stringify(mode)} === 'init-error') return send({ id: request.id, error: { code: -32000, message: marker } });
        send({ id: request.id, result: { threadId: 'fixture-thread' } });
        if (${JSON.stringify(mode)} === 'malformed') process.stdout.write('{ malformed ' + marker + '\\n');
        if (${JSON.stringify(mode)} === 'observer') setTimeout(() => notify(marker, { text: marker }), 20);
        if (${JSON.stringify(mode)} === 'provider-exit') setTimeout(() => { notify('turn/started', { threadId: 'fixture-thread', turn: { id: 'provider-turn', status: 'inProgress' } }); setTimeout(() => { process.stderr.write(marker); process.exit(1); }, 20); }, 20);
        if (${JSON.stringify(mode)} === 'handler') setTimeout(() => send({ id: 'native-request', method: marker, params: { text: marker } }), 20);
        return;
      }
      if (request.method === 'thread/goal/get') {
        if (${JSON.stringify(mode)} === 'pause-error') return send({ id: request.id, error: { code: -32000, message: marker } });
        return send({ id: request.id, result: { goal: null } });
      }
      if (request.method === 'turn/start') {
        send({ id: request.id, result: { turn: { id: 'fixture-turn', status: 'inProgress' } } });
        if (${JSON.stringify(mode)} === 'exit-error') {
          notify('turn/started', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'inProgress' } });
          process.stderr.write(marker); return setTimeout(() => process.exit(1), 20);
        }
        notify('item/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: marker } });
        return notify('turn/completed', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } });
      }
      send({ id: request.id, result: {} });
    });
    rl.on('close', () => process.exit(0));
  `);
  // A disposable executable shadows codex only in the native child's env.
  const executable = join(native.dir, 'codex');
  writeFileSync(executable, `#!${process.execPath}\n${readFileSync(native.path, 'utf8')}`, { mode: 0o700 });
  if (process.platform === 'win32') {
    writeFileSync(join(native.dir, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${native.path}" %*\r\n`);
  }
  const adapter = new CodexCliAdapter({ workingDir: native.dir, timeout: 1_000, ...(mode === 'resume' ? { resume: true, sessionId: 'disposable-thread' } : {}), env: { CODEX_HOME: native.dir } });
  const access = adapter as unknown as { connectAppServer(cwd: string): Promise<AppServerClient>; initAppServerMode(): Promise<void>; useAppServer: boolean; isSpawned: boolean };
  access.connectAppServer = cwd => connectToAppServer(cwd, { disableBroker: true, env: { PATH: `${native.dir}${delimiter}${process.env['PATH'] ?? ''}` } });
  const output: OutputMessage[] = []; const errors: Error[] = []; const exits: unknown[] = [];
  adapter.on('output', (message: OutputMessage) => output.push(message));
  adapter.on('turn_error', (error: Error) => errors.push(error));
  adapter.on('exit', (...args) => exits.push(args));
  cleanup.push(() => adapter.terminate(false));
  if (mode === 'init-error') {
    vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true, metadata: { appServerAvailable: true } });
    await adapter.spawn();
  } else {
    await access.initAppServerMode(); access.useAppServer = true; access.isSpawned = true;
  }
  return { adapter, output, errors, exits, receipt: native.receipt };
}

// Codex uses the shipped native class. Copilot/Cursor cover supported legacy CLI
// classes; their selected provider routes currently use ACP (covered separately).
describe('additional native provider logging boundaries', () => {
  it.each(['banner', 'error', 'malformed', 'unknown', 'models'] as const)('Copilot native %s logging preserves payloads', async mode => {
    const stdout = `${mode === 'malformed' ? `{ malformed ${marker}\n` : ''}${mode === 'unknown' ? JSON.stringify({ type: marker, data: marker }) + '\n' : ''}${JSON.stringify({ type: 'assistant.message', data: { content: marker } })}\n`;
    const stderr = `${mode === 'error' ? 'Error: ' : 'Banner: '}${marker}`;
    const native = fixture(`fs.writeFileSync(receipt, JSON.stringify(process.argv.slice(2))); process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${mode === 'models' ? 1 : 0});`);
    const { adapter, output } = redirect(new CopilotCliAdapter({ workingDir: native.dir }), native.path);
    Object.assign(adapter, { launchResolved: true });
    if (mode === 'models') expect((await adapter.listAvailableModels()).length).toBeGreaterThan(0);
    else {
      const response = await adapter.sendMessage({ role: 'user', content: prompt });
      expect(response.content).toBe(marker); expect(output.some(message => message.content.includes(marker))).toBe(true);
      expect(readFileSync(native.receipt, 'utf8')).toContain(prompt);
    }
    verify(`copilot-${mode}`, [mode === 'models' ? 'Falling back to default Copilot model list' : mode === 'malformed' ? 'Failed to parse Copilot stream-json line' : mode === 'unknown' ? 'Unhandled copilot event type' : 'copilot stderr']);
  });

  it.each(['error', 'keychain', 'models'] as const)('Cursor native %s logging preserves payloads', async mode => {
    const stderr = `${mode === 'keychain' ? 'SecItemCopyMatching failed: ' : 'Error: '}${marker}`;
    const stdout = JSON.stringify({ type: 'result', result: marker }) + '\n';
    const native = fixture(`fs.writeFileSync(receipt, JSON.stringify(process.argv.slice(2))); process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${mode === 'models' ? 1 : 0});`);
    const { adapter, output } = redirect(new CursorCliAdapter({ workingDir: native.dir }), native.path);
    if (mode === 'models') expect((await adapter.listAvailableModels()).length).toBeGreaterThan(0);
    else {
      await adapter.spawn();
      const response = await adapter.sendMessage({ role: 'user', content: prompt });
      expect(response.content).toBe(marker);
      if (mode === 'error') await vi.waitFor(() => expect(output.some(message => message.content.includes(stderr))).toBe(true));
      else await vi.waitFor(() => expect(output.some(message => message.content.toLowerCase().includes('keychain'))).toBe(true));
      expect(readFileSync(native.receipt, 'utf8')).toContain(prompt);
    }
    verify(`cursor-${mode}`, [mode === 'models' ? 'Falling back to default Cursor model list' : mode === 'keychain' ? 'cursor-agent keychain issue' : 'cursor-agent stderr']);
  });

  it.each(['transient', 'model', 'resume', 'timeout', 'malformed'] as const)('Codex exec native %s logging keeps source out of sink', async mode => {
    const firstError = mode === 'model' ? 'unknown model ' + marker : mode === 'resume' ? 'thread not found ' + marker : 'transient error ' + marker;
    const native = fixture(`let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
      const previous = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : []; previous.push(input); fs.writeFileSync(receipt, JSON.stringify(previous));
      if (${JSON.stringify(mode)} === 'timeout') { process.stderr.write('network error ' + marker + '\\n'); process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: marker } }) + '\\n'); return setInterval(() => {}, 1000); }
      if (${JSON.stringify(mode)} === 'malformed') process.stdout.write('{ malformed ' + marker + '\\n');
      if (${JSON.stringify(mode)} !== 'malformed' && previous.length === 1) { process.stderr.write(${JSON.stringify(firstError)} + '\\n'); return process.exit(1); }
      process.stdout.write(${JSON.stringify(goodExec)});
    });`);
    const { adapter, output } = redirect(new CodexCliAdapter({ workingDir: native.dir, timeout: mode === 'timeout' ? 1_000 : 3_000, ...(mode === 'model' ? { model: 'fixture-model' } : {}), ...(mode === 'resume' ? { resume: true, sessionId: 'disposable-thread' } : {}) }), native.path);
    if (mode === 'timeout') {
      await expect(adapter.sendMessage({ role: 'user', content: prompt })).rejects.toThrow(marker);
      expect(output.some(message => message.content.includes(marker))).toBe(true);
    } else expect((await adapter.sendMessage({ role: 'user', content: prompt })).content).toBe(marker);
    expect(readFileSync(native.receipt, 'utf8')).toContain(prompt);
    verify(`codex-exec-${mode}`, [mode === 'timeout' ? 'Codex exec timed out — not retrying' : mode === 'model' ? 'Codex rejected the requested model; retrying with codex default model' : mode === 'resume' ? 'Codex exec resume failed, retrying with a fresh session' : mode === 'malformed' ? 'Failed to parse Codex exec JSONL line' : 'Codex exec threw transient error, retrying']);
  });

  it.each(['malformed', 'resume', 'pause-error', 'init-error', 'observer', 'handler', 'exit-error', 'provider-exit'] as const)('Codex native app-server %s logging keeps source out of sink', async mode => {
    const { adapter, output, errors, exits, receipt } = await rpcFixture(mode);
    const access = adapter as unknown as { appServerClient: AppServerClient };
    if (mode === 'observer') access.appServerClient.subscribeNotifications(notification => { if (String(notification.method) === marker) throw new Error(marker, { cause: marker }); });
    if (mode === 'handler') access.appServerClient.setServerRequestHandler(() => { throw new Error(marker, { cause: marker }); });
    if (mode === 'provider-exit') {
      await vi.waitFor(() => expect(exits.length).toBe(1));
      expect(errors).toEqual([]);
      expect(manager.getRecentLogs().some(entry => entry.message === 'Following a turn Codex started by itself')).toBe(true);
    } else if (mode === 'pause-error') await expect(adapter.stopProviderAutoContinuation()).resolves.toBe(false);
    else if (mode === 'exit-error') {
      await expect(adapter.sendInput(prompt)).rejects.toThrow(marker);
      expect(output.some(message => message.content.includes(marker))).toBe(true);
      await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0));
    } else if (mode !== 'init-error') {
      if (mode === 'observer' || mode === 'handler') await vi.waitFor(() => expect(manager.getRecentLogs().some(entry => entry.message.includes(mode === 'observer' ? 'observer failed' : 'handler failed'))).toBe(true));
      await adapter.sendInput(prompt);
      expect(output.some(message => message.type === 'assistant' && message.content.includes(marker))).toBe(true);
      expect(readFileSync(receipt, 'utf8')).toContain(prompt);
    } else expect(adapter.isAppServerMode()).toBe(false);
    expect(errors.length).toBeLessThanOrEqual(1);
    verify(`codex-app-${mode}`, [mode === 'provider-exit' ? 'A turn Codex started by itself ended without completing' : mode === 'malformed' ? 'Failed to parse JSONL line from app-server' : mode === 'resume' ? 'Persisted cursor resume failed (recoverable), falling back to fresh thread' : mode === 'pause-error' ? 'Could not pause the Codex thread goal after a stop' : mode === 'init-error' ? 'App-server initialization failed, falling back to exec mode' : mode === 'observer' ? 'App-server notification observer failed' : mode === 'handler' ? 'App-server request handler failed' : 'App-server process exited, forwarding to adapter exit event']);
  });
});
