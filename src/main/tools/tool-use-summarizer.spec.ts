import { describe, it, expect, vi } from 'vitest';
import { ToolUseSummarizer } from './tool-use-summarizer';
import type { ToolExecutionResult } from './streaming-tool-executor';

describe('ToolUseSummarizer', () => {
  it('generates a summary from tool results', async () => {
    const mockLlm = vi.fn(async (_prompt: string) => 'Read 3 files and edited config.json');
    const summarizer = new ToolUseSummarizer(mockLlm);

    const results: ToolExecutionResult[] = [
      { toolUseId: '1', toolId: 'read', ok: true, output: 'file contents...', durationMs: 100 },
      { toolUseId: '2', toolId: 'edit', ok: true, output: 'edited', durationMs: 200 },
    ];

    const summary = await summarizer.summarize(results);
    expect(summary).toBe('Read 3 files and edited config.json');
    expect(mockLlm).toHaveBeenCalledOnce();
  });

  it('returns fallback summary when LLM call fails', async () => {
    const mockLlm = vi.fn(async () => { throw new Error('API down'); });
    const summarizer = new ToolUseSummarizer(mockLlm);

    const results: ToolExecutionResult[] = [
      { toolUseId: '1', toolId: 'bash', ok: true, output: 'ok', durationMs: 50 },
    ];

    const summary = await summarizer.summarize(results);
    expect(summary).toContain('bash');
    expect(summary).toContain('1 tool');
  });

  it('returns null for empty results', async () => {
    const mockLlm = vi.fn();
    const summarizer = new ToolUseSummarizer(mockLlm);
    const summary = await summarizer.summarize([]);
    expect(summary).toBeNull();
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('includes error information in summary prompt', async () => {
    const mockLlm = vi.fn(async () => 'Attempted bash command but it failed');
    const summarizer = new ToolUseSummarizer(mockLlm);

    const results: ToolExecutionResult[] = [
      { toolUseId: '1', toolId: 'bash', ok: false, error: 'command not found', durationMs: 30 },
    ];

    const summary = await summarizer.summarize(results);
    expect(mockLlm).toHaveBeenCalledOnce();
    const prompt = mockLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('failed');
  });
});
