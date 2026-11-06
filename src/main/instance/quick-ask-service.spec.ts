import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceManager } from './instance-manager';

const loans = vi.hoisted(() => ({ isAdapterOnLoan: vi.fn(() => false),
  isRuntimeChangeInFlight: vi.fn(() => false) }));
vi.mock('./lifecycle/adapter-loan-registry', () => loans);
const recordModelCall = vi.hoisted(() => vi.fn());
vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall }));
import { askQuick } from './quick-ask-service';
import { ClaudeControlChannel, type ClaudeControlWriter } from '../cli/adapters/claude-control-channel';

const instance = (overrides: Partial<Instance> = {}) => ({
  id: 'one', provider: 'claude', currentModel: 'claude-sonnet',
  outputBuffer: [{ id: 'm', type: 'assistant', content: 'answer', timestamp: 1 }],
  ...overrides,
} as Instance);
const adapter = (reply: unknown = { ok: true, payload: { response: 'yes' } }) => ({
  requestControl: vi.fn().mockResolvedValue(reply),
  getAdapterCapabilities: () => ({ residentSession: true }),
});
/**
 * A resident adapter whose `requestControl` runs through a REAL control
 * channel fed the wire shape Claude Code 2.1.303 replies with:
 * `{type:'control_response', response:{subtype:'success', request_id, response:<data>}}`.
 */
const channelAdapter = (wire: (requestId: string) => Record<string, unknown>) => {
  const channel = new ClaudeControlChannel();
  const writer: ClaudeControlWriter = {
    sendControlRequest: async (_subtype, requestId) => {
      queueMicrotask(() => { channel.handleResponse(wire(requestId)); });
    },
  };
  return {
    requestControl: (subtype: string, fields: Record<string, unknown>, timeoutMs: number) =>
      channel.request(writer, subtype, fields, { timeoutMs }),
    getAdapterCapabilities: () => ({ residentSession: true }),
  };
};
const manager = (inst: Instance | undefined, cli: unknown) => ({
  getInstance: () => inst, getAdapter: () => cli,
} as unknown as InstanceManager);

describe('askQuick', () => {
  beforeEach(() => { vi.clearAllMocks(); loans.isAdapterOnLoan.mockReturnValue(false);
    loans.isRuntimeChangeInFlight.mockReturnValue(false); });

  it('asks the resident session while busy and records unknown-cost purpose', async () => {
    const cli = adapter();
    expect(await askQuick(manager(instance({ status: 'busy' }), cli), 'one', '  decision?  '))
      .toMatchObject({ ok: true, answer: 'yes' });
    expect(cli.requestControl).toHaveBeenCalledWith('side_question', { question: 'decision?' }, 60_000);
    expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'quick-ask', outcome: 'success', instanceId: 'one',
    }));
  });

  it('requires Claude, a resident process and a completed assistant turn', async () => {
    expect(await askQuick(manager(instance({ provider: 'codex' }), adapter()), 'one', 'q'))
      .toMatchObject({ ok: false, code: 'not-claude' });
    expect(await askQuick(manager(instance(), {}), 'one', 'q'))
      .toMatchObject({ ok: false, code: 'not-running' });
    expect(await askQuick(manager(instance({ outputBuffer: [] }), adapter()), 'one', 'q'))
      .toMatchObject({ ok: false, code: 'no-history' });
  });

  it('rejects invalid questions and active adapter loans', async () => {
    const source = manager(instance(), adapter());
    expect(await askQuick(source, 'one', '   ')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await askQuick(source, 'one', 'x'.repeat(4_001))).toMatchObject({ ok: false, code: 'invalid' });
    loans.isAdapterOnLoan.mockReturnValue(true);
    expect(await askQuick(source, 'one', 'q')).toMatchObject({ ok: false, code: 'loop' });
  });

  it('allows one request per instance and handles an empty answer', async () => {
    let settle: (value: unknown) => void = () => undefined;
    const cli = adapter();
    cli.requestControl.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const source = manager(instance(), cli);
    const first = askQuick(source, 'one', 'first');
    expect(await askQuick(source, 'one', 'second')).toMatchObject({ ok: false, code: 'busy' });
    settle({ ok: true, payload: { response: '   ' } });
    expect(await first).toMatchObject({ ok: false, code: 'no-answer' });
  });

  it('answers from the real wire reply (response.response is the text)', async () => {
    const cli = channelAdapter((request_id) => ({
      type: 'control_response',
      response: { subtype: 'success', request_id, response: { response: 'The answer is 42', synthetic: false } },
    }));
    expect(await askQuick(manager(instance({ status: 'busy' }), cli), 'one', 'what is it?'))
      .toMatchObject({ ok: true, answer: 'The answer is 42' });
    expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('reports no answer when the real wire reply carries no data or an error', async () => {
    const empty = channelAdapter((request_id) => ({
      type: 'control_response', response: { subtype: 'success', request_id },
    }));
    expect(await askQuick(manager(instance(), empty), 'one', 'q')).toMatchObject({ ok: false, code: 'no-answer' });
    const refused = channelAdapter((request_id) => ({
      type: 'control_response', response: { subtype: 'error', request_id, error: 'nope' },
    }));
    expect(await askQuick(manager(instance(), refused), 'one', 'q')).toMatchObject({ ok: false, code: 'no-answer' });
  });
  describe('real side_question reply fields (Claude Code 2.1.303: {response, synthetic, refusal_fallback?})', () => {
    const SYNTHETIC_TEXT = '(No answer available for this side question. Try again, or ask in the main conversation.)';
    const reply = (data: Record<string, unknown>) => channelAdapter((request_id) => ({
      type: 'control_response', response: { subtype: 'success', request_id, response: data },
    }));

    it('does not present the CLI placeholder of a synthetic reply as an answer', async () => {
      const result = await askQuick(manager(instance(), reply({ response: SYNTHETIC_TEXT, synthetic: true })), 'one', 'q');
      expect(result).toMatchObject({ ok: false, code: 'no-answer' });
      expect(JSON.stringify(result)).not.toContain('No answer available for this side question');
      expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
    });

    it('treats a null response as no answer', async () => {
      expect(await askQuick(manager(instance(), reply({ response: null, synthetic: false })), 'one', 'q'))
        .toMatchObject({ ok: false, code: 'no-answer' });
    });

    it('returns a fallback-model answer with a notice naming both models', async () => {
      const result = await askQuick(manager(instance(), reply({
        response: 'Use the staging key.', synthetic: false,
        refusal_fallback: { original_model: 'claude-fable-5', fallback_model: 'claude-opus-5-5', content: 'Switched models' },
      })), 'one', 'q');
      expect(result).toMatchObject({ ok: true, answer: 'Use the staging key.' });
      const notice = (result as { notice?: string }).notice ?? '';
      expect(notice).toContain('claude-opus-5-5');
      expect(notice).toContain('claude-fable-5');
      expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    });

    it('adds no notice for an ordinary answer, even when synthetic is omitted', async () => {
      const result = await askQuick(manager(instance(), reply({ response: 'Plain answer' })), 'one', 'q');
      expect(result).toMatchObject({ ok: true, answer: 'Plain answer' });
      expect(result).not.toHaveProperty('notice');
    });
  });
});
