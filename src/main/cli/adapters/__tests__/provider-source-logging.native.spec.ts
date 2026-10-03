// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { getLogManager, getLogger } from '../../../logging/logger';
import { createAntigravityAdapter, createGeminiAdapter, createOllamaAdapter, createOpenAICompatibleLocalModelAdapter } from '../adapter-factory';
import type { BaseCliAdapter, CliAdapterConfig } from '../base-cli-adapter';
import type { OutputMessage } from '../../../../shared/types/instance.types';

const marker = 'SYNTHETIC_SOURCE_DIAGNOSTIC_MARKER';
const prompt = `Please preserve ${marker} in the native request`;
const manager = getLogManager();
const cleanup: (() => void | Promise<void>)[] = [];
let log: ReturnType<typeof vi.spyOn>;
let logError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  manager.updateConfig({ globalLevel: 'debug', enableConsole: false, enableFile: false });
  manager.clearBuffer();
  log = vi.spyOn(manager, 'log');
  logError = vi.spyOn(manager, 'logError');
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  manager.clearBuffer();
});

function verifyLogs(label: string, messages: string[]): void {
  const entries = manager.getRecentLogs();
  const raw = inspect({ log: log.mock.calls, logError: logError.mock.calls }, { depth: null });
  expect(JSON.stringify(entries), label).not.toContain(marker);
  expect(raw, label).not.toContain(marker);
  for (const message of messages) {
    const matching = entries.filter(entry => entry.message === message);
    expect(matching.length).toBeGreaterThan(0);
    for (const entry of matching) {
      expect(entry.data?.['textChars']).toEqual(expect.any(Number));
      expect(entry.data?.['textHash']).toMatch(/^[a-f0-9]{16}$/);
      expect(entry.error).toBeUndefined();
    }
  }
}

