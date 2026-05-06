import type { CanonicalCliType } from './settings.types';

export type ProviderMcpScope =
  | 'user'
  | 'project'
  | 'local'
  | 'workspace'
  | 'managed'
  | 'system';

export type OrchestratorMcpScope =
  | 'orchestrator'
  | 'orchestrator-bootstrap'
  | 'orchestrator-codemem';

export type McpScope = ProviderMcpScope | OrchestratorMcpScope | 'shared';

export type SupportedProvider = Extract<
  CanonicalCliType,
  'claude' | 'codex' | 'gemini' | 'copilot'
>;

export const ALL_MCP_SCOPES: readonly McpScope[] = [
  'user',
  'project',
  'local',
  'workspace',
  'managed',
  'system',
  'orchestrator',
  'orchestrator-bootstrap',
  'orchestrator-codemem',
  'shared',
];

export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = [
  'claude',
  'codex',
  'gemini',
  'copilot',
];

export const ORCHESTRATOR_INJECTION_PROVIDERS: readonly SupportedProvider[] = [
  'claude',
];

export const PROVIDER_SCOPES: Record<SupportedProvider, readonly ProviderMcpScope[]> = {
  claude: ['user', 'project', 'local'],
  codex: ['user'],
  gemini: ['user'],
  copilot: ['user', 'workspace', 'managed', 'system'],
};

export const WRITABLE_SCOPES_BY_PROVIDER: Record<
  SupportedProvider,
  readonly ProviderMcpScope[]
> = {
  claude: ['user'],
  codex: ['user'],
  gemini: ['user'],
  copilot: ['user'],
};

export function isProviderScope(scope: McpScope): scope is ProviderMcpScope {
  return (
    (PROVIDER_SCOPES.claude as readonly McpScope[]).includes(scope) ||
    (PROVIDER_SCOPES.codex as readonly McpScope[]).includes(scope) ||
    (PROVIDER_SCOPES.gemini as readonly McpScope[]).includes(scope) ||
    (PROVIDER_SCOPES.copilot as readonly McpScope[]).includes(scope)
  );
}

export function isSupportedProvider(provider: string | undefined): provider is SupportedProvider {
  return Boolean(provider && (SUPPORTED_PROVIDERS as readonly string[]).includes(provider));
}

export function isWritableScope(
  provider: SupportedProvider,
  scope: ProviderMcpScope,
): boolean {
  return WRITABLE_SCOPES_BY_PROVIDER[provider].includes(scope);
}
