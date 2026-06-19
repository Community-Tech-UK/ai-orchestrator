/**
 * CLI Adapters - Multi-CLI support for Harness
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

// Gemini CLI adapter (retired — kept for back-compat with persisted data)
export { GeminiCliAdapter, GeminiCliConfig } from './gemini-cli-adapter';

// Antigravity CLI adapter (`agy`) — successor to the Gemini CLI adapter
export { AntigravityCliAdapter, AntigravityCliConfig } from './antigravity-cli-adapter';

// Copilot CLI adapter
export { CopilotCliAdapter, CopilotCliConfig, CopilotCliAdapterEvents, CopilotModelInfo, COPILOT_DEFAULT_MODELS } from './copilot-cli-adapter';

// ACP CLI adapter
export { AcpCliAdapter, AcpCliAdapterConfig } from './acp-cli-adapter';

// Ollama adapter
export { OllamaCliAdapter, OllamaCliConfig } from './ollama-cli-adapter';
