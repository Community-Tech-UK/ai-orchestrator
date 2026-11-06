/**
 * Claude live runtime switch (Step 14d): a provider-default effort (`null`)
 * has no verified live reset, so `applyClaudeLiveRuntime` must refuse before
 * sending anything and commit nothing. The caller then restarts the session
 * from a summary, which clears the spawn-time effort.
 *
 * Driven through the REAL control channel with the Claude Code 2.1.303 reply
 * envelope `{type:'control_response', response:{subtype, request_id, response}}`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ClaudeControlChannel, type ClaudeControlWriter } from './claude-control-channel';
import { applyClaudeLiveRuntime, type LiveRuntimeHost } from './claude-live-runtime';

/** A CLI that happily accepts everything and reports `applied` back. */
function acceptingCli(applied: Record<string, unknown>) {
  const channel = new ClaudeControlChannel();
  const sent: string[] = [];
  const writer: ClaudeControlWriter = {
    sendControlRequest: async (subtype, requestId) => {
      sent.push(subtype);
      queueMicrotask(() => {
        channel.handleResponse({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            ...(subtype === 'get_settings' ? { response: { applied } } : {}),
          },
        });
      });
    },
  };
  const commit = vi.fn<LiveRuntimeHost['commit']>();
  const host: LiveRuntimeHost = {
    requestControl: (subtype, fields, timeoutMs) => channel.request(writer, subtype, fields, { timeoutMs }),
    commit,
  };
  return { host, commit, sent };
}

describe('applyClaudeLiveRuntime provider-default effort (null)', () => {
  it('falls back to restart, sends nothing and commits nothing for an effort-only reset', async () => {
    // The CLI would even report "no effort", which a naive path would accept.
    const { host, commit, sent } = acceptingCli({ effort: null });
    const result = await applyClaudeLiveRuntime(host, { effort: null });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('Provider-default effort requires restarting'),
    });
    expect(sent).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses before set_model so a combined model change leaves the CLI untouched', async () => {
    const { host, commit, sent } = acceptingCli({ model: 'claude-opus-4-8' });
    const result = await applyClaudeLiveRuntime(host, { model: 'claude-opus-4-8', effort: null });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('still switches live when the effort is simply not part of the change', async () => {
    const { host, commit, sent } = acceptingCli({ model: 'claude-opus-4-8' });
    await expect(applyClaudeLiveRuntime(host, { model: 'claude-opus-4-8' })).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['set_model', 'get_settings']);
    expect(commit).toHaveBeenCalledWith('claude-opus-4-8', undefined);
  });
});
