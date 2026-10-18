import { describe, expect, it } from 'vitest';
import { recordSuccessfulAuxiliary } from './auxiliary-local-ai-guard';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';

describe('successful auxiliary attribution', () => {
  it('records a cheap-cloud success as a priced helper estimate', () => {
    const records: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(record => records.push(record));
    try {
      recordSuccessfulAuxiliary({ slot: 'compression', endpoint: { id: 'cloud-example', label: 'Example', source: 'manual', provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', enabled: true }, model: 'gpt-5.4-mini', source: 'cheap-cloud', systemPrompt: 'Summarize the content', userPrompt: 'Example content requiring a summary', text: 'Example summary', reason: 'Configured cloud helper' });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ purpose: 'helper', provider: 'openai-compatible', model: 'gpt-5.4-mini', costSource: 'priced', isEstimated: true });
      expect(records[0]?.usage?.cost).toBeGreaterThan(0);
    } finally { stop(); }
  });
});
