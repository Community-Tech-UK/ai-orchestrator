/**
 * Conflict Detector
 * Heuristic-based detection of contradictions between observations and memory entries.
 * Returns null when detection is ambiguous (LLM fallback required).
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('ConflictDetector');

/**
 * Conflict types detected by heuristic analysis
 */
export type ConflictType = 'negation' | 'value_change' | 'antonym' | 'temporal_supersede';

/**
 * Result of conflict detection
 */
export interface ConflictResult {
  type: ConflictType;
  confidence: number; // 0-1
  explanation: string;
  conflictingSegments: { newContent: string; existingContent: string };
}

// Words that carry little semantic meaning for shared-context analysis
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'must', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'we', 'you', 'he', 'she', 'they',
  'me', 'us', 'him', 'her', 'them', 'my', 'our', 'your', 'his', 'their',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as',
  'into', 'through', 'about', 'and', 'or', 'but', 'if', 'not', 'no',
  'so', 'also', 'then', 'than', 'very', 'just', 'now', 'set', 'get',
  'when', 'where', 'what', 'how', 'which', 'who', 'all', 'each', 'any',
]);

// Antonym pairs — each entry is [wordA, wordB] where each is the antonym of the other
const ANTONYM_PAIRS: [string, string][] = [
  ['enabled', 'disabled'],
  ['enable', 'disable'],
  ['true', 'false'],
  ['yes', 'no'],
  ['success', 'failure'],
  ['succeed', 'fail'],
  ['active', 'inactive'],
  ['open', 'closed'],
  ['public', 'private'],
  ['required', 'optional'],
  ['sync', 'async'],
  ['synchronous', 'asynchronous'],
  ['mutable', 'immutable'],
  ['on', 'off'],
  ['start', 'stop'],
  ['started', 'stopped'],
  ['running', 'stopped'],
  ['allowed', 'denied'],
  ['allow', 'deny'],
  ['valid', 'invalid'],
  ['present', 'absent'],
  ['available', 'unavailable'],
  ['connected', 'disconnected'],
  ['locked', 'unlocked'],
  ['supported', 'unsupported'],
  ['up', 'down'],
  ['pass', 'fail'],
  ['passed', 'failed'],
];

/**
 * Heuristic conflict detector for observations and memory entries.
 * Returns null when detection is ambiguous (would need LLM fallback).
 */
export class ConflictDetector {
  private static instance: ConflictDetector;

  static getInstance(): ConflictDetector {
    if (!this.instance) {
      this.instance = new ConflictDetector();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this as unknown as { instance?: ConflictDetector }).instance = undefined;
  }

  private constructor() {}

  /**
   * Check for conflicts between new content and existing content.
   * Returns ConflictResult if a conflict is detected, null if ambiguous.
   */
  heuristicCheck(newContent: string, existingContent: string): ConflictResult | null {
    if (!newContent || !existingContent) {
      return null;
    }

    const newNorm = this.normalize(newContent);
    const existNorm = this.normalize(existingContent);

    if (newNorm.length < 3 || existNorm.length < 3) {
      return null;
    }

    // Phase 1: Negation patterns
    const negation = this.checkNegation(newNorm, existNorm, newContent, existingContent);
    if (negation) {
      logger.info('Conflict detected: negation', { type: negation.type, confidence: negation.confidence });
      return negation;
    }

    // Phase 2: Antonym pairs with shared context (checked before value_change to avoid
    // classifying antonym-pair values such as enabled/disabled as a generic value change)
    const antonym = this.checkAntonyms(newNorm, existNorm, newContent, existingContent);
    if (antonym) {
      logger.info('Conflict detected: antonym', { type: antonym.type, confidence: antonym.confidence });
      return antonym;
    }

    // Phase 3: Value changes (same key, different value)
    const valueChange = this.checkValueChange(newNorm, existNorm, newContent, existingContent);
    if (valueChange) {
      logger.info('Conflict detected: value_change', { type: valueChange.type, confidence: valueChange.confidence });
      return valueChange;
    }

    return null; // Ambiguous — needs LLM fallback
  }

  // ============ Phase 1: Negation Detection ============

