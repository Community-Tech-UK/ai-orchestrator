/**
 * CLI Module - Multi-CLI support for Harness
 *
 * This module provides adapters and utilities for managing multiple
 * AI CLI tools including Claude Code, OpenAI Codex, Google Gemini, and more.
 */

// Adapters
export {
  BaseCliAdapter,
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliToolCall,
  CliUsage,
  CliStatus,
  CliEvent,
  CliAttachment,
  CliAdapterEvents,
} from './adapters/base-cli-adapter';

export {
  ClaudeCliAdapter,
  ClaudeCliSpawnOptions,
  ClaudeCliAdapterEvents,
} from './adapters/claude-cli-adapter';

export {
  CodexCliAdapter,
  CodexCliConfig,
} from './adapters/codex-cli-adapter';

export {
  GeminiCliAdapter,
  GeminiCliConfig,
} from './adapters/gemini-cli-adapter';

// Detection
export {
  CliDetectionService,
  CliInfo,
  CliType,
  DetectionResult,
  detectAvailableClis,
  isCliAvailable,
  getDefaultCli,
  getCliConfig,
} from './cli-detection';

// Error handling
export {
  CliError,
  CliErrorHandler,
  CliErrorManager,
  FallbackStrategy,
  RetryOptions,
  classifyError,
  getErrorHandler,
  getCliErrorManager,
  withRetry,
  sleep,
  calculateBackoffDelay,
  DEFAULT_ERROR_HANDLERS,
  DEFAULT_RETRY_OPTIONS,
} from './cli-error-handler';

// Parsers
export { NdjsonParser } from './ndjson-parser';

// Input formatting
export { InputFormatter } from './input-formatter';

// File handling
export { processAttachments, buildMessageWithFiles } from './file-handler';
