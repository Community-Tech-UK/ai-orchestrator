import { describe, expect, it, vi } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('./base-cli-process-utils', () => ({ killProcessGroup: vi.fn() }));

const MODEL = 'xiaomi-token-plan/mimo-v2.6-pro';
const BUDGET = { model: MODEL, combinedOutputTokens: 1024, reasoningBudgetSupported: false } as const;
const modelOption = (currentValue: string, values: string[]) => ({ id: 'model', category: 'model', currentValue,
  options: values.map((value) => ({ value })) });

describe('ACP generation budget requires native model selection', () => {
  it.each(['rejected', 'unavailable', 'missing-request'] as const)('refuses startup when the budget model is %s', async (mode) => {
    const proc = createInitializedAgentHarness();
    if (mode === 'unavailable') proc.onRequest('session/new', (request) => proc.respond(request.id,
      { sessionId: 'sess-acp-1', configOptions: [modelOption('other/model', ['other/model'])] }));
    proc.onRequest('session/set_config_option', (request) => proc.respondError(request.id, -32602, 'Synthetic rejection'));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', generationBudget: BUDGET,
      ...(mode !== 'missing-request' ? { sessionConfig: { model: MODEL } } : {}) });
    const statuses: string[] = [];
    adapter.on('status', (status) => statuses.push(status));
    try {
      await expect(adapter.spawn()).rejects.toThrow('Unable to confirm the selected model');
      expect(statuses).not.toContain('ready');
      expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
    } finally { proc.exit(); }
  });

  it.each(['new', 'resumed'] as const)('accepts the budget when a %s session already advertises the target model', async (mode) => {
    const proc = createInitializedAgentHarness();
    const result = { sessionId: 'sess-acp-1', configOptions: [modelOption(MODEL, [MODEL])] };
    proc.onRequest(mode === 'new' ? 'session/new' : 'session/load', (request) => proc.respond(request.id, result));
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', generationBudget: BUDGET,
      sessionConfig: { model: MODEL }, ...(mode === 'resumed' ? { resume: true, sessionId: 'sess-acp-1' } : {}) });
    try {
      await adapter.spawn();
      const response = await adapter.sendMessage({ role: 'user', content: 'Synthetic ordinary request' });
      expect(response.metadata?.['generationBudget']).toEqual({ model: MODEL, combinedOutputTokens: 1024, reasoningBudgetSupported: false });
      expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/set_config_option')).toEqual([]);
    } finally { proc.exit(); }
  });

  it('accepts acknowledged model selection despite an unrelated effort warning', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/set_config_option', (request) => {
      const params = request.params as { configId: string };
      if (params.configId === 'model') proc.respond(request.id, null);
      else proc.respondError(request.id, -32602, 'Synthetic unsupported effort');
    });
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', generationBudget: BUDGET,
      sessionConfig: { model: MODEL, effort: 'high' } });
    try {
      await adapter.spawn();
      const response = await adapter.sendMessage({ role: 'user', content: 'Synthetic ordinary request' });
      expect(response.metadata?.['generationBudget']).toEqual({ model: MODEL, combinedOutputTokens: 1024, reasoningBudgetSupported: false });
    } finally { proc.exit(); }
  });
});


describe('ACP budget confirmation follows the latest native state', () => {
  it.each(['notification', 'effort-response'] as const)('rejects a prior model acknowledgment superseded by a mismatching %s', async (mode) => {
    const proc = createInitializedAgentHarness();
    const options = (selected: string) => [modelOption(selected, ['other/model', MODEL]), {
      id: 'effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }],
    }];
    proc.onRequest('session/new', (request) => proc.respond(request.id, { sessionId: 'sess-acp-1', configOptions: options('other/model') }));
    proc.onRequest('session/set_config_option', (request) => {
      if ((request.params as { configId: string }).configId === 'effort') {
        proc.respond(request.id, { configOptions: options('other/model') }); return;
      }
      proc.respond(request.id, { configOptions: options(MODEL) });
      if (mode === 'notification') proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'config_option_update', configOptions: options('other/model'),
      } });
    });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', generationBudget: BUDGET,
      sessionConfig: { model: MODEL, ...(mode === 'effort-response' ? { effort: 'high' } : {}) } });
    const statuses: string[] = [];
    adapter.on('status', (status) => statuses.push(status));
    try {
      await expect(adapter.spawn()).rejects.toThrow('Unable to confirm the selected model');
      expect(statuses).not.toContain('ready');
      expect(proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toEqual([]);
    } finally { proc.exit(); }
  });
});
