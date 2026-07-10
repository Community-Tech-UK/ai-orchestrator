/**
 * Personality Definitions - Diverse perspectives for multi-agent verification
 * Based on validated research from DelphiAgent - distinct personalities reduce groupthink
 */

import { PersonalityType } from '../../shared/types/verification.types';

export const PERSONALITY_PROMPTS: Record<PersonalityType, string> = {
  'methodical-analyst': `Role: evidence auditor.
- Trace assumptions and claims to concrete evidence.
- Check boundary cases and contradictory facts systematically.
- State uncertainty instead of guessing.
- If a genuine review finds no issue, say so; do not invent one.`,

  'creative-solver': `Role: alternative-design explorer.
- Propose a materially different approach when evidence shows a useful tradeoff.
- Test novelty against the stated constraints and implementation facts.
- Explain what evidence would make the alternative preferable.
- Do not invent novelty or disagreement when the existing approach is sound.`,

  'pragmatic-engineer': `Role: delivery and maintenance reviewer.
- Evaluate implementation cost, operational risk, and long-term maintenance using concrete evidence.
- Prefer the smallest approach that fully meets the goal.
- Identify real-world constraints and verification gaps.
- If no practical issue remains, say so; do not invent cleanup.`,

  'security-focused': `Role: adversarial security reviewer.
- Trace trust boundaries, attacker inputs, privileges, and failure modes to source evidence.
- Report exploitable behavior and its impact; separate it from speculative hardening.
- State what evidence would disprove each material concern.
- If scrutiny finds no security issue, say so; do not invent one.`,

  'user-advocate': `Role: user-outcome reviewer.
- Evaluate the actual interaction, accessibility, error recovery, and user-visible consequences with evidence.
- Distinguish demonstrated friction from personal preference.
- Prefer simpler behavior when it still satisfies the goal.
- If no user-impact issue remains, say so; do not invent one.`,

  'devils-advocate': `Role: claim stress-tester.
- Select the strongest claim in the material and test its assumptions, counterexamples, and evidence.
- Maintain a challenge only while specific evidence supports it; state what would change your mind.
- If it holds after genuine scrutiny, say so explicitly.
- Do not manufacture disagreement for the sake of being contrarian.`,

  'domain-expert': `Role: standards and domain-evidence reviewer.
- Compare the work with source-backed standards, repository conventions, and verified domain constraints.
- Cite the evidence behind specialized claims and mark anything uncertain.
- Do not treat role authority as evidence.
- If no domain-specific issue remains, say so; do not invent one.`,

  generalist: `Role: cross-system integration reviewer.
- Trace how the proposal affects adjacent components, users, and operations using concrete evidence.
- Reconcile competing concerns without flattening real disagreement.
- Identify missing integration or ownership boundaries.
- If no cross-system issue remains, say so; do not invent one.`,
};

/**
 * Select appropriate personalities based on task type and count
 */
export function selectPersonalities(count: number, taskType?: string): PersonalityType[] {
  // Always include core perspectives
  const core: PersonalityType[] = ['methodical-analyst', 'pragmatic-engineer'];

  // Task-specific additions
  const taskSpecific: Record<string, PersonalityType[]> = {
    'security-review': ['security-focused', 'devils-advocate'],
    'code-review': ['security-focused', 'user-advocate'],
    architecture: ['creative-solver', 'domain-expert'],
    debugging: ['methodical-analyst', 'devils-advocate'],
    feature: ['user-advocate', 'creative-solver'],
    refactor: ['pragmatic-engineer', 'domain-expert'],
    'api-design': ['user-advocate', 'domain-expert'],
    testing: ['devils-advocate', 'methodical-analyst'],
    documentation: ['user-advocate', 'generalist'],
    performance: ['pragmatic-engineer', 'methodical-analyst'],
  };

  const additions = taskSpecific[taskType || ''] || (['user-advocate'] as PersonalityType[]);

  // Combine and deduplicate
  const combined: PersonalityType[] = [...core, ...additions, 'devils-advocate'];
  const all = [...new Set(combined)] as PersonalityType[];

  // Limit to requested count
  return all.slice(0, count);
}

/**
 * Get the system prompt addition for a personality
 */
export function getPersonalityPrompt(personality: PersonalityType): string {
  return PERSONALITY_PROMPTS[personality] || PERSONALITY_PROMPTS['generalist'];
}

/**
 * Get a brief description of a personality for display
 */
export function getPersonalityDescription(personality: PersonalityType): string {
  const descriptions: Record<PersonalityType, string> = {
    'methodical-analyst': 'Systematic, thorough, evidence-based analysis',
    'creative-solver': 'Unconventional thinking, innovative solutions',
    'pragmatic-engineer': 'Practical, implementation-focused approach',
    'security-focused': 'Risk-aware, security-first perspective',
    'user-advocate': 'User experience and accessibility focused',
    'devils-advocate': 'Critical thinking, challenges assumptions',
    'domain-expert': 'Deep expertise, best practices',
    generalist: 'Holistic, cross-domain perspective',
  };

  return descriptions[personality] || 'General perspective';
}

/**
 * Get all available personalities
 */
export function getAllPersonalities(): PersonalityType[] {
  return Object.keys(PERSONALITY_PROMPTS) as PersonalityType[];
}

/**
 * Validate that a string is a valid personality type
 */
export function isValidPersonality(value: string): value is PersonalityType {
  return value in PERSONALITY_PROMPTS;
}

/**
 * Get recommended personalities for optimal verification diversity
 * Based on research showing 3-5 diverse perspectives work best
 */
export function getRecommendedPersonalities(taskType?: string): {
  minimum: PersonalityType[];
  recommended: PersonalityType[];
  extended: PersonalityType[];
} {
  const base = selectPersonalities(5, taskType);

  return {
    minimum: base.slice(0, 3), // Minimum viable diversity
    recommended: base.slice(0, 4), // Optimal balance
    extended: base, // Full coverage
  };
}
