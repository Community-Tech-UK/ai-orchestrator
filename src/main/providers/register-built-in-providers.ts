/**
 * Built-in provider bootstrap — registers all 5 CLI/SDK adapters with the
 * adapter registry.  Call once at main-process startup before any code that
 * creates provider instances via ProviderInstanceManager.
 */

import type { ProviderAdapterRegistry } from '@sdk/provider-adapter-registry';
import { ClaudeCliProvider, CLAUDE_DESCRIPTOR } from './claude-cli-provider';
import { CodexCliProvider, CODEX_DESCRIPTOR } from './codex-cli-provider';
import { GeminiCliProvider, GEMINI_DESCRIPTOR } from './gemini-cli-provider';
import { CopilotCliProvider, COPILOT_DESCRIPTOR } from './copilot-cli-provider';
import { CursorCliProvider, CURSOR_DESCRIPTOR } from './cursor-cli-provider';

export function registerBuiltInProviders(registry: ProviderAdapterRegistry): void {
  registry.register(CLAUDE_DESCRIPTOR,  (config) => new ClaudeCliProvider(config));
  registry.register(CODEX_DESCRIPTOR,   (config) => new CodexCliProvider(config));
  registry.register(GEMINI_DESCRIPTOR,  (config) => new GeminiCliProvider(config));
  registry.register(COPILOT_DESCRIPTOR, (config) => new CopilotCliProvider(config));
  registry.register(CURSOR_DESCRIPTOR,  (config) => new CursorCliProvider(config));
}
