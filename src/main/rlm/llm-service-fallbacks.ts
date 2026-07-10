/**
 * LLM-free fallback text helpers for LLMService.
 *
 * Split out of llm-service.ts. These run when no LLM backend is available and
 * are pure string transforms (heuristic extraction / summarization), so they
 * live here as free functions.
 */
import { LLM_UNAVAILABLE_TEXT } from './llm-service.constants';

/**
 * Local extraction without LLM (fallback).
 */
export function generateLocalFallback(prompt: string): string {
  // For summarization, extract key content
  // For sub-queries, return a message that LLM is unavailable
  if (prompt.includes('summarize')) {
    const content = prompt.split('Summary:')[0];
    const targetMatch = prompt.match(/approximately (\d+) tokens/);
    const targetTokens = targetMatch ? parseInt(targetMatch[1]) : 500;
    return fallbackSummarize(content, targetTokens);
  }

  return LLM_UNAVAILABLE_TEXT;
}

/**
 * Fallback summarization without LLM.
 */
export function fallbackSummarize(content: string, targetTokens: number): string {
  const targetChars = targetTokens * 4;
  const lines = content.split('\n');

  // Extract key lines (headers, first sentences, etc.)
  const keyLines: string[] = [];
  let currentChars = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Prioritize headers and important patterns
    const isHeader = /^#+\s/.test(trimmed) || /^[A-Z][^.]*:/.test(trimmed);
    const isImportant = /^(NOTE|IMPORTANT|TODO|WARNING|CRITICAL)/i.test(trimmed);

    if (isHeader || isImportant || keyLines.length < 5) {
      if (currentChars + trimmed.length <= targetChars) {
        keyLines.push(trimmed);
        currentChars += trimmed.length;
      }
    }
  }

  // If we have room, add more content
  for (const line of lines) {
    if (currentChars >= targetChars) break;
    const trimmed = line.trim();
    if (!trimmed || keyLines.includes(trimmed)) continue;

    if (currentChars + trimmed.length <= targetChars) {
      keyLines.push(trimmed);
      currentChars += trimmed.length;
    }
  }

  return keyLines.join('\n');
}