  private checkNegation(
    newNorm: string,
    existNorm: string,
    newContent: string,
    existingContent: string
  ): ConflictResult | null {
    const newSentences = this.extractSentences(newNorm);
    const existSentences = this.extractSentences(existNorm);

    for (const newSent of newSentences) {
      for (const existSent of existSentences) {
        const result = this.sentencesNegate(newSent, existSent);
        if (result) {
          return {
            type: 'negation',
            confidence: 0.85,
            explanation: result,
            conflictingSegments: { newContent, existingContent },
          };
        }
      }
    }

    return null;
  }

  /**
   * Check whether two normalized sentences negate each other.
   * Returns an explanation string if they do, null otherwise.
   */
  private sentencesNegate(a: string, b: string): string | null {
    // Patterns for inserting/removing negation words.
    // Each entry: [negated-pattern, positive-equivalent]
    const negationTransforms: [RegExp, string][] = [
      [/\bcannot\b/g, 'can'],
      [/\bcan not\b/g, 'can'],
      [/\bwill not\b/g, 'will'],
      [/\bwont\b/g, 'will'],
      [/\bdoes not\b/g, 'does'],
      [/\bdoesnt\b/g, 'does'],
      [/\bdo not\b/g, 'do'],
      [/\bdont\b/g, 'do'],
      [/\bis not\b/g, 'is'],
      [/\bisnt\b/g, 'is'],
      [/\bare not\b/g, 'are'],
      [/\barent\b/g, 'are'],
      [/\bwas not\b/g, 'was'],
      [/\bwasnt\b/g, 'was'],
      [/\bwere not\b/g, 'were'],
      [/\bwerent\b/g, 'were'],
      [/\bnever\b/g, 'always'],
      [/\balways\b/g, 'never'],
      [/\bnot\b/g, ''],
    ];

    // Try removing negation from `a` and check if it matches `b`
    for (const [pattern, replacement] of negationTransforms) {
      if (pattern.test(a)) {
        const aWithoutNeg = a.replace(pattern, replacement).replace(/\s{2,}/g, ' ').trim();
        if (this.sentencesSubstantiallyMatch(aWithoutNeg, b)) {
          return `"${a}" negates "${b}"`;
        }
      }

      // Try removing negation from `b` and check if it matches `a`
      if (pattern.test(b)) {
        const bWithoutNeg = b.replace(pattern, replacement).replace(/\s{2,}/g, ' ').trim();
        if (this.sentencesSubstantiallyMatch(bWithoutNeg, a)) {
          return `"${a}" contradicts "${b}" via negation`;
        }
      }
    }

    return null;
  }

  /**
   * Two sentences "substantially match" when they share enough significant words.
   * Threshold: at least 60% word overlap on the shorter sentence.
   */
  private sentencesSubstantiallyMatch(a: string, b: string): boolean {
    const aWords = this.getSignificantWords(a);
    const bWords = this.getSignificantWords(b);

    if (aWords.length === 0 || bWords.length === 0) return false;

    const aSet = new Set(aWords);
    const shared = bWords.filter(w => aSet.has(w)).length;
    const minLen = Math.min(aWords.length, bWords.length);

    return shared / minLen >= 0.6;
  }

  // ============ Phase 2: Value Change Detection ============

  private checkValueChange(
    newNorm: string,
    existNorm: string,
    newContent: string,
    existingContent: string
  ): ConflictResult | null {
    const newPairs = this.extractKeyValuePairs(newNorm);
    const existPairs = this.extractKeyValuePairs(existNorm);

    for (const [key, newVal] of newPairs) {
      const existVal = existPairs.get(key);
      if (existVal === undefined) continue;
      if (existVal === newVal) continue;

      // Values differ for the same key
      const isNumericChange = /^\d+(\.\d+)?$/.test(newVal) && /^\d+(\.\d+)?$/.test(existVal);
      const confidence = isNumericChange ? 0.9 : 0.7;

      return {
        type: 'value_change',
        confidence,
        explanation: `Key "${key}" changed from "${existVal}" to "${newVal}"`,
        conflictingSegments: { newContent, existingContent },
      };
    }

    return null;
  }

