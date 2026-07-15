import type { ContextEvidenceMode } from '../../shared/types/settings.types';
import { providerAdapterRegistry } from '../providers/provider-adapter-registry';

export interface ContextEvidenceProviderRegistry {
  list(): readonly { provider: string }[];
  listPluginProviderAdapters?: () => readonly { descriptor: { provider: string } }[];
}

const CONTEXT_EVIDENCE_MODES = new Set<ContextEvidenceMode>(['off', 'shadow', 'enforce']);

/** Canonicalize persisted provider aliases without turning selectors into providers. */
export function normalizeContextEvidenceProviderId(provider: string): string | null {
  const normalized = provider.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return null;
  }
  return normalized === 'openai' ? 'codex' : normalized;
}

/**
 * Produce a complete mode map for the concrete adapters currently registered.
 * Unknown keys and the `auto` selector are dropped. Canonical keys win over
 * legacy aliases so object insertion order cannot change the result.
 */
export function normalizeContextEvidenceModeByProvider(
  input: unknown,
  registry: ContextEvidenceProviderRegistry = providerAdapterRegistry,
): Record<string, ContextEvidenceMode> {
  const concreteProviders = new Set<string>();
  for (const descriptor of registry.list()) {
    const provider = normalizeContextEvidenceProviderId(descriptor.provider);
    if (provider) concreteProviders.add(provider);
  }
  for (const registered of registry.listPluginProviderAdapters?.() ?? []) {
    const provider = normalizeContextEvidenceProviderId(registered.descriptor.provider);
    if (provider) concreteProviders.add(provider);
  }

  const normalized: Record<string, ContextEvidenceMode> = Object.fromEntries(
    [...concreteProviders].sort().map((provider) => [provider, 'off' as const]),
  );
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return normalized;
  }

  const values = input as Record<string, unknown>;
  // Apply the legacy alias first; an explicit canonical key overrides it below.
  const legacyCodex = values['openai'];
  if (concreteProviders.has('codex') && isContextEvidenceMode(legacyCodex)) {
    normalized['codex'] = legacyCodex;
  }
  for (const [rawProvider, rawMode] of Object.entries(values)) {
    if (rawProvider === 'openai') continue;
    const provider = normalizeContextEvidenceProviderId(rawProvider);
    if (provider && concreteProviders.has(provider) && isContextEvidenceMode(rawMode)) {
      normalized[provider] = rawMode;
    }
  }
  return normalized;
}

/** Resolve one provider's mode. Selectors and malformed persisted values are off. */
export function getContextEvidenceMode(
  input: unknown,
  provider: string,
): ContextEvidenceMode {
  const canonicalProvider = normalizeContextEvidenceProviderId(provider);
  if (!canonicalProvider || !input || typeof input !== 'object' || Array.isArray(input)) {
    return 'off';
  }
  const values = input as Record<string, unknown>;
  const canonicalValue = values[canonicalProvider];
  if (isContextEvidenceMode(canonicalValue)) {
    return canonicalValue;
  }
  if (canonicalProvider === 'codex' && isContextEvidenceMode(values['openai'])) {
    return values['openai'];
  }
  return 'off';
}

function isContextEvidenceMode(value: unknown): value is ContextEvidenceMode {
  return typeof value === 'string' && CONTEXT_EVIDENCE_MODES.has(value as ContextEvidenceMode);
}
