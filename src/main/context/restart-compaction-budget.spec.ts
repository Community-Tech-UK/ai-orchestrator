import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

const captured = vi.hoisted(() => ({ system: '', requested: '', delivered: '', dispatchLimit: 4000, truncations: [] as unknown[] }));
vi.mock('../rlm/llm-service', () => ({ getLLMService: () => ({ isAvailable: async () => true }) }));
vi.mock('../rlm/auxiliary-llm-service', async () => {
  const actual = await vi.importActual<typeof import('../rlm/auxiliary-llm-service')>('../rlm/auxiliary-llm-service');
  const { DEFAULT_SETTINGS } = await import('../../shared/types/settings.types');
  const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson);
  slots.compression.maxInputTokens = 4000;
  const service = actual.AuxiliaryLlmService.getInstance();
  service.configure({ ...DEFAULT_SETTINGS, auxiliaryLlmEnabled: true, auxiliaryLlmDailySpendCapUsd: 0, auxiliaryLlmSlotsJson: JSON.stringify(slots) });
  const transport = service as unknown as {
    resolveEndpointForSlot: () => Promise<unknown>;
    callEndpoint: (endpoint: unknown, model: string, slot: unknown, system: string, user: string) => Promise<string>;
  };
  vi.spyOn(transport, 'resolveEndpointForSlot').mockResolvedValue({ endpoint: {
    id: 'offline-fixture', label: 'offline fixture', provider: 'ollama', source: 'localhost',
    baseUrl: 'http://127.0.0.1:9', enabled: true,
  }, model: 'fixture-model', autoPicked: false });
  vi.spyOn(transport, 'callEndpoint').mockImplementation(async (_endpoint, _model, _slot, _system, user) => {
    captured.delivered = user;
    return '## Goal\nCarry new work forward';
  });
  service.on('auxiliary:input-truncated', event => captured.truncations.push(event));
  return { getAuxiliaryLlmService: () => ({ generate: async (slot: 'compression', system: string, user: string, options?: { preserveInput?: boolean }) => {
    captured.system = system;
    captured.requested = user;
    slots.compression.maxInputTokens = captured.dispatchLimit;
    service.configure({ ...DEFAULT_SETTINGS, auxiliaryLlmEnabled: true, auxiliaryLlmDailySpendCapUsd: 0, auxiliaryLlmSlotsJson: JSON.stringify(slots) });
    return service.generate(slot, system, user, options);
  } }) };
});

import { prepareRestartCompaction } from './restart-compaction';
import { buildContinuityPackage, CONTINUITY_WAIT_RULE } from './compaction-continuity';
import { getTokenCounter } from '../rlm/token-counter';
import { estimateTokens } from '../../shared/utils/token-estimate';

const message = (id: string, type: 'user' | 'assistant' | 'system', content: string, metadata?: Record<string, unknown>): OutputMessage => ({ id, type, content, timestamp: 1, metadata });
const instance = (turns: OutputMessage[], total = 200000) => ({ id: 'budget', outputBuffer: turns, contextUsage: { total, used: 2000, percentage: 1 } }) as Instance;
const withPrior = (prior: string) => [message('prior', 'system', buildContinuityPackage({
  summary: prior, recent: [], messages: [], contextWindow: 200000,
  stats: { summaryGenerated: true, summarySampledMessages: 1, summaryTotalMessages: 1, skippedRanges: [] },
}).text, { internalInput: { source: 'compaction-continuity' } }),
...Array.from({ length: 4 }, (_, i) => message(String(i), i % 2 ? 'assistant' : 'user', `Earlier discussion ${i} `.repeat(650))),
message('newest', 'user', 'Continue the new work.'), message('reply', 'assistant', 'Working on new work.')];

