import { spawn, type ChildProcess } from 'child_process';
import { Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../../shared/types/instance.types';
import { InputFormatter } from '../input-formatter';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';
import { handleClaudeElicitationCancel } from './claude-elicitation-cancel';

/** A real subprocess that waits for the same envelope as the installed CLI probe. */
class ElicitingCliFixture extends ClaudeCliAdapter {
  child: ChildProcess | null = null;

  constructor(private readonly mode: 'form' | 'url') {
    super({ residentClaude: true });
  }

  protected override spawnProcess(_args: string[]): ChildProcess {
    this.child = spawn(process.execPath, ['-e', `
      const readline = require('readline');
      const lines = readline.createInterface({ input: process.stdin });
      const deadline = setTimeout(() => process.exit(2), 1500);
      const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
      lines.on('line', line => {
        const frame = JSON.parse(line);
        if (frame.type === 'user') {
          emit({ type: 'control_request', request_id: 'EXAMPLE_REQUEST_ID', request: {
            subtype: 'elicitation', mcp_server_name: 'example_connector',
            message: 'EXAMPLE_INPUT_PROMPT', mode: '${this.mode}',
            url: 'https://example.test/EXAMPLE_URL', elicitation_id: 'EXAMPLE_ELICITATION_ID',
            requested_schema: { type: 'object' }
          } });
        } else {
          const expected = { type: 'control_response', response: {
            subtype: 'success', request_id: 'EXAMPLE_REQUEST_ID', response: { action: 'cancel' }
          } };
          try { require('assert').deepStrictEqual(frame, expected); } catch { process.exit(3); }
          clearTimeout(deadline);
          emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'EXAMPLE_CANCEL_CONFIRMED' }] } });
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n', () => process.exit(0));
        }
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    return this.child;
  }
}

function collect(adapter: ClaudeCliAdapter) {
  const outputs: OutputMessage[] = [];
  const inputs: unknown[] = [];
  const statuses: string[] = [];
  adapter.on('output', output => outputs.push(output));
  adapter.on('input_required', input => inputs.push(input));
  adapter.on('status', status => statuses.push(status));
  return { outputs, inputs, statuses };
}

function pipeHarness(writeError?: Error) {
  const adapter = new ClaudeCliAdapter();
  const writes: string[] = [];
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    writes.push(chunk.toString());
    callback(writeError);
  } });
  stdin.on('error', () => { /* The write rejection is observed by the adapter. */ });
  const internals = adapter as unknown as { formatter: InputFormatter; handleStdout(chunk: Buffer): void };
  internals.formatter = new InputFormatter(stdin);
  const feed = (frame: unknown) => internals.handleStdout(Buffer.from(JSON.stringify(frame) + '\n'));
  return { ...collect(adapter), writes, feed };
}

const request = {
  type: 'control_request', request_id: 'EXAMPLE_REQUEST_ID',
  request: { subtype: 'elicitation', mcp_server_name: 'example_connector', mode: 'form' },
};

describe('Claude nested elicitation cancel', () => {
  it('does not open an unanswered input card for the unsupported flat frame', () => {
    const seen = pipeHarness();
    seen.feed({ type: 'elicitation', server_name: 'EXAMPLE_SERVER', message: 'EXAMPLE_PROMPT', request_id: 'EXAMPLE_REQUEST_ID' });
    expect(seen.inputs).toEqual([]);
    expect(seen.statuses).not.toContain('waiting_for_input');
    expect(seen.writes).toEqual([]);
  });
  it.each(['form', 'url'] as const)('unblocks a waiting %s connector through the runtime adapter', async mode => {
    const adapter = new ElicitingCliFixture(mode);
    const seen = collect(adapter);
    const completions: string[] = [];
    adapter.on('complete', response => completions.push(response.content));
    await adapter.spawn();
    const child = adapter.child!;
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    try {
      await adapter.sendRaw('EXAMPLE_TRIGGER');
      expect(await closed).toBe(0);
      expect(completions).toEqual(['EXAMPLE_CANCEL_CONFIRMED']);
      const receipts = seen.outputs.filter(output => output.type === 'system');
      expect(receipts).toHaveLength(1);
      expect(receipts[0].content).toContain("Claude's connector example_connector asked for input and Harness declined it");
      expect(JSON.stringify(receipts)).not.toMatch(/EXAMPLE_INPUT_PROMPT|EXAMPLE_URL|EXAMPLE_ELICITATION_ID|requested_schema/);
      expect(receipts[0].metadata?.['requiresInput']).not.toBe(true);
      expect(seen.inputs).toEqual([]);
      expect(seen.statuses).not.toContain('waiting_for_input');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await closed;
    }
  });

  it('does not claim cancellation after the stdin write fails', async () => {
    const seen = pipeHarness(new Error('EXAMPLE_WRITE_FAILURE'));
    seen.feed(request);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(seen.writes).toHaveLength(1);
    expect(seen.outputs.filter(output => output.type === 'error')).toHaveLength(1);
    expect(seen.outputs.filter(output => output.type === 'system')).toEqual([]);
    expect(JSON.stringify(seen.outputs)).not.toContain('EXAMPLE_WRITE_FAILURE');
    expect(seen.inputs).toEqual([]);
  });

  it.each([undefined, '', ' ', 12])('does not send an uncorrelated reply for request_id %s', async requestId => {
    const seen = pipeHarness();
    seen.feed({ ...request, request_id: requestId });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(seen.writes).toEqual([]);
    expect(seen.outputs.filter(output => output.type === 'system')).toEqual([]);
    expect(seen.inputs).toEqual([]);
  });

  it('leaves unrelated control subtypes to their existing runtime handling', () => {
    const seen = pipeHarness();
    seen.feed({ ...request, request: { subtype: 'hook_callback' } });
    expect(seen.writes).toEqual([]);
    expect(seen.outputs).toEqual([]);
    expect(seen.inputs).toEqual([]);
    // `can_use_tool` belongs to the live permission broker, which answers it itself; the cancel never claims it.
    const sendRaw = vi.fn();
    expect(handleClaudeElicitationCancel({ ...request, request: { subtype: 'can_use_tool' } },
      { isWritable: () => true, sendRaw }, () => undefined)).toBe(false);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});
