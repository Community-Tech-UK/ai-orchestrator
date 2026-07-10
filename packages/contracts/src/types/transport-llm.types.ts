/**
 * LLM service IPC payloads.
 *
 * Split out of transport.types.ts (which re-exports them) to keep that module
 * within size limits, mirroring the transport-channel.types split.
 */

export interface LLMSummarizePayload {
  requestId: string;
  content: string;
  targetTokens: number;
  preserveKeyPoints?: boolean;
}

export interface LLMSubQueryPayload {
  requestId: string;
  prompt: string;
  context: string;
  depth: number;
}

export interface LLMCancelStreamPayload {
  requestId: string;
}

export interface LLMCountTokensPayload {
  text: string;
  model?: string;
}

export interface LLMTruncateTokensPayload {
  text: string;
  maxTokens: number;
  model?: string;
}

export interface LLMSetConfigPayload {
  provider?: 'anthropic' | 'ollama' | 'openai' | 'local';
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  ollamaHost?: string;
}

export interface LLMStreamChunkPayload {
  requestId: string;
  chunk: string;
  done: boolean;
  error?: string;
}
