import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { LogManager } from '../../logging/logger';
import { ClaudeCliAdapter } from './claude-cli-adapter';
const state = vi.hoisted(() => ({ manager: null as LogManager | null, kill: vi.fn(() => false) }));
vi.mock('../../logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logging/logger')>();
  const manager = new actual.LogManager({ enableConsole: false, enableFile: false, globalLevel: 'debug' });
  state.manager = manager;
  return { ...actual, getLogger: (subsystem: string) => manager.getLogger(subsystem) };
});
vi.mock('./base-cli-process-utils', () => ({ killProcessGroup: state.kill }));
const source = 'local_test_source_sentinel';
afterEach(() => { vi.restoreAllMocks(); state.kill.mockReset(); });
function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error
    ? Object.fromEntries(Object.getOwnPropertyNames(item).map((key) => [key, Reflect.get(item, key)])) : item);
}
describe('actual Claude native stdio diagnostic boundaries', () => {
  it.each(['sendRaw', 'input-required', 'elicitation', 'permission', 'stderr', 'malformed', 'overflow', 'flush', 'unknown', 'stdin-resident', 'stdin-one-shot', 'stderr-one-shot', 'interrupt-error', 'base-interrupt', 'unknown-missing-type', 'permission-action', 'rate-limit', 'control-response'] as const)('preserves payload and projects %s diagnostics', async (mode) => {
    const packets: Record<string, unknown>[] = [];
    const failure = Object.assign(new Error(source), { code: 'EIO', cause: new Error(source), metadata: { source } });
    const proc = Object.assign(new EventEmitter(), { pid: 4242, killed: false, stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(chunk, _encoding, callback) {
        const packet = JSON.parse(chunk.toString()); packets.push(packet);
        const fail = mode.startsWith('stdin-') || (mode === 'interrupt-error' && packet.type === 'control_request');
        if (fail) queueMicrotask(() => callback(failure)); else callback();
      } }) });
    const adapter = new ClaudeCliAdapter({ workingDirectory: '/tmp', residentClaude: mode !== 'base-interrupt' });
    vi.spyOn(adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess }, 'spawnProcess').mockReturnValue(proc as unknown as ChildProcess);
    const outputs: unknown[] = []; const inputs: unknown[] = []; const errors: Error[] = [];
    adapter.on('output', (value) => outputs.push(value)); adapter.on('input_required', (value) => inputs.push(value)); adapter.on('error', (value) => errors.push(value));
    state.manager!.clearBuffer();
    const log = vi.spyOn(state.manager!, 'log'); const logError = vi.spyOn(state.manager!, 'logError');
    const feed = (message: unknown) => proc.stdout.write(JSON.stringify(message) + '\n');
    try {
      if (mode.endsWith('one-shot')) {
        const sent = adapter.sendMessage({ role: 'user', content: source });
        const outcome = sent.then((value) => ({ value }), (error: unknown) => ({ error }));
        await vi.waitFor(() => expect(packets).toHaveLength(1));
        if (mode === 'stderr-one-shot') { proc.stderr.write(source); proc.emit('close', 0); await outcome; }
        else { expect((await outcome)).toEqual({ error: failure }); expect(errors).toContain(failure); proc.emit('close', 1); }
      } else {
        await adapter.spawn();
        if (mode === 'sendRaw') { await adapter.sendRaw(source); expect((packets[0]['message'] as { content: string }).content).toBe(source); }
        if (mode === 'input-required') { feed({ type: 'input_required', prompt: source, metadata: { [source]: source } }); expect(serialized(inputs)).toContain(source); }
        if (mode === 'elicitation') { feed({ type: 'elicitation', server_name: source, message: source, request_id: 'local-request' }); expect(serialized(inputs)).toContain(source); }
        if (mode === 'permission' || mode === 'permission-action') {
          feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'local-tool', name: mode === 'permission-action' ? source : 'Bash', input: { command: source } }] } });
          feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'local-tool', is_error: true,
            content: mode === 'permission-action' ? `Tool is not approved: ${source}` : `Claude requested permissions to write to /tmp/${source}, but you haven't granted it yet.` }] } });
          expect(serialized(inputs)).toContain(source); expect(serialized(outputs)).toContain(source);
        }
        if (mode === 'stderr') proc.stderr.write(`permission observation ${source}`);
        if (mode === 'malformed') { proc.stdout.write(`invalid-json ${source}\n`); feed({ type: 'system', content: source }); expect(serialized(outputs)).toContain(source); }
        if (mode === 'overflow') { feed({ type: 'system', content: source + 'x'.repeat(1024 * 1024) }); expect(serialized(outputs)).toContain(source); }
        if (mode === 'flush') { proc.stdout.write(`incomplete ${source}`); proc.emit('exit', 0, null); }
        if (mode === 'unknown') feed({ type: source, [source]: source });
        if (mode === 'unknown-missing-type') { feed({ [source]: source }); expect(errors).toHaveLength(0); }
        if (mode === 'rate-limit') { feed({ type: 'rate_limit_event', rate_limit_info: { status: source, rateLimitType: source, overageStatus: source } }); expect(serialized(outputs)).toContain(source); }
        if (mode === 'control-response') {
          const interrupt = adapter.interrupt(); expect(interrupt.status).toBe('accepted');
          await vi.waitFor(() => expect(packets).toHaveLength(1));
          feed({ type: 'control_response', response: { request_id: packets[0]['request_id'], subtype: 'error', error: source } });
          await expect(interrupt.completion).resolves.toEqual({ status: 'rejected', reason: source });
        }
        if (mode === 'stdin-resident') { await expect(adapter.sendInput(source)).rejects.toBe(failure); await vi.waitFor(() => expect(errors).toContain(failure)); }
        if (mode === 'interrupt-error') {
          const result = adapter.interrupt(); expect(result.status).toBe('accepted');
          let settled = false; void result.completion?.then(() => { settled = true; });
          await vi.waitFor(() => expect(state.manager!.getRecentLogs().some((row) => row.message.startsWith('Failed to send control_request'))).toBe(true));
          expect(packets[0]).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } }); expect(settled).toBe(false);
        }
        if (mode === 'base-interrupt') { state.kill.mockImplementationOnce(() => { throw failure; }); expect(adapter.interrupt()).toEqual({ status: 'rejected', reason: source }); }
      }
      const rows = state.manager!.getRecentLogs();
      expect(rows.length).toBeGreaterThan(0);
      const diagnosticMessages: Record<typeof mode, string> = {
        sendRaw: 'Sending as user message', 'input-required': 'Processing input_required', elicitation: 'MCP elicitation received',
        permission: 'Permission denial detected in tool_result', 'permission-action': 'Permission denial detected in tool_result',
        stderr: 'STDERR contains permission-like content', malformed: 'Failed to parse NDJSON line', overflow: 'NDJSON buffer exceeded max size, attempting recovery',
        flush: 'Discarding incomplete NDJSON buffer', unknown: 'Unrecognized CLI message type', 'unknown-missing-type': 'Unrecognized CLI message type',
        'stdin-resident': 'stdin stream error', 'stdin-one-shot': 'stdin stream error', 'stderr-one-shot': 'claude stderr',
        'interrupt-error': 'Failed to send control_request interrupt; deferring recovery to exit handler', 'base-interrupt': 'Failed to interrupt process',
        'rate-limit': 'Provider rate limit active', 'control-response': 'control_response interrupt non-success',
      };
      expect(rows.some((row) => row.message === diagnosticMessages[mode])).toBe(true);
      expect(serialized(rows)).not.toContain(source);
      expect(serialized([log.mock.calls, logError.mock.calls])).not.toContain(source);
    } finally { proc.emit('exit', 0, null); proc.emit('close', 0); proc.stdout.destroy(); proc.stderr.destroy(); proc.stdin.destroy(); }
  });
});