function nativeCli(provider: 'gemini' | 'antigravity', stdout: string, stderr: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-provider-source-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const receipt = join(dir, 'argv.json');
  const fixture = join(dir, 'fixture.cjs');
  writeFileSync(fixture, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`);
  const options = { workingDirectory: dir, timeout: 5_000, yoloMode: false };
  // Use the shipped factory constructors. Only redirect the executable to our
  // disposable native child; no process, stream, logger, or parser mocks.
  const adapter = provider === 'gemini' ? createGeminiAdapter(options) : createAntigravityAdapter(options);
  const access = adapter as unknown as { config: CliAdapterConfig };
  access.config = { ...access.config, command: process.execPath, args: [fixture] };
  const output: OutputMessage[] = [];
  adapter.on('output', (message: OutputMessage) => output.push(message));
  cleanup.push(() => adapter.terminate(false));
  return { adapter, output, receipt };
}

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const native = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    native.closeAllConnections();
    native.close(error => error ? reject(error) : resolve());
  }));
  const address = native.address();
  if (!address || typeof address === 'string') throw new Error('Missing native port');
  return { port: address.port, baseUrl: `http://127.0.0.1:${address.port}` };
}

function capture(adapter: BaseCliAdapter) {
  const output: OutputMessage[] = [];
  const errors: Error[] = [];
  adapter.on('output', (message: OutputMessage) => output.push(message));
  adapter.on('error', error => errors.push(error));
  cleanup.push(() => adapter.terminate());
  return { output, errors };
}

describe('native provider source logging boundaries', () => {
  it.each(['gemini', 'antigravity'] as const)('%s informational stderr keeps source out of log arguments and sink', async provider => {
    const visible = `Visible ${marker}`;
    const stdout = provider === 'gemini' ? `${JSON.stringify({ type: 'message', role: 'assistant', content: visible })}\n` : visible;
    const stderr = `Provider banner ${marker}`;
    const { adapter, output, receipt } = nativeCli(provider, stdout, stderr);
    const response = await adapter.sendMessage({ role: 'user', content: prompt });
    expect(response.content).toBe(visible);
    expect(output.map(message => message.content).join('')).toContain(visible);
    expect(readFileSync(receipt, 'utf8')).toContain(prompt);
    verifyLogs(`${provider}-stderr-info`, [provider === 'gemini' ? 'gemini stderr' : 'agy stderr']);
    const diagnostic = manager.getRecentLogs().find(entry => entry.message === (provider === 'gemini' ? 'gemini stderr' : 'agy stderr'));
    expect(diagnostic?.data).toEqual({ textChars: stderr.length, textHash: createHash('sha256').update(stderr).digest('hex').slice(0, 16) });
  });

  it.each(['gemini', 'antigravity'] as const)('%s listenerless native errors keep visible source and omit logged source', async provider => {
    const stderr = `Error: ${marker}`;
    const stdout = provider === 'gemini' ? `${JSON.stringify({ type: 'message', role: 'assistant', content: marker })}\n` : marker;
    const { adapter, output, receipt } = nativeCli(provider, stdout, stderr);
    await adapter.sendMessage({ role: 'user', content: prompt });
    expect(output.some(message => message.type === 'error' && message.content === stderr)).toBe(true);
    expect(readFileSync(receipt, 'utf8')).toContain(prompt);
    verifyLogs(`${provider}-stderr-error`, [provider === 'gemini' ? 'Gemini CLI error without listener' : 'Antigravity CLI error without listener']);
  });

  it('Gemini malformed native stdout logs diagnostics while preserving native and parsed output', async () => {
    const malformed = `{ malformed ${marker}`;
    const valid = JSON.stringify({ type: 'message', role: 'assistant', content: marker });
    const { adapter, output } = nativeCli('gemini', `${malformed}\n${valid}\n`, '');
    const response = await adapter.sendMessage({ role: 'user', content: prompt });
    expect(response.raw).toContain(malformed);
    expect(response.content).toBe(marker);
    expect(output.map(message => message.content).join('')).toContain(marker);
    verifyLogs('gemini-malformed', ['Failed to parse Gemini stream-json line']);
  });

  it.each(['ollama', 'openai'] as const)('%s malformed native frames retain native prompt and valid visible output', async provider => {
    const requests: string[] = [];
    const native = await server((req, res, body) => {
      requests.push(body);
      res.writeHead(200, { 'Content-Type': provider === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' });
      const malformed = `{ malformed ${marker}`;
      res.end(provider === 'ollama'
        ? `${malformed}\n${JSON.stringify({ message: { role: 'assistant', content: marker }, done: true })}\n`
        : `data: ${malformed}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}\n\ndata: [DONE]\n\n`);
    });
    const adapter = provider === 'ollama'
      ? createOllamaAdapter({ ollamaEndpoint: { host: '127.0.0.1', port: native.port }, model: 'fixture-model' })
      : createOpenAICompatibleLocalModelAdapter({ baseUrl: native.baseUrl, model: 'fixture-model' });
    const { output } = capture(adapter);
    const response = await adapter.sendMessage({ role: 'user', content: prompt });
    expect(response.content).toBe(marker);
    expect(output.map(message => message.content).join('')).toContain(marker);
    expect(JSON.parse(requests[0]!).messages).toEqual([{ role: 'user', content: prompt }]);
    verifyLogs(`${provider}-malformed`, [provider === 'ollama' ? 'Ollama: unparseable NDJSON line' : 'OpenAI-compatible local model: unparseable SSE data']);
  });

  it('Ollama streaming HTTP errors omit the body from Error log arguments and sink', async () => {
    const requests: string[] = [];
    const native = await server((_req, res, body) => {
      requests.push(body); res.writeHead(503); res.end(`Provider source ${marker}`);
    });
    const adapter = createOllamaAdapter({ ollamaEndpoint: { host: '127.0.0.1', port: native.port } });
    capture(adapter);
    const output: string[] = [];
    for await (const chunk of adapter.sendMessageStream({ role: 'user', content: prompt })) output.push(chunk);
    expect(output).toEqual([]);
    expect(JSON.parse(requests[0]!).messages).toEqual([{ role: 'user', content: prompt }]);
    verifyLogs('ollama-stream-error', ['Ollama stream error']);
  });

  it.each(['ollama', 'openai'] as const)('%s sendInput HTTP errors preserve UI and rejection while omitting logged source', async provider => {
    const requests: string[] = [];
    const native = await server((req, res, body) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url === '/api/version' ? { version: '0.0.0-fixture' } : req.url === '/api/tags' ? { models: [{ name: 'fixture-model' }] } : { data: [{ id: 'fixture-model' }] }));
      } else { requests.push(body); res.writeHead(503); res.end(`Provider source ${marker}`); }
    });
    const adapter = provider === 'ollama'
      ? createOllamaAdapter({ ollamaEndpoint: { host: '127.0.0.1', port: native.port }, model: 'fixture-model' })
      : createOpenAICompatibleLocalModelAdapter({ baseUrl: native.baseUrl, model: 'fixture-model' });
    const { output, errors } = capture(adapter);
    await adapter.spawn();
    await expect(adapter.sendInput(prompt)).rejects.toThrow(marker);
    expect(output.some(message => message.type === 'error' && message.content.includes(marker))).toBe(true);
    expect(errors[0]?.message).toContain(marker);
    expect(JSON.parse(requests[0]!).messages).toEqual([{ role: 'user', content: prompt }]);
    verifyLogs(`${provider}-sendinput-error`, ['Local model sendInput error']);
  });

  it('generic logger control still retains ordinary non-secret diagnostic data', () => {
    getLogger('GenericSourceControl').debug('source control', { text: marker });
    expect(manager.getRecentLogs().find(entry => entry.subsystem === 'GenericSourceControl')?.data?.['text']).toBe(marker);
    expect(inspect(log.mock.calls, { depth: null })).toContain(marker);
  });
});
