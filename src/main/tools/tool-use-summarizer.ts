/**
 * Tool Use Summarizer
 *
 * Generates concise summaries of tool execution results.
 * Designed to run async during model streaming time (non-blocking).
 *
 * Inspired by Claude Code's async tool_use_summary generation
 * using a fast model (Haiku ~1s) while the main model streams (5-30s).
 */

import type { ToolExecutionResult } from './streaming-tool-executor';
import { getLogger } from '../logging/logger';

const logger = getLogger('ToolUseSummarizer');

export type LlmSummarizeFn = (prompt: string) => Promise<string>;

export class ToolUseSummarizer {
  constructor(private llmFn: LlmSummarizeFn) {}

  /**
   * Generate a summary of tool execution results.
   * Returns null for empty results.
   * Falls back to a local summary if LLM call fails.
   */
  async summarize(results: ToolExecutionResult[]): Promise<string | null> {
    if (results.length === 0) return null;

    const prompt = this.buildPrompt(results);

    try {
      return await this.llmFn(prompt);
    } catch (err) {
      logger.warn('LLM summarization failed, using fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallbackSummary(results);
    }
  }

  /**
   * Fire-and-forget: returns a promise that resolves to the summary.
   * Designed to run in background during model streaming.
   */
  summarizeAsync(results: ToolExecutionResult[]): Promise<string | null> {
    return this.summarize(results).catch(err => {
      logger.warn('Async summarization failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallbackSummary(results);
    });
  }

  private buildPrompt(results: ToolExecutionResult[]): string {
    const toolSummaries = results.map(r => {
      if (r.ok) {
        const outputPreview = typeof r.output === 'string'
          ? r.output.slice(0, 200)
          : JSON.stringify(r.output)?.slice(0, 200) ?? '';
        return `- ${r.toolId}: succeeded (${r.durationMs}ms) \u2192 ${outputPreview}`;
      } else {
        return `- ${r.toolId}: failed \u2192 ${r.error}`;
      }
    }).join('\n');

    return `Summarize what these tool calls accomplished in one concise sentence (max 100 words):

${toolSummaries}

Summary:`;
  }

  private fallbackSummary(results: ToolExecutionResult[]): string {
    const failed = results.filter(r => !r.ok);
    const toolNames = [...new Set(results.map(r => r.toolId))].join(', ');

    const parts: string[] = [];
    parts.push(`${results.length} tool${results.length === 1 ? '' : 's'} executed`);
    parts.push(`(${toolNames})`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);

    return parts.join(' \u2014 ');
  }
}
