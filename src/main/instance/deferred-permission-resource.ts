import type { PermissionScope } from '../security/permission-manager';

/**
 * The scope and match key a held or live permission ask is judged by.
 *
 * Bash keeps its whole command, so a saved decision matches the same command later.
 * Every other tool is judged by the tool alone. Scoping Write and Edit to their file would
 * let the built-in "allow writes in the project folder" rule answer the ask, and the
 * person would never be shown it (a held Write asks because nothing has allowed it).
 */
export function deferredPermissionResource(toolName: string | undefined, input: Record<string, unknown> | undefined): { scope: PermissionScope; resource: string } {
  const command = toolName === 'Bash' ? input?.['command'] : undefined;
  return {
    scope: toolName === 'Bash' ? 'bash_execute' : 'tool_use',
    resource: command ? `bash:${String(command)}` : `tool:${toolName || 'unknown'}`,
  };
}
