import { openCodeRecord } from './opencode-config-shapes';

type OpenCodePermissionAction = 'allow' | 'ask';
const READ_PERMISSIONS = ['read', 'list', 'glob', 'grep', 'lsp', 'todowrite', 'skill'] as const;
const ASK_PERMISSIONS = ['edit', 'bash', 'task', 'external_directory', 'webfetch', 'websearch', 'question', 'doom_loop'] as const;
const NATIVE_AGENTS = ['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary'];

export function buildOpenCodePermissionBlock(yoloMode: boolean): Record<string, OpenCodePermissionAction> {
  const writeAction = yoloMode ? 'allow' : 'ask';
  const block: Record<string, OpenCodePermissionAction> = { '*': writeAction };
  for (const key of READ_PERMISSIONS) block[key] = 'allow';
  for (const key of ASK_PERMISSIONS) block[key] = writeAction;
  block['doom_loop'] = 'ask';
  return block;
}

/** Native config merges retain existing key positions. A previously absent final wildcard wins. */
function appendDoomLoopBrake(permission: Record<string, unknown>, native: Record<string, unknown>): Record<string, unknown> {
  let key = 'doom_loop*';
  for (let attempt = 0; attempt < 64; attempt++, key += '*') {
    if (Object.hasOwn(permission, key) || Object.hasOwn(native, key)) continue;
    // Also tightens doom_loop-prefixed custom permissions; unrelated permission keys retain their actions.
    return { ...permission, doom_loop: 'ask', [key]: 'ask' };
  }
  throw new Error('Unable to enforce native OpenCode doom-loop permission safely.');
}

const permissionRecord = (value: unknown) => typeof value === 'string' ? { '*': value } : openCodeRecord(value);

export function applyOpenCodePermissionPolicy(base: Record<string, unknown>, yoloMode: boolean, effective?: Record<string, unknown>): void {
  base['permission'] = appendDoomLoopBrake({ ...permissionRecord(base['permission']), ...buildOpenCodePermissionBlock(yoloMode) }, openCodeRecord(effective?.['permission']));
  const agents = openCodeRecord(base['agent']);
  const nativeAgents = openCodeRecord(effective?.['agent']);
  for (const name of new Set([...NATIVE_AGENTS, ...Object.keys(agents), ...Object.keys(nativeAgents)])) {
    const agent = openCodeRecord(agents[name]);
    if (agent['disable'] === true || openCodeRecord(nativeAgents[name])['disable'] === true) continue;
    agents[name] = { ...agent, permission: appendDoomLoopBrake(permissionRecord(agent['permission']), openCodeRecord(openCodeRecord(nativeAgents[name])['permission'])) };
  }
  base['agent'] = agents;
}

function matchesDoomLoop(key: string): boolean {
  if (key.length > 256) throw new Error('Unable to enforce native OpenCode doom-loop permission safely.');
  // Match native wildcard syntax; coalesce stars to avoid pathological regex backtracking.
  let pattern = key.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*').replace(/\?/g, '.');
  if (pattern.endsWith(' .*')) pattern = `${pattern.slice(0, -3)}( .*)?`;
  return new RegExp(`^${pattern}$`, process.platform === 'win32' ? 'si' : 's').test('doom_loop');
}

/** Verify post-overlay precedence, including managed config and OPENCODE_PERMISSION. */
export function assertOpenCodePermissionPolicy(effective: Record<string, unknown>): void {
  const globalPermission = openCodeRecord(effective['permission']);
  const agents = openCodeRecord(effective['agent']);
  for (const name of new Set([...NATIVE_AGENTS, ...Object.keys(agents)])) {
    const agent = openCodeRecord(agents[name]);
    if (agent['disable'] === true) continue;
    const rules = [...Object.entries(globalPermission), ...Object.entries(openCodeRecord(agent['permission']))];
    if (rules.filter(([key]) => matchesDoomLoop(key)).at(-1)?.[1] !== 'ask') {
      throw new Error('Unable to enforce native OpenCode doom-loop permission safely.');
    }
  }
}
