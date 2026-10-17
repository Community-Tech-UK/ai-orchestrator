import { openCodeRecord } from './opencode-config-shapes';

type OpenCodePermissionAction = 'allow' | 'ask';
const READ_PERMISSIONS = ['read', 'list', 'glob', 'grep', 'lsp', 'todowrite', 'skill'] as const;
const ASK_PERMISSIONS = ['edit', 'bash', 'task', 'external_directory', 'webfetch', 'websearch', 'question', 'doom_loop'] as const;
// Ordered native rules must be matched in their own namespace, including globs.
const NATIVE_ASK_PERMISSIONS = ASK_PERMISSIONS.map((action) => action === 'bash' ? 'shell' : action === 'task' ? 'subagent' : action);
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

function matchesPermission(key: string, action: string, caseSensitive = process.platform !== 'win32'): boolean {
  if (key.length > 256) throw new Error('Unable to enforce native OpenCode doom-loop permission safely.');
  // Match native wildcard syntax; coalesce stars to avoid pathological regex backtracking.
  let pattern = key.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*').replace(/\?/g, '.');
  if (pattern.endsWith(' .*')) pattern = `${pattern.slice(0, -3)}( .*)?`;
  return new RegExp(`^${pattern}$`, caseSensitive ? 's' : 'si').test(action);
}

/** Verify post-overlay precedence, including managed config and OPENCODE_PERMISSION. */
export function assertOpenCodePermissionPolicy(effective: Record<string, unknown>, yoloMode = true, cliMajor = 1): void {
  if (cliMajor >= 2) { assertNativePermissions(effective, yoloMode); return; }
  const globalPermission = openCodeRecord(effective['permission']);
  const agents = openCodeRecord(effective['agent']);
  for (const name of new Set([...NATIVE_AGENTS, ...Object.keys(agents)])) {
    const agent = openCodeRecord(agents[name]);
    if (agent['disable'] === true) continue;
    const rules = [...Object.entries(globalPermission), ...Object.entries(openCodeRecord(agent['permission']))];
    if (rules.filter(([key]) => matchesPermission(key, 'doom_loop')).at(-1)?.[1] !== 'ask') {
      throw new Error('Unable to enforce native OpenCode doom-loop permission safely.');
    }
  }
}


function assertNativePermissions(effective: Record<string, unknown>, yoloMode: boolean): void {
  const agents = openCodeRecord(effective['agent']);
  const globalRules = Array.isArray(effective['permissionRules']) ? effective['permissionRules'] : [];
  for (const name of new Set([...NATIVE_AGENTS, ...Object.keys(agents)])) {
    const agent = openCodeRecord(agents[name]);
    if (agent['disable'] === true) continue;
    const rules = [...globalRules, ...(Array.isArray(agent['permissionRules']) ? agent['permissionRules'] : [])].map(openCodeRecord);
    // Native Windows action casing is not guaranteed; both interpretations must be safe.
    for (const caseSensitive of process.platform === 'win32' ? [true, false] : [true]) {
      for (const action of yoloMode ? ['doom_loop'] : NATIVE_ASK_PERMISSIONS) {
        const matching = rules.filter((rule) => typeof rule['action'] === 'string' && matchesPermission(rule['action'], action, caseSensitive));
        const universal = matching.reduce((last, rule, index) => rule['resource'] === '*' ? index : last, -1);
        if (universal < 0 || matching[universal]?.['effect'] !== 'ask'
          || matching.slice(universal + 1).some((rule) => rule['effect'] === 'allow' || (action === 'doom_loop' && rule['effect'] !== 'ask'))) {
          throw new Error(`Unable to enforce native OpenCode ${action === 'doom_loop' ? 'doom-loop permission' : 'ask permission'} safely.`);
        }
      }
    }
  }
}
