/**
 * Context Manager Utility Functions
 *
 * Pure utility functions for text processing, hashing, and calculations.
 * These functions are stateless and have no side effects.
 */

import * as crypto from 'crypto';
import { estimateTokens as sharedEstimateTokens } from '../../../shared/utils/token-estimate';

/**
 * Estimate token count for a text string.
 * Delegates to the shared, CJK-aware heuristic in
 * `src/shared/utils/token-estimate.ts`.
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  return sharedEstimateTokens(text);
}

/**
 * Compute MD5 checksum of content (truncated to 12 chars).
 *
 * @param content - Content to hash
 * @returns 12-character hex checksum
 */
export function computeChecksum(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
}

/**
 * Calculate cosine similarity between two vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Similarity score between 0 and 1
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Split content into chunks by logical boundaries (paragraphs).
 * If chunks are still too large, forces split by lines.
 *
 * @param content - Content to split
 * @param maxChunkTokens - Maximum tokens per chunk
 * @param tokenEstimator - Optional custom token estimator function
 * @returns Array of content chunks
 */
export function splitContent(
  content: string,
  maxChunkTokens: number,
  tokenEstimator: (text: string) => number = estimateTokens
): string[] {
  const chunks: string[] = [];

  // Try to split by double newlines (paragraphs)
  const paragraphs = content.split(/\n\n+/);
  let currentChunk = '';

  for (const para of paragraphs) {
    const combined = currentChunk + (currentChunk ? '\n\n' : '') + para;
    if (tokenEstimator(combined) > maxChunkTokens) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = para;
    } else {
      currentChunk = combined;
    }
  }

  if (currentChunk) chunks.push(currentChunk);

  // If still too large, force split
  return chunks.flatMap((chunk) => {
    if (tokenEstimator(chunk) > maxChunkTokens) {
      return forceSplit(chunk, maxChunkTokens, tokenEstimator);
    }
    return [chunk];
  });
}

/**
 * Force split content by lines when paragraph splitting isn't enough.
 *
 * @param content - Content to split
 * @param maxTokens - Maximum tokens per chunk
 * @param tokenEstimator - Optional custom token estimator function
 * @returns Array of content chunks
 */
export function forceSplit(
  content: string,
  maxTokens: number,
  tokenEstimator: (text: string) => number = estimateTokens
): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let currentChunk = '';

  for (const line of lines) {
    const combined = currentChunk + (currentChunk ? '\n' : '') + line;
    if (tokenEstimator(combined) > maxTokens) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk = combined;
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

/**
 * Generate a unique ID with prefix.
 *
 * @param prefix - ID prefix (e.g., 'ctx', 'sec', 'sum')
 * @returns Unique ID string
 */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a short unique ID for sub-items.
 *
 * @param prefix - ID prefix
 * @param index - Optional index for batch operations
 * @returns Unique ID string
 */
export function generateShortId(prefix: string, index?: number): string {
  const suffix = Math.random().toString(36).substr(2, 6);
  if (index !== undefined) {
    return `${prefix}-${Date.now()}-${index}-${suffix}`;
  }
  return `${prefix}-${Date.now()}-${suffix}`;
}
