import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { ClaudeCliAdapter } from './claude-cli-adapter';

describe('resident Claude control queries', () => {
  it('writes context queries with a ten-second deadline, preserves interrupts and resolves queries on exit', async () => {
    const packets: Record<string, unknown>[] = [];
    const proc = Object.assign(new EventEmitter(), { pid: 4242, killed: false, stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(chunk, _encoding, callback) { packets.push(JSON.parse(chunk.toString())); callback(); } }) });
    const adapter = new ClaudeCliAdapter({ residentClaude: true });
    vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockReturnValue(proc as unknown as ChildProcess);
    const feed = (message: unknown) => proc.stdout.write(JSON.stringify(message) + '\n');
    try {
      await adapter.spawn();
      const interrupt = adapter.interrupt();
      const query = adapter.requestContextUsage();
      expect(packets[1]).toMatchObject({ type: 'control_request', request_id: expect.stringMatching(/^ctl_/), request: { subtype: 'get_context_usage' } });
      feed({ type: 'control_response', response: { request_id: packets[1]['request_id'], subtype: 'success', response: { totalTokens: 42 } } });
      await expect(query).resolves.toEqual({ ok: true, payload: { totalTokens: 42 } });
      feed({ type: 'control_response', response: { request_id: packets[0]['request_id'], subtype: 'success' } });
      await expect(interrupt.completion).resolves.toEqual({ status: 'interrupted' });
      const exiting = adapter.requestControl('get_settings', { check: true }, 1000);
      proc.emit('close', 0, null);
      await expect(exiting).resolves.toMatchObject({ ok: false, code: 'process-exited' });
      await expect(adapter.requestContextUsage()).resolves.toMatchObject({ code: 'not-running' });
    } finally { proc.emit('close', 0, null); proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
  });
  it('refuses non-resident adapters and emits token parts for the main thread only, without changing main occupancy', async () => {
    const adapter = new ClaudeCliAdapter();
    await expect(adapter.requestControl('get_context_usage', {}, 1000)).resolves.toMatchObject({ code: 'not-running' });
    const events: unknown[] = []; adapter.on('context', event => events.push(event));
    const internals = adapter as unknown as { processCliMessage(message: unknown): void };
    const message = { type: 'assistant', message: { content: [], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 } } };
    internals.processCliMessage(message);
    expect(events[0]).toMatchObject({ uncachedInput: 100, cacheRead: 500, cacheWrite: 50, mainThread: true });
    const before = adapter.getLastContextUsage();
    internals.processCliMessage({ ...message, parent_tool_use_id: 'task' });
    // A helper agent's message never reaches the context ring or the cache samples.
    expect(events).toHaveLength(1);
    expect(adapter.getLastContextUsage()).toEqual(before);
  });
});
