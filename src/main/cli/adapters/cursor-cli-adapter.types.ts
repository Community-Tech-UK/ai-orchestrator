import type { CliMessage, CliResponse } from './base-cli-adapter';

export interface CursorSystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  model?: string;
  cwd?: string;
  apiKeySource?: string;
  permissionMode?: string;
}

export interface CursorUserEvent {
  type: 'user';
  message: { role: 'user'; content: unknown[] };
  session_id?: string;
}

export interface CursorAssistantEvent {
  type: 'assistant';
  message: { role: 'assistant'; content: { type: 'text'; text: string }[] };
  session_id?: string;
  timestamp_ms?: number;
  model_call_id?: string;
}

export interface CursorToolCallEvent {
  type: 'tool_call';
  subtype: 'started' | 'completed';
  call_id: string;
  tool_call: Record<string, unknown>;
  session_id?: string;
  is_error?: boolean;
}

export interface CursorResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  session_id?: string;
  request_id?: string;
}

export type CursorEvent =
  | CursorSystemInitEvent
  | CursorUserEvent
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent;

export interface ResultState {
  message: CliMessage;
  resolver: (r: CliResponse) => void;
  rejecter: (e: Error) => void;
  completed: boolean;
  retriedWithoutResume: boolean;
  retriedWithoutPartial: boolean;
}

export interface StreamContext {
  streamingMessageId(): string | null;
  setStreamingMessageId(id: string): void;
  appendStreamingContent(chunk: string): void;
  getStreamingContent(): string;
  markDeltaSeen(): void;
  hasDeltaSeen(): boolean;
}

export interface CursorCliConfig {
  model?: string;
  workingDir?: string;
  systemPrompt?: string;
  yoloMode?: boolean;
  timeout?: number;
}
