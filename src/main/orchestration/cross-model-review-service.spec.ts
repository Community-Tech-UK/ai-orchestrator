import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../cli/adapters/adapter-factory', () => ({
  createCliAdapter: vi.fn(),
  resolveCliType: vi.fn().mockResolvedValue('gemini'),
}));

vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: () => ({
      detectAll: vi.fn().mockResolvedValue({ available: [] }),
    }),
  },
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      crossModelReviewEnabled: true,
      crossModelReviewDepth: 'structured',
      crossModelReviewMaxReviewers: 2,
      crossModelReviewProviders: [],
      crossModelReviewTimeout: 30,
      crossModelReviewTypes: ['code', 'plan', 'architecture'],
    }),
  }),
}));

vi.mock('../core/circuit-breaker', () => ({
  getCircuitBreakerRegistry: () => ({
    getBreaker: () => ({
      execute: async (fn: () => Promise<any>) => fn(),
    }),
  }),
}));

describe('CrossModelReviewService', () => {
  beforeEach(() => {
    CrossModelReviewService._resetForTesting();
  });

  it('creates singleton instance', () => {
    const a = CrossModelReviewService.getInstance();
    const b = CrossModelReviewService.getInstance();
    expect(a).toBe(b);
  });

  it('buffers assistant messages per instance', () => {
    const service = CrossModelReviewService.getInstance();
    service.bufferMessage('inst-1', 'assistant', 'Here is code:\n```ts\nconst x = 1;\n```');
    service.bufferMessage('inst-1', 'user', 'Thanks');
    service.bufferMessage('inst-2', 'assistant', 'Different instance');

    expect(service.getBufferSize('inst-1')).toBe(1);
    expect(service.getBufferSize('inst-2')).toBe(1);
  });

  it('ignores non-assistant messages', () => {
    const service = CrossModelReviewService.getInstance();
    service.bufferMessage('inst-1', 'user', 'Hello');
    service.bufferMessage('inst-1', 'system', 'System msg');
    service.bufferMessage('inst-1', 'tool_use', 'Tool call');
    expect(service.getBufferSize('inst-1')).toBe(0);
  });

  it('clears buffer on instance removal', () => {
    const service = CrossModelReviewService.getInstance();
    service.bufferMessage('inst-1', 'assistant', 'Some output');
    service.clearBuffer('inst-1');
    expect(service.getBufferSize('inst-1')).toBe(0);
  });

  it('stores and retrieves review history', () => {
    const service = CrossModelReviewService.getInstance();
    expect(service.getReviewHistory('inst-1')).toEqual([]);
  });

  it('returns status', () => {
    const service = CrossModelReviewService.getInstance();
    const status = service.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.pendingReviews).toBe(0);
  });
});
