/**
 * Pure provider-inference helpers for instance deserialization.
 *
 * Split out of instance-list.store.ts. Given a raw instance payload, infer the
 * provider from an explicit field, then from the model id / thread / session /
 * instance identifiers. Stateless — no store or signal access.
 */
import type { Instance } from './instance.types';

export function inferInstanceProvider(data: Record<string, unknown>): Instance['provider'] {
  const explicitProvider = data['provider'];
  if (isInstanceProvider(explicitProvider)) {
    return explicitProvider;
  }

  return (
    inferProviderFromModel(data['currentModel'])
    || inferProviderFromIdentifier(data['historyThreadId'])
    || inferProviderFromIdentifier(data['sessionId'])
    || inferProviderFromIdentifier(data['id'])
    || 'claude'
  );
}

function inferProviderFromModel(model: unknown): Instance['provider'] | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }

  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith('gemini')) return 'gemini';
  if (normalized.startsWith('copilot')) return 'copilot';
  if (
    normalized.startsWith('gpt-')
    || normalized.includes('codex')
    || normalized === 'o3'
  ) {
    return 'codex';
  }
  if (
    normalized.startsWith('claude')
    || normalized === 'opus'
    || normalized === 'sonnet'
    || normalized === 'haiku'
  ) {
    return 'claude';
  }

  return undefined;
}

function inferProviderFromIdentifier(value: unknown): Instance['provider'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith('gemini-')) return 'gemini';
  if (normalized.startsWith('codex-')) return 'codex';
  if (normalized.startsWith('copilot-')) return 'copilot';
  if (normalized.startsWith('claude-')) return 'claude';
  if (normalized.startsWith('u-')) return 'cursor';

  return undefined;
}

function isInstanceProvider(value: unknown): value is Instance['provider'] {
  return value === 'claude'
    || value === 'codex'
    || value === 'gemini'
    || value === 'antigravity'
    || value === 'copilot'
    || value === 'ollama'
    || value === 'cursor'
    || value === 'grok';
}
