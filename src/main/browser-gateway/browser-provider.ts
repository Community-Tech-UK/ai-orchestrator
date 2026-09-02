import type { BrowserProvider } from '@contracts/types/browser';

export function providerFromContext(provider: string | undefined): BrowserProvider {
  return provider === 'claude' ||
    provider === 'codex' ||
    provider === 'gemini' ||
    provider === 'antigravity' ||
    provider === 'copilot' ||
    provider === 'cursor' ||
    provider === 'grok' ||
    provider === 'orchestrator'
    ? provider
    : 'orchestrator';
}