describe('restart compaction through the configured compression service', () => {
  beforeEach(() => { captured.system = ''; captured.requested = ''; captured.delivered = ''; captured.dispatchLimit = 4000; captured.truncations = []; });

  it('retains the complete prior constraints without downstream truncation at a 4000-token limit', async () => {
    const constraint = 'Existing constraint: preserve accessibility settings during all changes.';
    const prior = '## Constraints and preferences\n' + constraint + '\nOlder context and already completed actions. '.repeat(180);
    const prepared = await prepareRestartCompaction(instance(withPrior(prior)), { maxInputTokens: 4000, keepLatestExchanges: 1 });
    expect(captured.requested).toContain(constraint);
    expect(captured.delivered).toContain(prior);
    expect(captured.delivered).toBe(captured.requested);
    expect(getTokenCounter().countTokens(captured.system) + getTokenCounter().countTokens(captured.delivered)).toBeLessThanOrEqual(4000);
    expect(captured.truncations).toEqual([]);
    expect(prepared.stats.skippedRanges.length).toBeGreaterThan(0);
    expect(prepared.text).toContain(`Summary written from ${prepared.stats.summarySampledMessages} of 4 earlier messages`);
    expect(prepared.text.endsWith(CONTINUITY_WAIT_RULE)).toBe(true);
  });

  it('keeps the small-window continuity package within the available window', async () => {
    const turns = Array.from({ length: 8 }, (_, i) => message(String(i), i % 2 ? 'assistant' : 'user', i < 6 ? `Earlier discussion ${i} `.repeat(160) : `recent latest ${i}`));
    const prepared = await prepareRestartCompaction(instance(turns, 4096), { maxInputTokens: 4000 });
    expect(estimateTokens(prepared.text)).toBeLessThanOrEqual(4096);
    expect(captured.delivered).toBe(captured.requested);
    expect(captured.truncations).toEqual([]);
  });

  it('reserves file, branch, evidence and decision data before sampling earlier turns', async () => {
    const turns = withPrior('Keep the blue theme.');
    turns[2]!.content = 'Edited src/auth.ts.\n<branch_switch_summary>\nKeep the legacy parser\n</branch_switch_summary>\n' + turns[2]!.content;
    await prepareRestartCompaction(instance(turns), {
      maxInputTokens: 4000, keepLatestExchanges: 1, evidence: 'Verified evidence: fixture-citation', decisions: 'Decision: preserve response compatibility',
    });
    expect(captured.delivered).toContain('- edit: src/auth.ts');
    expect(captured.delivered).toContain('Keep the legacy parser');
    expect(captured.delivered).toContain('Verified evidence: fixture-citation');
    expect(captured.delivered).toContain('Decision: preserve response compatibility');
    expect(captured.delivered).toBe(captured.requested);
    expect(captured.truncations).toEqual([]);
  });

  it.each(['prior', 'evidence', 'decisions'])('refuses an input limit that cannot fit required %s material before dispatch', async kind => {
    const prior = kind === 'prior' ? 'Keep every existing accessibility constraint. '.repeat(1000) : 'Keep accessibility settings.';
    const options = { maxInputTokens: 4000, keepLatestExchanges: 1, [kind]: 'Required reference data. '.repeat(1000) };
    await expect(prepareRestartCompaction(instance(withPrior(prior)), options)).rejects.toThrow(/session was not restarted/);
    expect(captured.delivered).toBe('');
    expect(captured.requested).toBe('');
    expect(captured.truncations).toEqual([]);
  });

  it('keeps an entire short conversation without applying an unused tiny helper budget', async () => {
    const prepared = await prepareRestartCompaction(instance([message('u', 'user', 'hello'), message('a', 'assistant', 'reply')]), { maxInputTokens: 1 });
    expect(prepared.text).toContain('[user]: hello\n\n[assistant]: reply');
    expect(captured.requested).toBe('');
  });

  it('uses the intact deterministic fallback if the service budget shrinks after fitting', async () => {
    captured.dispatchLimit = 100;
    const prior = 'Keep accessibility settings and the final original request.';
    const prepared = await prepareRestartCompaction(instance(withPrior(prior)), { maxInputTokens: 4000, keepLatestExchanges: 1 });
    expect(captured.requested).toContain(prior);
    expect(captured.delivered).toBe('');
    expect(captured.truncations).toEqual([]);
    expect(prepared.text).toContain(prior);
    expect(prepared.text).toContain('local compaction');
  });
});
