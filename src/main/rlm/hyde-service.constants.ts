/**
 * HyDE Service - Default configuration and prompt templates
 */

import type { HyDEConfig } from './hyde-service.types';

export const DEFAULT_CONFIG: HyDEConfig = {
  enabled: true,
  minQueryLength: 10,
  maxHypotheticalTokens: 300,
  generationTimeout: 3000,
  cacheEnabled: true,
  cacheSize: 500,
  contextHints: 'auto',
  multiHypothetical: false,
  hypotheticalCount: 3
};

// System prompts for different context types
export const HYDE_PROMPTS: Record<string, string> = {
  code: `You are a code documentation expert. Given a search query about code, generate a hypothetical code snippet or documentation that would answer the query.

Rules:
- Write actual code or technical documentation, not a meta-description
- Include realistic function/variable names, types, and patterns
- Keep it concise but representative of what real matching code would look like
- Don't explain what you're doing, just write the hypothetical matching content
- Use TypeScript/JavaScript unless the query suggests another language`,

  documentation: `You are a documentation expert. Given a search query, generate a hypothetical documentation section that would answer the query.

Rules:
- Write actual documentation content, not a meta-description
- Include realistic headings, explanations, and examples
- Keep it concise but representative of what real matching docs would look like
- Don't explain what you're doing, just write the hypothetical matching content`,

  mixed: `You are a technical writer. Given a search query, generate a hypothetical document (code, documentation, or config) that would answer the query.

Rules:
- Write actual content, not a meta-description
- If the query is about code, write code with comments
- If the query is about concepts, write documentation
- If the query is about configuration, write config examples
- Keep it concise but representative
- Don't explain what you're doing, just write the hypothetical matching content`
};