describe('rate-limit diagnostics tolerate native field types', () => {
  const variants = [
    { label: 'object', value: { source } },
    { label: 'array', value: [source] },
    { label: 'number', value: 7 },
    { label: 'boolean', value: true },
  ];
  const cases = variants.flatMap((variant) => [
    { ...variant, status: source, diagnostic: 'Provider rate limit active' },
    { ...variant, status: 'allowed', diagnostic: 'Rate limit telemetry' },
  ]);
  it.each(cases)('preserves $label fields for $diagnostic', async ({ value, status, diagnostic }) => {
    const proc = Object.assign(new EventEmitter(), { pid: 4242, killed: false, stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }) });
    const adapter = new ClaudeCliAdapter({ workingDirectory: '/tmp', residentClaude: true });
    vi.spyOn(adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess }, 'spawnProcess').mockReturnValue(proc as unknown as ChildProcess);
    const outputs: unknown[] = []; const telemetry: unknown[] = []; const errors: Error[] = [];
    adapter.on('output', (event) => outputs.push(event)); adapter.on('rate-limit-telemetry', (event) => telemetry.push(event));
    adapter.on('error', (error) => errors.push(error));
    state.manager!.clearBuffer();
    const log = vi.spyOn(state.manager!, 'log'); const logError = vi.spyOn(state.manager!, 'logError');
    const info = { status, rateLimitType: value, overageStatus: value };
    try {
      await adapter.spawn();
      expect(() => proc.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }) + '\n')).not.toThrow();
      expect(errors).toHaveLength(0); expect(telemetry).toEqual([info]); expect(adapter.getLastRateLimitInfo()).toEqual(info);
      if (status !== 'allowed') {
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({ content: `Provider rate limit "${status}" (${String(value)}). Resets at unknown.`,
          metadata: { rateLimit: true, status, rateLimitType: value } });
      } else expect(outputs).toHaveLength(0);
      proc.stdout.write(JSON.stringify({ type: 'system', content: source }) + '\n');
      expect(serialized(outputs)).toContain(source);
      const rows = state.manager!.getRecentLogs(); const row = rows.find((entry) => entry.message === diagnostic);
      expect(row).toBeDefined(); expect(row!.data?.['rateLimitType']).toBeUndefined(); expect(row!.data?.['overageStatus']).toBeUndefined();
      expect(serialized(rows)).not.toContain(source); expect(serialized([log.mock.calls, logError.mock.calls])).not.toContain(source);
    } finally { proc.emit('exit', 0, null); proc.emit('close', 0); proc.stdout.destroy(); proc.stderr.destroy(); proc.stdin.destroy(); }
  });
});