  /**
   * Extract key-value pairs from normalized text.
   * Recognises:
   *   - "key = value" and "key: value"  — multi-word keys allowed, any value
   *   - "word is <number>"              — single-word key, numeric value only
   *     (the `is` separator is intentionally restricted to numeric values to avoid
   *     false positives like "the api is fast" vs "the api is efficient")
   */
  extractKeyValuePairs(text: string): Map<string, string> {
    const pairs = new Map<string, string>();

    // Pattern A: "key = value" or "key: value" (multi-word keys, any value)
    const explicitPattern = /([a-z][a-z0-9_\s]{0,30}?)\s*(?:=|:)\s*([a-z0-9_.\-]+)/g;
    let match: RegExpExecArray | null;

    while ((match = explicitPattern.exec(text)) !== null) {
      const rawKey = match[1].trim().replace(/\s+/g, '_');
      const val = match[2].trim();
      if (rawKey.length < 2 || val.length === 0) continue;
      if (!pairs.has(rawKey)) {
        pairs.set(rawKey, val);
      }
    }

    // Pattern B: "word is <number>" — single identifier key, numeric value only.
    // This avoids treating "the api is fast" / "the api is efficient" as a conflict.
    const isNumericPattern = /\b([a-z][a-z0-9_]{0,30})\s+is\s+(\d+(?:\.\d+)?)\b/g;

    while ((match = isNumericPattern.exec(text)) !== null) {
      const key = match[1].trim();
      const val = match[2].trim();
      if (key.length < 2 || val.length === 0) continue;
      if (!pairs.has(key)) {
        pairs.set(key, val);
      }
    }

    return pairs;
  }

  // ============ Phase 3: Antonym Detection ============

  private checkAntonyms(
    newNorm: string,
    existNorm: string,
    newContent: string,
    existingContent: string
  ): ConflictResult | null {
    const newWords = new Set(this.tokenize(newNorm));
    const existWords = new Set(this.tokenize(existNorm));

    for (const [wordA, wordB] of ANTONYM_PAIRS) {
      const newHasA = newWords.has(wordA);
      const newHasB = newWords.has(wordB);
      const existHasA = existWords.has(wordA);
      const existHasB = existWords.has(wordB);

      const isConflict =
        (newHasA && existHasB && !existHasA) ||
        (newHasB && existHasA && !existHasB);

      if (!isConflict) continue;

      // Require shared context: 2+ significant words in common
      const sharedContext = this.sharedSignificantWords(newNorm, existNorm);
      if (sharedContext.length < 2) continue;

      const antonymWord = newHasA ? wordA : wordB;
      const oppositeWord = newHasA ? wordB : wordA;

      return {
        type: 'antonym',
        confidence: 0.7,
        explanation: `"${antonymWord}" and "${oppositeWord}" are antonyms (shared context: ${sharedContext.slice(0, 3).join(', ')})`,
        conflictingSegments: { newContent, existingContent },
      };
    }

    return null;
  }

  // ============ Helpers ============

  /**
   * Lowercase, normalise contractions, and collapse whitespace.
   */
  normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/won't/g, 'wont')
      .replace(/can't/g, 'cannot')
      .replace(/don't/g, 'dont')
      .replace(/doesn't/g, 'doesnt')
      .replace(/isn't/g, 'isnt')
      .replace(/aren't/g, 'arent')
      .replace(/wasn't/g, 'wasnt')
      .replace(/weren't/g, 'werent')
      .replace(/[^\w\s.!?=:\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Split text into sentences on `.`, `!`, `?`, or newlines.
   */
  extractSentences(text: string): string[] {
    return text
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 5);
  }

  /**
   * Split text into individual word tokens.
   */
  private tokenize(text: string): string[] {
    return text.split(/\s+/).filter(w => w.length > 0);
  }

  /**
   * Return words that are not stop words and are at least 3 chars long.
   */
  getSignificantWords(text: string): string[] {
    return this.tokenize(text).filter(w => w.length >= 3 && !STOP_WORDS.has(w));
  }

  /**
   * Words shared between two texts, excluding stop words.
   */
  private sharedSignificantWords(a: string, b: string): string[] {
    const aWords = new Set(this.getSignificantWords(a));
    return this.getSignificantWords(b).filter(w => aWords.has(w));
  }
}

export function getConflictDetector(): ConflictDetector {
  return ConflictDetector.getInstance();
}
