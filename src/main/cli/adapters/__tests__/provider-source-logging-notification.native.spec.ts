// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { getLogManager } from '../../../logging/logger';
import { CodexCliAdapter } from '../codex-cli-adapter';
import { connectToAppServer, type AppServerClient } from '../codex/app-server-client';
import { CopilotServerSession } from '../copilot/copilot-server-session';
import { CopilotServerTurnBridge } from '../copilot/copilot-server-turn-bridge';
import type { CopilotSdkClientLike, CopilotSdkSessionLike, LoadedCopilotSdk } from '../copilot/copilot-sdk-loader';
import type { OutputMessage } from '../../../../shared/types/instance.types';

const marker = 'SYNTHETIC_NOTIFICATION_SOURCE_MARKER';
const prompt = `Preserve native prompt ${marker}`;
const manager = getLogManager();
const cleanup: (() => Promise<void> | void)[] = [];
let log: ReturnType<typeof vi.spyOn>;
let logError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  manager.updateConfig({ globalLevel: 'debug', enableConsole: false, enableFile: false });
  manager.clearBuffer(); log = vi.spyOn(manager, 'log'); logError = vi.spyOn(manager, 'logError');
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); manager.clearBuffer(); });
function verify(label: string, message: string) {
  const entries = manager.getRecentLogs();
  const raw = inspect({ log: log.mock.calls, logError: logError.mock.calls }, { depth: null });
  const entry = entries.find(entry => entry.message === message);
  expect(entry?.data).toMatchObject(expectedDiagnostics(label));
  expect(JSON.stringify(entries)).not.toContain(marker); expect(raw).not.toContain(marker);
}
// Independent source expectations prove the diagnostic remains useful after payload removal.
function diagnostic(text: string) {
  return { textChars: text.length, textHash: createHash('sha256').update(text.slice(0, 8192)).digest('hex').slice(0, 16) };
}
function expectedDiagnostics(label: string): Record<string, unknown> {
  if (label === 'native-mismatch') return { streamed: diagnostic(`Draft ${marker}`), final: diagnostic(`Final ${marker}`) };
  if (label === 'native-retry' || label === 'native-terminal') return {
    ...diagnostic(`Provider message ${marker}`), additionalDetails: diagnostic(`Provider details ${marker}`),
    codexErrorInfo: diagnostic(JSON.stringify({ serverOverloaded: { httpStatusCode: 503, body: marker } })),
    willRetry: label === 'native-retry',
  };
  const sources: Record<string, string> = {
    'native-missing-thread': `thread not found ${marker}`,
    'native-input-cap': `Input exceeds the maximum length of 1048576 characters ${marker}`,
    'native-compact-failure': `http 503 ${marker}`, 'native-continuation-failure': `http 503 ${marker}`,
    'native-compaction-interrupt': `http 503 ${marker}`,
    'native-continuation-retry': `failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact } ${marker}`,
  };
  const expected: Record<string, unknown> = { errorKind: 'Error', ...diagnostic(sources[label] ?? marker) };
  if (label === 'sdk-known-handler') expected['eventType'] = diagnostic('assistant.message_delta');
  if (label === 'sdk-unknown-handler') expected['eventType'] = diagnostic(marker);
  return expected;
}
function fixture(code: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-notification-source-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const receipt = join(dir, 'receipt.json'); const path = join(dir, 'fixture.cjs');
  writeFileSync(path, `const fs = require('node:fs'); const receipt = ${JSON.stringify(receipt)}; const marker = ${JSON.stringify(marker)}; ${code}`);
  return { dir, path, receipt };
}
async function codex(mode: string) {
  const native = fixture(String.raw`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const requests = []; let turns = 0;
    const send = value => process.stdout.write(JSON.stringify(value) + '\n');
    const notify = (method, params) => send({ method, params });
    const finish = (id, status = 'completed') => notify('turn/completed', { threadId: 'fixture-thread', turn: { id, status } });
    rl.on('line', line => {
      const request = JSON.parse(line); requests.push(request); fs.writeFileSync(receipt, JSON.stringify(requests));
      if (request.id === undefined) return;
      if (request.method === 'initialize') return send({ id: request.id, result: {} });
      if (request.method === 'thread/start') return send({ id: request.id, result: { threadId: 'fixture-thread' } });
      if (request.method === 'thread/goal/get') return send({ id: request.id, result: { goal: null } });
      if (request.method === 'thread/compact/start') {
        if (${JSON.stringify(mode)} === 'compact-failure') return send({ id: request.id, error: { code: -32000, message: 'http 503 ' + marker } });
        send({ id: request.id, result: {} });
        if (${JSON.stringify(mode)} === 'compaction-interrupt') {
          notify('turn/started', { threadId: 'fixture-thread', turn: { id: 'compact-turn', status: 'inProgress' } });
          return notify('item/started', { threadId: 'fixture-thread', turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } });
        }
        return notify('thread/compacted', { threadId: 'fixture-thread' });
      }
      if (request.method === 'turn/interrupt') {
        if (request.params.turnId === 'compact-turn') {
          send({ id: request.id, error: { code: -32000, message: 'http 503 ' + marker } });
          return setTimeout(() => finish('compact-turn', 'interrupted'), 20);
        }
        send({ id: request.id, result: {} }); return finish('fixture-turn-1', 'interrupted');
      }
      if (request.method === 'turn/start') {
        turns += 1; const id = 'fixture-turn-' + turns;
        if (${JSON.stringify(mode)} === 'missing-thread') return send({ id: request.id, error: { code: -32000, message: 'thread not found ' + marker } });
        if (${JSON.stringify(mode)} === 'input-cap' && turns === 1) return send({ id: request.id, error: { code: -32000, message: 'Input exceeds the maximum length of 1048576 characters ' + marker } });
        if (${JSON.stringify(mode)} === 'continuation-failure' && turns > 1) return send({ id: request.id, error: { code: -32000, message: 'http 503 ' + marker } });
        if (${JSON.stringify(mode)} === 'continuation-retry' && turns === 2) {
          send({ id: request.id, error: { code: -32000, message: 'failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact } ' + marker } });
          return setTimeout(() => finish('provider-compact-turn'), 20);
        }
        send({ id: request.id, result: { turn: { id, status: 'inProgress' } } });
        notify('turn/started', { threadId: 'fixture-thread', turn: { id, status: 'inProgress' } });
        if (['continuation-failure', 'continuation-retry', 'compaction-interrupt'].includes(${JSON.stringify(mode)}) && turns === 1) return;
        if (['retry', 'terminal'].includes(${JSON.stringify(mode)})) {
          notify('error', { threadId: 'fixture-thread', turnId: id, willRetry: ${JSON.stringify(mode)} === 'retry', error: { message: 'Provider message ' + marker, additionalDetails: 'Provider details ' + marker, codexErrorInfo: { serverOverloaded: { httpStatusCode: 503, body: marker } } } });
        }
        if (${JSON.stringify(mode)} === 'mismatch') notify('item/agentMessage/delta', { threadId: 'fixture-thread', turnId: id, itemId: 'answer', delta: 'Draft ' + marker });
        notify('item/completed', { threadId: 'fixture-thread', turnId: id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Final ' + marker } });
        return finish(id, ${JSON.stringify(mode)} === 'terminal' ? 'failed' : 'completed');
      }
      send({ id: request.id, result: {} });
    }); rl.on('close', () => process.exit(0));
  `);
  writeFileSync(join(native.dir, 'codex'), `#!${process.execPath}\n${readFileSync(native.path, 'utf8')}`, { mode: 0o700 });
  if (process.platform === 'win32') writeFileSync(join(native.dir, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${native.path}" %*\r\n`);
  const adapter = new CodexCliAdapter({ workingDir: native.dir, timeout: 3_000, env: { CODEX_HOME: native.dir } });
  const access = adapter as unknown as { connectAppServer(cwd: string): Promise<AppServerClient>; activityDetector: { recordActivityEntry(entry: unknown): Promise<void> } };
  access.connectAppServer = cwd => connectToAppServer(cwd, { disableBroker: true, env: { PATH: `${native.dir}${delimiter}${process.env['PATH'] ?? ''}` } });
  vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true, metadata: { appServerAvailable: true } });
  const output: OutputMessage[] = []; const errors: Error[] = []; const statuses: string[] = []; const completions: unknown[] = [];
  adapter.on('output', (message: OutputMessage) => output.push(message)); adapter.on('turn_error', (error: Error) => errors.push(error));
  adapter.on('status', (status: string) => statuses.push(status)); adapter.on('complete', response => completions.push(response));
  cleanup.push(() => adapter.terminate(false)); await adapter.spawn();
  const activityEntries: unknown[] = [];
  if (mode === 'activity') access.activityDetector = { recordActivityEntry: async entry => { activityEntries.push(entry); throw Object.assign(new Error(marker, { cause: marker }), { detail: marker }); } };
  return { adapter, output, errors, statuses, completions, receipt: native.receipt, activityEntries };
}

