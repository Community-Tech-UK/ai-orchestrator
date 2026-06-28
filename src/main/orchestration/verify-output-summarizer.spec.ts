import { describe, it, expect, vi, beforeEach } from 'vitest';

const generate = vi.fn();

vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({ generate }),
}));

import { summarizeVerifyOutput } from './verify-output-summarizer';

describe('summarizeVerifyOutput', () => {
  beforeEach(() => {
    generate.mockReset();
  });

  it('returns null for empty/whitespace output without calling the model', async () => {
    expect(await summarizeVerifyOutput('')).toBeNull();
    expect(await summarizeVerifyOutput('   \n  ')).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns the summary when a local model answers', async () => {
    generate.mockResolvedValue({
      text: '  * Root cause: off-by-one in retry.ts  ',
      decision: { source: 'local', model: 'gemma4:31b' },
    });
    const result = await summarizeVerifyOutput('FAIL retry.spec.ts\nexpected 200 to be 400');
    expect(result).toEqual({
      text: '* Root cause: off-by-one in retry.ts',
      source: 'local',
      model: 'gemma4:31b',
    });
    expect(generate).toHaveBeenCalledWith('verifyOutputSummary', expect.any(String), expect.any(String));
  });

  it('returns null on fallback (no local model available)', async () => {
    generate.mockResolvedValue({ text: '', decision: { source: 'fallback' } });
    expect(await summarizeVerifyOutput('FAIL something')).toBeNull();
  });

  it('returns null when the model yields empty text', async () => {
    generate.mockResolvedValue({ text: '   ', decision: { source: 'local' } });
    expect(await summarizeVerifyOutput('FAIL something')).toBeNull();
  });

  it('never throws — returns null if the service errors', async () => {
    generate.mockRejectedValue(new Error('endpoint down'));
    expect(await summarizeVerifyOutput('FAIL something')).toBeNull();
  });

  it('sends only the tail of very long output, marked as truncated', async () => {
    generate.mockResolvedValue({ text: 'ok', decision: { source: 'local' } });
    const head = 'X'.repeat(5_000);
    const tailMarker = 'TAIL_FAILURE_LINE';
    await summarizeVerifyOutput(`${head}\n${tailMarker}${'Y'.repeat(20_000)}\n${tailMarker}`);
    const userPrompt = generate.mock.calls[0][2] as string;
    expect(userPrompt).toContain('truncated to last');
    expect(userPrompt).toContain(tailMarker); // tail preserved
    expect(userPrompt).not.toContain(head); // head dropped
  });
});
