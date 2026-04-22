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
  const builtIns = [
    [CLAUDE_DESCRIPTOR, (config: typeof CLAUDE_DESCRIPTOR.defaultConfig) => new ClaudeCliProvider(config)],
    [CODEX_DESCRIPTOR, (config: typeof CODEX_DESCRIPTOR.defaultConfig) => new CodexCliProvider(config)],
    [GEMINI_DESCRIPTOR, (config: typeof GEMINI_DESCRIPTOR.defaultConfig) => new GeminiCliProvider(config)],
    [COPILOT_DESCRIPTOR, (config: typeof COPILOT_DESCRIPTOR.defaultConfig) => new CopilotCliProvider(config)],
    [CURSOR_DESCRIPTOR, (config: typeof CURSOR_DESCRIPTOR.defaultConfig) => new CursorCliProvider(config)],
  ] as const;

  for (const [descriptor, factory] of builtIns) {
    try {
      registry.get(descriptor.provider);
      continue;
    } catch {
      registry.register(descriptor, factory);
    }
  }
}
