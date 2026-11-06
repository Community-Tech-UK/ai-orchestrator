import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeControlChannel,
  type ClaudeControlWriter,
} from './claude-control-channel';

function makeWriter(): ClaudeControlWriter & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    sendControlRequest: async (subtype, requestId, fields) => {
      sent.push({ type: 'control_request', subtype, requestId, fields });
    },
    sendCancelControlRequest: async (requestId) => {
      sent.push({ type: 'control_cancel_request', requestId });
    },
  };
}

describe('ClaudeControlChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on a matching request_id', async () => {
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const pending = channel.request(writer, 'side_question', { question: 'q' }, { timeoutMs: 1_000 });
    const requestId = (writer.sent[0] as { requestId: string }).requestId;
    expect(writer.sent[0]).toMatchObject({
      type: 'control_request',
      subtype: 'side_question',
      fields: { question: 'q' },
    });

    // Real wire shape (Claude Code 2.1.303, sendControlResponseSuccess): the
    // data object sits one level inside the reply envelope, under `response`.
    expect(
      channel.handleResponse({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { response: 'the answer', synthetic: false },
        },
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      ok: true,
      payload: { response: 'the answer', synthetic: false },
    });
  });

  it('resolves the inner data object, not the reply envelope', async () => {
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const pending = channel.request(writer, 'get_settings', {}, { timeoutMs: 1_000 });
    const requestId = (writer.sent[0] as { requestId: string }).requestId;
    channel.handleResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { applied: { model: 'claude-opus-5-5', effort: 'medium' }, effective: {}, sources: [] },
      },
    });
    const reply = await pending;
    expect(reply.ok && reply.payload['applied']).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(reply.ok && reply.payload).not.toHaveProperty('request_id');
    expect(reply.ok && reply.payload).not.toHaveProperty('subtype');
  });

  it('resolves an empty payload when a success reply carries no data', async () => {
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const pending = channel.request(writer, 'set_model', { model: 'x' }, { timeoutMs: 1_000 });
    const requestId = (writer.sent[0] as { requestId: string }).requestId;
    expect(channel.handleResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId },
    })).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, payload: {} });
  });

  it('ignores unknown ids and falls through to the interrupt path', () => {
    const channel = new ClaudeControlChannel();
    expect(channel.handleResponse({ response: { request_id: 'not-ours' } })).toBe(false);
    expect(channel.handleResponse({ response: { subtype: 'success' } })).toBe(false);
    expect(channel.handleResponse({})).toBe(false);
  });

  it('times out after timeoutMs', async () => {
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const pending = channel.request(writer, 'get_settings', {}, { timeoutMs: 500 });
    vi.advanceTimersByTime(501);
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'timeout' });
  });

  it('failAll resolves every pending request', async () => {
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const first = channel.request(writer, 'a', {}, { timeoutMs: 10_000 });
    const second = channel.request(writer, 'b', {}, { timeoutMs: 10_000 });
    channel.failAll('not-running');
    await expect(first).resolves.toMatchObject({ ok: false, code: 'not-running' });
    await expect(second).resolves.toMatchObject({ ok: false, code: 'not-running' });
  });

  it('an error reply maps code and error text', async () => {
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const pending = channel.request(writer, 'set_model', { model: 'x' }, { timeoutMs: 1_000 });
    const requestId = (writer.sent[0] as { requestId: string }).requestId;
    channel.handleResponse({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: 'blocked_by_hook', code: 'hook_refused' },
    });
    await expect(pending).resolves.toEqual({ ok: false, code: 'cli-error', message: 'blocked_by_hook' });
  });

  it('maps the real error_code of a 2.1.303 error reply', async () => {
    // Shape from the installed CLI (probe structure and its SDK schema; `check_failed`
    // is one of its set_model error codes): the reply
    // envelope is {subtype:'error', request_id, error, error_code}.
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const pending = channel.request(writer, 'set_model', { model: 'x' }, { timeoutMs: 1_000 });
    const requestId = (writer.sent[0] as { requestId: string }).requestId;
    expect(channel.handleResponse({
      type: 'control_response',
      response: {
        subtype: 'error', request_id: requestId,
        error: 'Unable to validate model: could not resolve authentication', error_code: 'check_failed',
      },
    })).toBe(true);
    await expect(pending).resolves.toEqual({
      ok: false, code: 'cli-error',
      message: 'Unable to validate model: could not resolve authentication',
      errorCode: 'check_failed',
    });
  });

  it('leaves errorCode off when the error reply has none or a non-string one', async () => {
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const none = channel.request(writer, 'set_model', {}, { timeoutMs: 1_000 });
    const noneId = (writer.sent[0] as { requestId: string }).requestId;
    channel.handleResponse({ type: 'control_response', response: { subtype: 'error', request_id: noneId, error: 'nope' } });
    expect(await none).not.toHaveProperty('errorCode');
    const odd = channel.request(writer, 'set_model', {}, { timeoutMs: 1_000 });
    const oddId = (writer.sent[1] as { requestId: string }).requestId;
    channel.handleResponse({ type: 'control_response', response: { subtype: 'error', request_id: oddId, error: 'nope', error_code: 42 } });
    expect(await odd).not.toHaveProperty('errorCode');
  });

  it('a write failure resolves not-running without rejecting', async () => {
    const channel = new ClaudeControlChannel();
    const writer: ClaudeControlWriter = {
      sendControlRequest: async () => {
        throw new Error('EPIPE');
      },
    };
    await expect(
      channel.request(writer, 'side_question', {}, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ ok: false, code: 'not-running' });
  });

  it('cancel resolves cancelled and writes control_cancel_request', async () => {
    const channel = new ClaudeControlChannel();
    const writer = makeWriter();
    const pending = channel.request(writer, 'side_question', { question: 'q' }, { timeoutMs: 10_000 });
    const requestId = (writer.sent[0] as { requestId: string }).requestId;
    channel.cancel(requestId);
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'cancelled' });
    expect(writer.sent).toContainEqual({ type: 'control_cancel_request', requestId });
  });
});
