/**
 * Plan 14b: a title returned by the resident Claude session goes through the
 * same cleaning (`finalizeDocumentTitle`) as the helper model's title. Without
 * that, a model that narrates would put a paragraph into the session rail.
 * Suffix R6N6.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuxGenerate, mockCreateAdapter } = vi.hoisted(() => ({
  mockAuxGenerate: vi.fn(),
  mockCreateAdapter: vi.fn(),
}));

vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: vi.fn() }));
vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: mockCreateAdapter })),
}));
vi.mock('../cli/cli-detection', () => ({ isCliAvailable: vi.fn() }));
vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: vi.fn(() => ({
    generate: mockAuxGenerate,
    slotAllowsFrontier: vi.fn(() => true),
  })),
}));
vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() })),
}));
vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall: vi.fn() }));

import { AutoTitleService } from './auto-title-service';

const FIRST_MESSAGE = 'Fix the broken deploy pipeline';

describe('AutoTitleService live title cleaning (R6N6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The helper model is down, so the live session is the only upgrade path.
    mockAuxGenerate.mockResolvedValue({
      text: '',
      decision: {
        slot: 'titleGeneration',
        provider: 'local-fallback',
        source: 'fallback',
        reason: 'test fallback',
        allowFrontierFallback: true,
      },
    });
    AutoTitleService._resetForTesting();
    AutoTitleService.getInstance().setCliSpawnEnabledForTesting(false);
  });

  it('cleans a live title the same way as any other generated title', async () => {
    const service = AutoTitleService.getInstance();
    service.setLiveTitleSource(vi.fn().mockResolvedValue('Fix the deploy pipeline.'));
    const applyTitle = vi.fn();
    await service.maybeGenerateTitle('chat-1', FIRST_MESSAGE, applyTitle);
    expect(applyTitle).toHaveBeenLastCalledWith('chat-1', 'Fix the deploy pipeline', 'ai');
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('keeps the instant title when the live reply is a narration of 80 characters or more', async () => {
    const narration =
      'I looked at your request about the deploy pipeline and I think the best title would be fixing it';
    expect(narration.length).toBeGreaterThanOrEqual(80);
    const service = AutoTitleService.getInstance();
    service.setLiveTitleSource(vi.fn().mockResolvedValue(narration));
    const applyTitle = vi.fn();
    await service.maybeGenerateTitle('chat-2', FIRST_MESSAGE, applyTitle);
    expect(applyTitle.mock.calls).toEqual([['chat-2', FIRST_MESSAGE, 'instant']]);
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });
});
