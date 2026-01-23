/**
 * CLI Adapters - Multi-CLI support for Claude Orchestrator
 */

// Base adapter
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
} from './base-cli-adapter';

// Claude CLI adapter
export { ClaudeCliAdapter, ClaudeCliSpawnOptions, ClaudeCliAdapterEvents } from './claude-cli-adapter';

// Codex CLI adapter
export { CodexCliAdapter, CodexCliConfig } from './codex-cli-adapter';

// Gemini CLI adapter
export { GeminiCliAdapter, GeminiCliConfig } from './gemini-cli-adapter';

// Copilot SDK adapter
export { CopilotSdkAdapter, CopilotSdkConfig, CopilotSdkAdapterEvents, CopilotModelInfo, COPILOT_DEFAULT_MODELS } from './copilot-sdk-adapter';
