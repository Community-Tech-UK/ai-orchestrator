export const NODE_EXEC_BROWSER_POLICY_ERROR =
  'exec_on_node cannot launch or drive the operator\'s shared Chrome/session';

export function normalizedCommandBasename(value: string): string {
  return value.replace(/\\/gu, '/').split('/').at(-1)?.toLowerCase() ?? '';
}
