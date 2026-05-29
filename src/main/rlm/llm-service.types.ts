/**
 * Shared types for LLMService.
 * Extracted from llm-service.ts to keep the main module under the LOC ceiling.
 */

export interface LLMServiceConfig {
  provider: 'anthropic' | 'ollama' | 'openai' | 'local';
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  ollamaHost?: string;
}

export interface SummarizeRequest {
  requestId: string;
  content: string;
  targetTokens: number;
  preserveKeyPoints?: boolean;
}

export interface SummarizeResponse {
  requestId: string;
  summary: string;
  originalTokens: number;
  summaryTokens: number;
}

export interface SubQueryRequest {
  requestId: string;
  prompt: string;
  context: string;
  depth: number;
}

export interface SubQueryResponse {
  requestId: string;
  response: string;
  depth: number;
  tokens: { input: number; output: number };
}

/**
 * Streaming chunk for real-time output
 */
export interface StreamChunk {
  requestId: string;
  chunk: string;
  done: boolean;
  error?: string;
}

/**
 * Streaming callback type
 */
export type StreamCallback = (chunk: StreamChunk) => void;
