import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeControlChannel,
  type ClaudeControlReply,
  type ClaudeControlWriter,
} from '../cli/adapters/claude-control-channel';

const recordModelCall = vi.hoisted(() => vi.fn());
vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall }));
import { requestLiveTitle } from './live-title-source';

/**
 * A resident adapter whose `requestControl` runs through a REAL control
 * channel, fed the wire shape Claude Code 2.1.303 actually replies with:
 * `{type:'control_response', response:{subtype:'success', request_id, response:<data>}}`.
 */
function channelAdapter(
  reply: (subtype: string) => { type: 'control_response'; response: Record<string, unknown> } | undefined,
) {
  const channel = new ClaudeControlChannel();
  const writer: ClaudeControlWriter = {
    sendControlRequest: async (subtype, requestId) => {
      const wire = reply(subtype);
      if (!wire) return;
      queueMicrotask(() => {
        wire.response['request_id'] = requestId;
        channel.handleResponse(wire);
      });
    },
  };
  return {
    requestControl: (subtype: string, fields: Record<string, unknown>, timeoutMs: number): Promise<ClaudeControlReply> =>
      channel.request(writer, subtype, fields, { timeoutMs }),
    getAdapterCapabilities: () => ({ residentSession: true }),
  };
}

describe('requestLiveTitle', () => {
  beforeEach(() => recordModelCall.mockClear());

  it('uses the resident channel without persisting to Claude', async () => {
    const requestControl = vi.fn().mockResolvedValue({ ok: true, payload: { title: 'Build pipeline' } });
    const source = { getAdapter: () => ({ requestControl,
      getAdapterCapabilities: () => ({ residentSession: true }) }) };
    expect(await requestLiveTitle(source, 'one', 'build pipeline')).toBe('Build pipeline');
    expect(requestControl).toHaveBeenCalledWith('generate_session_title',
      { description: 'build pipeline', persist: false }, 30_000);
  });

  it('reads the title from the real wire reply (response.response.title)', async () => {
    const adapter = channelAdapter(() => ({
      type: 'control_response',
      response: { subtype: 'success', response: { title: 'Fix the login bug' } },
    }));
    expect(await requestLiveTitle({ getAdapter: () => adapter }, 'one', 'fix login')).toBe('Fix the login bug');
  });

  it('leaves the instant title when the real reply carries no data', async () => {
    const adapter = channelAdapter(() => ({
      type: 'control_response',
      response: { subtype: 'success' },
    }));
    expect(await requestLiveTitle({ getAdapter: () => adapter }, 'one', 'x')).toBeNull();
  });

  it('leaves the instant title when no resident channel or usable answer exists', async () => {
    expect(await requestLiveTitle({ getAdapter: () => undefined }, 'one', 'x')).toBeNull();
    expect(await requestLiveTitle({ getAdapter: () => ({
      getAdapterCapabilities: () => ({ residentSession: false }), requestControl: vi.fn(),
    }) }, 'one', 'x')).toBeNull();
    expect(await requestLiveTitle({ getAdapter: () => ({
      getAdapterCapabilities: () => ({ residentSession: true }),
      requestControl: vi.fn().mockResolvedValue({ ok: true, payload: { title: '  ' } }),
    }) }, 'one', 'x')).toBeNull();
  });

  describe('ledger row', () => {
    it('records a helper/claude success row when the resident session answered', async () => {
      const adapter = channelAdapter(() => ({
        type: 'control_response',
        response: { subtype: 'success', response: { title: 'Fix the login bug' } },
      }));
      await requestLiveTitle({ getAdapter: () => adapter }, 'one', 'x');
      expect(recordModelCall).toHaveBeenCalledOnce();
      expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
        purpose: 'helper', taskType: 'aux:titleGeneration', provider: 'claude',
        instanceId: 'one', outcome: 'success',
      }));
    });

    it('records an error row when a request was made and no title came back', async () => {
      const adapter = channelAdapter(() => ({
        type: 'control_response',
        response: { subtype: 'error', error: 'refused' },
      }));
      expect(await requestLiveTitle({ getAdapter: () => adapter }, 'one', 'x')).toBeNull();
      expect(recordModelCall).toHaveBeenCalledOnce();
      expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
    });

    it('records nothing when no request was made (no adapter, non-resident, not running)', async () => {
      await requestLiveTitle({ getAdapter: () => undefined }, 'one', 'x');
      await requestLiveTitle({ getAdapter: () => ({
        getAdapterCapabilities: () => ({ residentSession: false }), requestControl: vi.fn(),
      }) }, 'one', 'x');
      await requestLiveTitle({ getAdapter: () => ({
        getAdapterCapabilities: () => ({ residentSession: true }),
        requestControl: vi.fn().mockResolvedValue({ ok: false, code: 'not-running', message: 'not running' }),
      }) }, 'one', 'x');
      expect(recordModelCall).not.toHaveBeenCalled();
    });
  });
  describe('waiting for a session that is still being created', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function creating(provider = 'claude') {
      const state = { resident: false, instance: { provider, status: 'initializing', isRenamed: false } as
        { provider: string; status: string; isRenamed: boolean } | undefined };
      const requestControl = vi.fn().mockResolvedValue({ ok: true, payload: { title: 'Late title' } });
      const adapter = { requestControl, getAdapterCapabilities: () => ({ residentSession: state.resident }) };
      return { state, requestControl,
        source: { getAdapter: () => adapter, getInstance: () => state.instance } };
    }

    it('asks as soon as the Claude session becomes resident', async () => {
      const { state, requestControl, source } = creating();
      const pending = requestLiveTitle(source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(requestControl).not.toHaveBeenCalled();
      state.resident = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toBe('Late title');
      expect(requestControl).toHaveBeenCalledTimes(1);
    });

    it('does not wait for a non-Claude session', async () => {
      const { requestControl, source } = creating('codex');
      expect(await requestLiveTitle(source, 'one', 'x')).toBeNull();
      expect(requestControl).not.toHaveBeenCalled();
    });

    it.each(['auto', undefined, ''])('keeps waiting while the provider is unresolved (%j)', async (unresolved) => {
      const { state, requestControl, source } = creating('auto');
      (state.instance as { provider: string | undefined }).provider = unresolved;
      const pending = requestLiveTitle(source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(requestControl).not.toHaveBeenCalled();
      state.instance!.provider = 'claude';
      state.resident = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toBe('Late title');
      expect(requestControl).toHaveBeenCalledTimes(1);
    });

    it('stops once an unresolved provider resolves to a non-Claude CLI', async () => {
      const { state, requestControl, source } = creating('auto');
      let settled = false;
      const pending = requestLiveTitle(source, 'one', 'x').then((title) => { settled = true; return title; });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);
      state.instance!.provider = 'gemini';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
      expect(await pending).toBeNull();
      expect(requestControl).not.toHaveBeenCalled();
    });

    it('still stops on end, rename or timeout while the provider is unresolved', async () => {
      const ended = creating('auto');
      const endedPending = requestLiveTitle(ended.source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(1_000);
      ended.state.instance!.status = 'error';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await endedPending).toBeNull();

      const renamed = creating('auto');
      const renamedPending = requestLiveTitle(renamed.source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(1_000);
      renamed.state.instance!.isRenamed = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await renamedPending).toBeNull();

      const stuck = creating('auto');
      const stuckPending = requestLiveTitle(stuck.source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await stuckPending).toBeNull();

      const vanished = creating('auto');
      const vanishedPending = requestLiveTitle(vanished.source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(1_000);
      vanished.state.instance = undefined;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await vanishedPending).toBeNull();
      for (const run of [ended, renamed, stuck, vanished]) expect(run.requestControl).not.toHaveBeenCalled();
    });

    it('stops waiting when the session ends or is renamed, and sends nothing', async () => {
      const ended = creating();
      const endedPending = requestLiveTitle(ended.source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(1_000);
      ended.state.instance!.status = 'terminated';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await endedPending).toBeNull();

      const renamed = creating();
      const renamedPending = requestLiveTitle(renamed.source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(1_000);
      renamed.state.instance!.isRenamed = true;
      renamed.state.resident = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await renamedPending).toBeNull();
      expect(ended.requestControl).not.toHaveBeenCalled();
      expect(renamed.requestControl).not.toHaveBeenCalled();
      expect(recordModelCall).not.toHaveBeenCalled();
    });

    it('gives up after the wait limit', async () => {
      const { requestControl, source } = creating();
      const pending = requestLiveTitle(source, 'one', 'x');
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await pending).toBeNull();
      expect(requestControl).not.toHaveBeenCalled();
    });
  });
});
