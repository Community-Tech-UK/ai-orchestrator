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
  'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'grok' | 'opencode'
>;

export type OrchestratorRuntimeInjectionProvider = Extract<
  CanonicalCliType,
  'claude' | 'codex' | 'copilot' | 'cursor' | 'grok' | 'opencode'
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
  'antigravity',
  'copilot',
  'grok',
  'opencode',
];

export const ORCHESTRATOR_INJECTION_PROVIDERS: readonly SupportedProvider[] = [
  'claude',
  'codex',
  'copilot',
  'grok',
  'opencode',
];

export const ORCHESTRATOR_RUNTIME_INJECTION_PROVIDERS: readonly OrchestratorRuntimeInjectionProvider[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'grok',
  'opencode',
];

export const PROVIDER_SCOPES: Record<SupportedProvider, readonly ProviderMcpScope[]> = {
  claude: ['user', 'project', 'local'],
  codex: ['user'],
  gemini: ['user'],
  antigravity: ['user'],
  copilot: ['user', 'workspace', 'managed', 'system'],
  // `~/.grok/config.toml` (user) and `.grok/config.toml` (project) — see the
  // Grok Build README, "MCP Servers" / "Project-Scoped MCP Servers".
  grok: ['user', 'project'],
  // `opencode.json(c)` in the OpenCode config dir (user) and the workspace
  // root (project).
  opencode: ['user', 'project'],
};

export const WRITABLE_SCOPES_BY_PROVIDER: Record<
  SupportedProvider,
  readonly ProviderMcpScope[]
> = {
  claude: ['user'],
  codex: ['user'],
  gemini: ['user'],
  antigravity: ['user'],
  copilot: ['user'],
  grok: ['user'],
  opencode: ['user'],
};

export function isProviderScope(scope: McpScope): scope is ProviderMcpScope {
  return (Object.values(PROVIDER_SCOPES) as readonly (readonly McpScope[])[])
    .some((scopes) => scopes.includes(scope));
}

export function isSupportedProvider(provider: string | undefined): provider is SupportedProvider {
  return Boolean(provider && (SUPPORTED_PROVIDERS as readonly string[]).includes(provider));
}

export function isOrchestratorRuntimeInjectionProvider(
  provider: string | undefined,
): provider is OrchestratorRuntimeInjectionProvider {
  return Boolean(
    provider &&
    (ORCHESTRATOR_RUNTIME_INJECTION_PROVIDERS as readonly string[]).includes(provider)
  );
}

export function isWritableScope(
  provider: SupportedProvider,
  scope: ProviderMcpScope,
): boolean {
  return WRITABLE_SCOPES_BY_PROVIDER[provider].includes(scope);
}
