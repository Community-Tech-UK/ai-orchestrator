import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorWithholder, RecoveryOutcome, type RecoveryResult } from './error-withholder';

describe('ErrorWithholder', () => {
  let withholder: ErrorWithholder;
  let mockCollapseRecover: ReturnType<typeof vi.fn>;
  let mockReactiveCompact: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCollapseRecover = vi.fn(async () => ({ success: true, tokensSaved: 5000 }));
    mockReactiveCompact = vi.fn(async () => ({ success: true, tokensSaved: 20000 }));

    withholder = new ErrorWithholder({
      collapseRecovery: mockCollapseRecover,
      reactiveCompact: mockReactiveCompact,
    });
  });

  it('attempts collapse recovery first for prompt-too-long', async () => {
    const result = await withholder.handlePromptTooLong();
    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.stage).toBe('context_collapse');
    expect(mockCollapseRecover).toHaveBeenCalledOnce();
    expect(mockReactiveCompact).not.toHaveBeenCalled();
  });

  it('falls back to reactive compact when collapse fails', async () => {
    mockCollapseRecover.mockResolvedValueOnce({ success: false });

    const result = await withholder.handlePromptTooLong();
    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.stage).toBe('reactive_compact');
    expect(mockReactiveCompact).toHaveBeenCalledOnce();
  });

  it('surfaces error when all recovery fails', async () => {
    mockCollapseRecover.mockResolvedValueOnce({ success: false });
    mockReactiveCompact.mockResolvedValueOnce({ success: false });

    const result = await withholder.handlePromptTooLong();
    expect(result.outcome).toBe(RecoveryOutcome.FAILED);
    expect(result.stage).toBe('exhausted');
  });

  it('prevents re-attempting reactive compact', async () => {
    mockCollapseRecover.mockResolvedValue({ success: false });
    mockReactiveCompact.mockResolvedValueOnce({ success: true, tokensSaved: 10000 });

    // First attempt — reactive compact works
    await withholder.handlePromptTooLong();

    // Second attempt — reactive compact already used
    mockReactiveCompact.mockResolvedValueOnce({ success: true, tokensSaved: 5000 });
    const result = await withholder.handlePromptTooLong();

    // Should NOT re-attempt reactive compact
    expect(result.outcome).toBe(RecoveryOutcome.FAILED);
  });

  it('accepts silent overflow evidence before attempting recovery', async () => {
    const result = await withholder.handlePromptTooLong({
      outputText: '',
      promptTokens: 198_000,
      contextWindowTokens: 200_000,
    });

    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.stage).toBe('context_collapse');
    expect(mockCollapseRecover).toHaveBeenCalledOnce();
  });

  it('rejects weak silent evidence without running recovery', async () => {
    const result = await withholder.handlePromptTooLong({
      outputText: '',
      promptTokens: 40_000,
      contextWindowTokens: 200_000,
    });

    expect(result).toEqual<RecoveryResult>({
      outcome: RecoveryOutcome.FAILED,
      stage: 'not_context_overflow',
    });
    expect(mockCollapseRecover).not.toHaveBeenCalled();
    expect(mockReactiveCompact).not.toHaveBeenCalled();
  });

  it('handles max-output-tokens with escalation', async () => {
    const result = await withholder.handleMaxOutputTokens();
    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.newOutputLimit).toBe(65536);
  });

  it('handles repeated max-output-tokens with continuation injection', async () => {
    // First: escalation
    await withholder.handleMaxOutputTokens();

    // Second: continuation
    const result = await withholder.handleMaxOutputTokens();
    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.continuationNeeded).toBe(true);
  });
});
