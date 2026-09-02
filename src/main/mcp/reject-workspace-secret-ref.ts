/**
 * Global MCP connector routes (provider-user, shared, orchestrator) must not
 * persist a `secret://` env value. Those scopes are reusable across workspaces,
 * so resolving a workspace-scoped credential there would leak it.
 */
export function isWorkspaceSecretRef(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith('secret://');
}

export function assertNoWorkspaceSecretRefs(
  env: Record<string, string> | undefined,
): void {
  if (!env) {
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (isWorkspaceSecretRef(value)) {
      throw new Error(
        `Workspace secret references cannot be stored on a global MCP connector (${key})`,
      );
    }
  }
}

/** Workspace connectors may keep `secret://` only in env, never headers/url/args. */
export function assertWorkspaceSecretRefsOnlyInEnv(input: {
  headers?: Record<string, string>;
  url?: string;
  args?: string[];
  command?: string;
}): void {
  if (isWorkspaceSecretRef(input.command) || isWorkspaceSecretRef(input.url)) {
    throw new Error('Workspace secret references are only allowed in connector env values');
  }
  for (const value of input.args ?? []) {
    if (isWorkspaceSecretRef(value)) {
      throw new Error('Workspace secret references are only allowed in connector env values');
    }
  }
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (isWorkspaceSecretRef(value)) {
      throw new Error(
        `Workspace secret references are only allowed in connector env values (${key})`,
      );
    }
  }
}
