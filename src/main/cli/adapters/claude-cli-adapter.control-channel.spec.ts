import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import { InputFormatter } from '../input-formatter';

/**
 * Plan 14a/14d: the adapter must route `control_response` messages into the
 * control channel, fail pending requests on process exit, and re-base the
 * context window on a live model switch. These tests drive the REAL adapter
 * (only the stdin writer and the pipe check are faked), so removing the
 * corresponding adapter lines fails them.
 */

interface Harness {
  adapter: ClaudeCliAdapter;
  writes: { subtype: string; id: string; fields: Record<string, unknown> }[];
}

function makeHarness(
  model: string,
  onWrite?: (write: Harness['writes'][number], adapter: ClaudeCliAdapter) => void,
): Harness {
  const adapter = new ClaudeCliAdapter({ model, residentClaude: true });
  const writes: Harness['writes'] = [];
  const formatter = {
    sendControlRequest: vi.fn(async (subtype: string, id: string, fields: Record<string, unknown>) => {
      const write = { subtype, id, fields };
      writes.push(write);
      onWrite?.(write, adapter);
    }),
  };
  (adapter as unknown as { formatter: unknown }).formatter = formatter;
  vi.spyOn(adapter as unknown as { isRealPipe(): boolean }, 'isRealPipe').mockReturnValue(true);
  return { adapter, writes };
}

function feed(adapter: ClaudeCliAdapter, message: Record<string, unknown>): void {
  (adapter as unknown as { processCliMessage(raw: Record<string, unknown>): void }).processCliMessage(message);
}

function exit(adapter: ClaudeCliAdapter, code: number | null, signal: string | null): void {
  (adapter as unknown as { handleExit(c: number | null, s: string | null): void }).handleExit(code, signal);
}

describe('ClaudeCliAdapter control channel wiring', () => {
  it('routes a control_response to the pending request instead of letting it time out', async () => {
    const { adapter, writes } = makeHarness('claude-opus-4-6');
    const pending = adapter.requestControl('side_question', { question: 'q' }, 300);
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(writes[0].id.startsWith('ctl_')).toBe(true);

    feed(adapter, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: writes[0].id,
        response: { response: 'answer', synthetic: false },
      },
    });

    // The reply resolves with the data object the CLI sent, not the envelope.
    await expect(pending).resolves.toEqual({
      ok: true,
      payload: { response: 'answer', synthetic: false },
    });
  });

  it('writes the control request to stdin as {type, request_id, request:{subtype, ...fields}}', async () => {
    // Real adapter + REAL InputFormatter; only the stdin stream is a fake.
    const adapter = new ClaudeCliAdapter({ model: 'claude-opus-4-6', residentClaude: true });
    const lines: string[] = [];
    const stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (data: string, _encoding: string, callback: (error?: Error) => void) => {
        lines.push(data);
        callback();
        return true;
      },
    }) as unknown as Writable;
    (adapter as unknown as { formatter: unknown }).formatter = new InputFormatter(stdin);
    vi.spyOn(adapter as unknown as { isRealPipe(): boolean }, 'isRealPipe').mockReturnValue(true);

    const pending = adapter.requestControl('generate_session_title', { description: 'd', persist: false }, 50);
    await Promise.resolve();
    await Promise.resolve();

    expect(lines).toHaveLength(1);
    const wire = JSON.parse(lines[0]) as { request_id: string };
    expect(wire.request_id.startsWith('ctl_')).toBe(true);
    expect(wire).toEqual({
      type: 'control_request',
      request_id: wire.request_id,
      request: { subtype: 'generate_session_title', description: 'd', persist: false },
    });
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'timeout' });
  });

  it('fails every pending control request when the process exits', async () => {
    const { adapter, writes } = makeHarness('claude-opus-4-6');
    const first = adapter.requestControl('get_settings', {}, 5_000);
    const second = adapter.requestControl('side_question', { question: 'q' }, 5_000);
    await Promise.resolve();
    expect(writes).toHaveLength(2);

    exit(adapter, 1, null);

    await expect(first).resolves.toMatchObject({ ok: false, code: 'process-exited' });
    await expect(second).resolves.toMatchObject({ ok: false, code: 'process-exited' });
  });

  it('answers not-running when the session has no live pipe', async () => {
    const adapter = new ClaudeCliAdapter({ model: 'claude-opus-4-6', residentClaude: true });
    await expect(adapter.requestControl('get_settings', {}, 100)).resolves.toMatchObject({
      ok: false, code: 'not-running',
    });
  });
});