const codexMessages: Record<string, string> = {
  retry: 'Retrying error notification from app-server', terminal: 'Error notification from app-server',
  mismatch: 'Codex assistant final did not match streamed content; using final message as canonical',
  activity: 'Failed to record Codex native activity', 'missing-thread': 'Codex app-server thread became unavailable; refusing context-empty retry',
  'input-cap': 'Codex app-server turn exceeded per-turn input char cap; recovering', 'compact-failure': 'Context compaction failed',
  'continuation-failure': 'Same-thread continuation after compaction failed',
  'continuation-retry': 'Same-thread continuation found a provider compaction turn; waiting to retry once',
  'compaction-interrupt': 'Could not interrupt the Codex compaction turn',
};
describe('native notification and SDK source logging', () => {
  it.each(Object.keys(codexMessages))('Codex native %s preserves runtime behavior and excludes logged source', async mode => {
    const h = await codex(mode);
    if (mode === 'compact-failure') await expect(h.adapter.compactContext()).resolves.toBe(false);
    if (['continuation-failure', 'continuation-retry', 'compaction-interrupt'].includes(mode)) {
      const pending = h.adapter.sendInput(prompt); pending.catch(() => undefined);
      await vi.waitFor(() => expect(h.statuses).toContain('busy'));
      await vi.waitFor(() => expect(readFileSync(h.receipt, 'utf8')).toContain('turn/start'));
      await expect(h.adapter.executeContextAction('controlled-recovery')).resolves.toMatchObject({ proof: 'acknowledged' });
      if (mode === 'compaction-interrupt') {
        await vi.waitFor(() => expect(h.adapter.isProviderCompacting()).toBe(true));
        const interrupted = h.adapter.interrupt(); expect(interrupted.status).toBe('accepted'); await interrupted.completion;
      }
      if (mode === 'continuation-failure') {
        await expect(pending).rejects.toMatchObject({ reasonCode: 'continuation-failed', surfacedToUser: true });
        expect(h.output.some(message => message.type === 'system' && message.content.includes(marker))).toBe(true);
      } else await pending;
    } else if (mode === 'terminal' || mode === 'missing-thread') {
      await expect(h.adapter.sendInput(prompt)).rejects.toThrow(marker);
      expect(h.errors).toHaveLength(1); expect(h.errors[0].message).toContain(marker);
      expect(h.output.some(message => message.type === 'error' && message.content.includes(marker))).toBe(true);
      expect(h.completions).toEqual([]);
      if (mode === 'terminal') expect(h.errors[0]).toMatchObject({ willRetry: false, errorCode: 'overloaded', statusCode: 503 });
    } else await h.adapter.sendInput(prompt);
    expect(readFileSync(h.receipt, 'utf8')).toContain(prompt);
    if (!['terminal', 'missing-thread', 'continuation-failure', 'compaction-interrupt'].includes(mode)) {
      expect(h.output.filter(message => message.type === 'assistant').at(-1)?.content).toBe(`Final ${marker}`);
      expect(h.completions).toHaveLength(1); expect(h.errors).toEqual([]);
    }
    if (mode === 'retry') expect(h.output.some(message => message.metadata?.['willRetry'] === true)).toBe(true);
    if (mode === 'mismatch') expect(h.output.some(message => message.type === 'assistant' && message.content === `Draft ${marker}`)).toBe(true);
    if (mode === 'activity') expect(h.activityEntries.length).toBeGreaterThan(0);
    verify(`native-${mode}`, codexMessages[mode]);
  });

  it.each(['known-handler', 'unknown-handler', 'disconnect', 'stop'] as const)('Copilot SDK %s preserves payload and disposal', async mode => {
    const native = fixture(String.raw`
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => {
        fs.writeFileSync(receipt, line);
        const send = value => process.stdout.write(JSON.stringify(value) + '\n');
        send({ type: marker, data: { content: marker } });
        send({ type: 'assistant.message_delta', data: { messageId: 'answer', deltaContent: 'Draft ' + marker } });
        send({ type: 'assistant.message', data: { messageId: 'answer', content: 'Final ' + marker } });
        send({ type: 'session.idle' });
      }); rl.on('close', () => process.exit(0));
    `);
    const disposal: string[] = []; const received: unknown[] = []; const sent: string[] = []; const ui: OutputMessage[] = [];
    const originalError = Object.assign(new Error(marker, { cause: new Error(marker) }), { custom: { source: marker } });
    class FixtureClient implements CopilotSdkClientLike {
      readonly child = spawn(process.execPath, [native.path], { stdio: ['pipe', 'pipe', 'pipe'] });
      readonly events = new EventEmitter();
      readonly exited = new Promise<void>((resolve, reject) => { this.child.once('exit', () => resolve()); this.child.once('error', reject); });
      readonly lines = createInterface({ input: this.child.stdout });
      constructor() { this.lines.on('line', line => { const event = JSON.parse(line); received.push(event); this.events.emit('event', event); }); }
      async createSession(): Promise<CopilotSdkSessionLike> {
        return {
          sessionId: 'disposable-sdk-session',
          on: listener => { this.events.on('event', listener); return () => { disposal.push('unsubscribe'); this.events.off('event', listener); }; },
          send: async ({ prompt: content }) => { sent.push(content); this.child.stdin.write(JSON.stringify({ prompt: content }) + '\n'); return 'fixture-message'; },
          abort: async () => { disposal.push('abort'); },
          disconnect: async () => { disposal.push('disconnect'); if (mode === 'disconnect') throw originalError; },
        };
      }
      async resumeSession() { return this.createSession(); }
      async stop() { disposal.push('stop'); this.child.stdin.end(); await this.exited; this.lines.close(); if (mode === 'stop') throw originalError; return []; }
    }
    const sdk: LoadedCopilotSdk = { CopilotClient: FixtureClient, sdkPath: 'disposable-sdk-contract', packageVersion: 'fixture', cliPath: native.path };
    const bridge = new CopilotServerTurnBridge({ emitOutput: message => ui.push(message), emitStatus: () => undefined, emitContext: () => undefined, emitError: () => undefined, noteSessionNotFound: () => undefined });
    const server = await CopilotServerSession.start({ sdk, onPermissionRequest: async () => ({ kind: 'approved' }), onEffect: effect => {
      bridge.handleEffect(effect);
      if ((mode === 'known-handler' && effect.kind === 'assistant-delta') || (mode === 'unknown-handler' && effect.kind === 'ignored')) throw originalError;
    } });
    let disposed = false; cleanup.push(async () => { if (!disposed) await server.dispose(); });
    await server.send(prompt);
    await vi.waitFor(() => expect(ui.at(-1)?.content).toBe(`Final ${marker}`));
    expect(sent).toEqual([prompt]); expect(readFileSync(native.receipt, 'utf8')).toContain(prompt); expect(received).toHaveLength(4);
    await expect(server.dispose()).resolves.toBeUndefined(); disposed = true;
    expect(disposal).toEqual(['unsubscribe', 'disconnect', 'stop']); expect(originalError.message).toBe(marker); expect(originalError.custom.source).toBe(marker);
    verify(`sdk-${mode}`, mode === 'disconnect' ? 'Copilot session disconnect failed during dispose' : mode === 'stop' ? 'Copilot client stop failed during dispose' : 'Copilot server event handler failed');
  });
});
