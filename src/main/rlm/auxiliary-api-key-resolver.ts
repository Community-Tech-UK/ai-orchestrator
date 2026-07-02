import type { AuxiliaryLlmEndpointConfig } from '../../shared/types/auxiliary-llm.types';
import { resolveTrustedConfigValue } from '../core/config/trusted-config-value-resolver';

const API_KEY_RESOLVE_TIMEOUT_MS = 5_000;
const API_KEY_MAX_OUTPUT_BYTES = 16_384;

export function normalizeApiKeyCommandForResolution(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('${') ? trimmed : `\${cmd:${trimmed}}`;
}

export async function resolveAuxiliaryEndpointApiKey(
  endpoint: Pick<AuxiliaryLlmEndpointConfig, 'apiKeyEnv' | 'apiKeyCommand'>,
): Promise<string | undefined> {
  const envName = endpoint.apiKeyEnv?.trim();
  if (envName) {
    const value = process.env[envName];
    if (value) return value;
  }

  const command = endpoint.apiKeyCommand?.trim();
  if (!command) return undefined;

  return resolveTrustedConfigValue(normalizeApiKeyCommandForResolution(command), {
    cwd: process.cwd(),
    allowCommand: true,
    timeoutMs: API_KEY_RESOLVE_TIMEOUT_MS,
    maxOutputBytes: API_KEY_MAX_OUTPUT_BYTES,
  });
}
