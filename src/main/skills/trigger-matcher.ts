/**
 * Trigger Matcher
 * Matches user input against skill triggers for auto-loading
 */

import type { SkillBundle, SkillMetadata } from '../../shared/types/skill.types';

export interface TriggerMatch {
  skillName: string;
  bundle: SkillBundle;
  matchedTrigger: string;
  matchScore: number; // 0-1, higher is better match
  matchType: 'exact' | 'partial' | 'fuzzy';
}

export interface TriggerMatchOptions {
  minScore?: number; // Minimum score to consider a match (default: 0.5)
  maxResults?: number; // Maximum number of matches to return
  caseSensitive?: boolean;
}

export class TriggerMatcher {
  private static instance: TriggerMatcher;
  private skillBundles: Map<string, SkillBundle> = new Map();

  static getInstance(): TriggerMatcher {
    if (!this.instance) {
      this.instance = new TriggerMatcher();
    }
    return this.instance;
  }

  private constructor() {}

  // ============ Skill Registration ============

  registerSkill(bundle: SkillBundle): void {
    this.skillBundles.set(bundle.metadata.name, bundle);
  }

  unregisterSkill(skillName: string): void {
    this.skillBundles.delete(skillName);
  }

  registerSkills(bundles: SkillBundle[]): void {
    for (const bundle of bundles) {
      this.registerSkill(bundle);
    }
  }

  // ============ Trigger Matching ============

  match(input: string, options?: TriggerMatchOptions): TriggerMatch[] {
    const minScore = options?.minScore ?? 0.5;
    const maxResults = options?.maxResults ?? 5;
    const caseSensitive = options?.caseSensitive ?? false;

    const matches: TriggerMatch[] = [];
    const normalizedInput = caseSensitive ? input : input.toLowerCase();

    for (const [, bundle] of this.skillBundles) {
      const bestMatch = this.findBestMatch(normalizedInput, bundle, caseSensitive);
      if (bestMatch && bestMatch.matchScore >= minScore) {
        matches.push(bestMatch);
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.matchScore - a.matchScore);

    return matches.slice(0, maxResults);
  }

  private findBestMatch(input: string, bundle: SkillBundle, caseSensitive: boolean): TriggerMatch | null {
    let bestMatch: TriggerMatch | null = null;
    let bestScore = 0;

    for (const trigger of bundle.metadata.triggers) {
      const normalizedTrigger = caseSensitive ? trigger : trigger.toLowerCase();
      const { score, type } = this.calculateMatchScore(input, normalizedTrigger);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          skillName: bundle.metadata.name,
          bundle,
          matchedTrigger: trigger,
          matchScore: score,
          matchType: type,
        };
      }
    }

    return bestMatch;
  }

  private calculateMatchScore(
    input: string,
    trigger: string
  ): { score: number; type: 'exact' | 'partial' | 'fuzzy' } {
    // Exact match
    if (input === trigger || input.includes(trigger)) {
      return { score: 1.0, type: 'exact' };
    }

    // Check if trigger is contained in input (partial match)
    const words = trigger.split(/\s+/);
    const inputWords = input.split(/\s+/);
    const matchedWords = words.filter(w => inputWords.some(iw => iw.includes(w) || w.includes(iw)));

    if (matchedWords.length === words.length) {
      return { score: 0.9, type: 'partial' };
    }

    if (matchedWords.length > 0) {
      const partialScore = 0.5 + (matchedWords.length / words.length) * 0.3;
      return { score: partialScore, type: 'partial' };
    }

    // Fuzzy match using Levenshtein distance
    const fuzzyScore = this.fuzzyMatch(input, trigger);
    if (fuzzyScore > 0.5) {
      return { score: fuzzyScore * 0.7, type: 'fuzzy' }; // Fuzzy matches get lower max score
    }

    return { score: 0, type: 'fuzzy' };
  }

  private fuzzyMatch(input: string, trigger: string): number {
    // Check each word in trigger against input
    const triggerWords = trigger.split(/\s+/);
    let totalScore = 0;

    for (const word of triggerWords) {
      let bestWordScore = 0;

      // Check against each word in input
      const inputWords = input.split(/\s+/);
      for (const inputWord of inputWords) {
        const distance = this.levenshteinDistance(word, inputWord);
        const maxLen = Math.max(word.length, inputWord.length);
        const similarity = 1 - distance / maxLen;
        bestWordScore = Math.max(bestWordScore, similarity);
      }

      totalScore += bestWordScore;
    }

    return totalScore / triggerWords.length;
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  // ============ Utility Methods ============

  getRegisteredSkills(): SkillBundle[] {
    return Array.from(this.skillBundles.values());
  }

  getSkillTriggers(skillName: string): string[] {
    const bundle = this.skillBundles.get(skillName);
    return bundle?.metadata.triggers || [];
  }

  getAllTriggers(): Map<string, string[]> {
    const triggers = new Map<string, string[]>();
    for (const [name, bundle] of this.skillBundles) {
      triggers.set(name, bundle.metadata.triggers);
    }
    return triggers;
  }
}

// Export singleton getter
export function getTriggerMatcher(): TriggerMatcher {
  return TriggerMatcher.getInstance();
}
