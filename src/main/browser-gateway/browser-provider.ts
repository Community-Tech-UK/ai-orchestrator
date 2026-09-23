import type { BrowserProvider } from '@contracts/types/browser';

export function providerFromContext(provider: string | undefined): BrowserProvider {
  return provider === 'claude' ||
    provider === 'codex' ||
    provider === 'gemini' ||
    provider === 'antigravity' ||
    provider === 'copilot' ||
    provider === 'cursor' ||
    provider === 'grok' ||
    provider === 'opencode' ||
    provider === 'orchestrator'
    ? provider
    : 'orchestrator';
}
