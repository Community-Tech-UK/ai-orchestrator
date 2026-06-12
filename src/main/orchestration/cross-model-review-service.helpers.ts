/**
 * Helpers for CrossModelReviewService: reviewer-JSON parsing and working
 * directory validation. Extracted to keep the class file focused.
 */

import { getLogger } from '../logging/logger';
import { directoryExists } from '../cli/adapters/base-cli-adapter-utils';

const logger = getLogger('CrossModelReviewService');

/**
 * Validate a review working directory before handing it to a locally-spawned
 * reviewer CLI. A missing/invalid directory (remote-node path like `C:\...`
 * on macOS, deleted worktree, plain file) makes Node fail the spawn with a
 * misleading `spawn <cli> ENOENT`. Reviews carry their content in the prompt,
 * so falling back to the process cwd degrades gracefully instead of crashing.
 */
export function resolveReviewWorkingDirectory(candidate: string | undefined): string {
  if (candidate) {
    if (directoryExists(candidate)) {
      return candidate;
    }
    logger.warn('Review working directory missing or not a directory — falling back to process cwd', {
      candidate,
    });
  }
  return process.cwd();
}

/**
 * Extract JSON from a reviewer response, handling common model output quirks:
 * markdown fences, preamble text, trailing commentary, nested braces.
 */
export function extractJson(rawResponse: string): unknown | null {
  let cleaned = rawResponse.trim();

  // Strategy 1: Extract from markdown fences (```json ... ``` or ``` ... ```)
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Strategy 2: Direct parse (works when model follows instructions perfectly)
  try {
    return JSON.parse(cleaned);
  } catch {
    // continue to fallback strategies
  }

  // Strategy 3: Find the outermost balanced JSON object
  const jsonStart = cleaned.indexOf('{');
  if (jsonStart >= 0) {
    const candidate = extractBalancedJson(cleaned, jsonStart);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        // continue
      }
    }

    // Strategy 4: Greedy regex fallback (last resort)
    const greedyMatch = cleaned.match(/\{[\s\S]*\}/);
    if (greedyMatch) {
      try {
        return JSON.parse(greedyMatch[0]);
      } catch {
        // all strategies exhausted
      }
    }
  }

  return null;
}

/**
 * Extract a balanced JSON object starting at the given index.
 * Tracks brace depth to avoid grabbing trailing text.
 */
export function extractBalancedJson(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}
