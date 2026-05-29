/**
 * Default configuration and system prompts for LLMService.
 * Extracted from llm-service.ts to keep the main module under the LOC ceiling.
 */

import type { LLMServiceConfig } from './llm-service.types';

export const DEFAULT_CONFIG: LLMServiceConfig = {
  provider: 'local', // Start with local fallback
  maxTokens: 4096,
  temperature: 0.3,
  timeout: 60000,
  ollamaHost: 'http://localhost:11434',
};

// System prompts
export const SUMMARIZE_SYSTEM_PROMPT = `You are a precise summarizer. Your task is to summarize the given content while:
1. Preserving all key points, facts, and important details
2. Maintaining technical accuracy
3. Reducing the text to the target length
4. Using clear, concise language
5. Organizing information logically

Do not add new information or opinions. Only summarize what is provided.`;

export const SUBQUERY_SYSTEM_PROMPT = `You are an intelligent assistant helping to answer questions about code and documentation.
You have access to the following context. Use it to answer the user's question accurately.
If the context doesn't contain enough information, say so clearly.
Be concise but thorough.`;