describe('ClaudeCliAdapter live model switch re-bases the context window', () => {
  // Answers every control request the way a healthy resident CLI would.
  const answerSwitch = (target: string) =>
    (write: Harness['writes'][number], adapter: ClaudeCliAdapter): void => {
      queueMicrotask(() => feed(adapter, {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: write.id,
          // Real CLI: `get_settings` data sits under `response`; set_model and
          // apply_flag_settings succeed with no data at all.
          ...(write.subtype === 'get_settings' ? { response: { applied: { model: target } } } : {}),
        },
      }));
    };

  // Step 14d's "hidden trap": the CLI-report floor used to be fixed at spawn,
  // so a 1M -> 200K switch left the meter at 1M. Both directions must follow.
  it.each([
    { from: 'claude-opus-4-6', fromWindow: 1_000_000, to: 'claude-haiku-4-5', toWindow: 200_000 },
    { from: 'claude-haiku-4-5', fromWindow: 200_000, to: 'claude-opus-4-6', toWindow: 1_000_000 },
  ])('re-bases the window and the CLI-report floor on a verified switch from $from to $to', async ({ from, fromWindow, to, toWindow }) => {
    const { adapter } = makeHarness(from, answerSwitch(to));
    expect(adapter.getCapabilities().contextWindow).toBe(fromWindow);

    await expect(adapter.applyLiveRuntime({ model: to })).resolves.toEqual({ ok: true });

    // The window the UI reads follows the new model.
    expect(adapter.getCapabilities().contextWindow).toBe(toWindow);

    // The CLI reports the new model's window on the next result: the floor
    // must be the new window, not the old one, or the meter keeps the old size.
    const contexts: { total: number }[] = [];
    adapter.on('context', (usage) => contexts.push(usage as { total: number }));
    feed(adapter, {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      modelUsage: { [to]: { contextWindow: toWindow, inputTokens: 1_000, outputTokens: 10 } },
    });
    expect(contexts.at(-1)?.total).toBe(toWindow);
    expect(adapter.getCapabilities().contextWindow).toBe(toWindow);
  });

  it('keeps the new floor when the CLI reports a smaller window than the new model\'s', async () => {
    const { adapter } = makeHarness('claude-haiku-4-5', answerSwitch('claude-opus-4-6'));
    await adapter.applyLiveRuntime({ model: 'claude-opus-4-6' });
    const contexts: { total: number }[] = [];
    adapter.on('context', (usage) => contexts.push(usage as { total: number }));
    feed(adapter, {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      modelUsage: { 'claude-opus-4-6': { contextWindow: 200_000, inputTokens: 1_000, outputTokens: 10 } },
    });
    expect(contexts.at(-1)?.total).toBe(1_000_000);
  });

  it('leaves the window alone when the switch is refused', async () => {
    const harness = makeHarness('claude-haiku-4-5', (write, adapter) => {
      queueMicrotask(() => feed(adapter, {
        type: 'control_response',
        response: { subtype: 'error', request_id: write.id, error: 'refused by hook' },
      }));
    });
    await expect(harness.adapter.applyLiveRuntime({ model: 'claude-opus-4-6' })).resolves.toMatchObject({ ok: false });
    expect(harness.adapter.getCapabilities().contextWindow).toBe(200_000);
  });
});
