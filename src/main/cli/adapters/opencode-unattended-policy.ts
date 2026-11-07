import { openCodePositive, openCodeRecord, openCodeCompactionBuffer } from './opencode-config-shapes';
import { matchesPermission } from './opencode-permission-policy';

/** Helper usage is not in Harness spend records yet. Keep unattended runs single-session. */
export function applyOpenCodeUnattendedPolicy(config: Record<string, unknown>, effective: Record<string, unknown>, major: number): void {
  const names = new Set(['build', 'plan', 'general', 'explore', ...Object.keys(openCodeRecord(effective['agent']))]);
  if (major >= 2) {
    const deny = () => ({ action: 'subagent', resource: '*', effect: 'deny' });
    config['permissions'] = [...(Array.isArray(config['permissions']) ? config['permissions'] : []), deny()];
    const agents = openCodeRecord(config['agents']);
    for (const name of new Set([...names, ...Object.keys(agents)])) {
      const agent = openCodeRecord(agents[name]);
      agents[name] = { ...agent, permissions: [...(Array.isArray(agent['permissions']) ? agent['permissions'] : []), deny()] };
    }
    config['agents'] = agents;
    const output = openCodeRecord(config['tool_output']);
    const nativeOutput = openCodeRecord(effective['tool_output']);
    const cap = (key: string, maximum: number) => Math.min(maximum, openCodePositive(output[key]) ?? maximum, openCodePositive(nativeOutput[key]) ?? maximum);
    config['tool_output'] = { ...output, max_lines: cap('max_lines', 1000), max_bytes: cap('max_bytes', 30000) };
    const compaction = openCodeRecord(config['compaction']);
    const buffers = [compaction['buffer'], openCodeRecord(effective['compaction'])['buffer']];
    const percentages = buffers.filter((value): value is string => typeof value === 'string');
    if (percentages.some(value => !/^\d+(?:\.\d+)?%$/.test(value) || Number.parseFloat(value) > 100)) throw new Error('Unsupported native compaction buffer');
    const numeric = buffers.filter((value): value is number => typeof value === 'number');
    if (numeric.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Unsupported native compaction buffer');
    config['compaction'] = { ...compaction, buffer: percentages.length
      ? `${Math.max(15, ...percentages.map(value => Number.parseFloat(value)))}%`
      : Math.max(20000, ...numeric) };
  } else {
    const deny = (own: unknown, native: unknown) => {
      const permission = { ...openCodeRecord(own) };
      let key = 'task*';
      while (Object.hasOwn(permission, key) || Object.hasOwn(openCodeRecord(native), key)) {
        key += '*';
        if (key.length > 128) throw new Error('Could not deny unaccounted OpenCode helper sessions.');
      }
      permission[key] = 'deny';
      return permission;
    };
    config['permission'] = deny(config['permission'], effective['permission']);
    const agents = openCodeRecord(config['agent']);
    for (const name of new Set([...names, ...Object.keys(agents)])) {
      const agent = openCodeRecord(agents[name]);
      agents[name] = { ...agent, permission: deny(agent['permission'], openCodeRecord(openCodeRecord(effective['agent'])[name])['permission']) };
    }
    config['agent'] = agents;
  }
}

export function assertOpenCodeHelpersDenied(effective: Record<string, unknown>, major: number): void {
  const agents = openCodeRecord(effective['agent']);
  // Native Windows action casing is not guaranteed; the deny must hold under both interpretations.
  for (const caseSensitive of process.platform === 'win32' ? [true, false] : [true]) {
    for (const agent of [undefined, ...Object.values(agents)]) {
      if (openCodeRecord(agent)['disable'] === true) continue;
      if (major >= 2) {
        const rules = [...(Array.isArray(effective['permissionRules']) ? effective['permissionRules'] : []),
          ...(Array.isArray(openCodeRecord(agent)['permissionRules']) ? openCodeRecord(agent)['permissionRules'] as unknown[] : [])]
          .map(openCodeRecord).filter(rule => typeof rule['action'] === 'string' && matchesPermission(rule['action'], 'subagent', caseSensitive));
        const lastUniversal = rules.reduce((last, rule, i) => rule['resource'] === '*' ? i : last, -1);
        if (lastUniversal < 0 || rules[lastUniversal]?.['effect'] !== 'deny' || rules.slice(lastUniversal + 1).some(rule => rule['effect'] !== 'deny')) {
          throw new Error('Could not deny unaccounted OpenCode helper sessions.');
        }
      } else {
        const rules = [...Object.entries(openCodeRecord(effective['permission'])), ...Object.entries(openCodeRecord(openCodeRecord(agent)['permission']))];
        if (rules.filter(([key]) => matchesPermission(key, 'task', caseSensitive)).at(-1)?.[1] !== 'deny') {
          throw new Error('Could not deny unaccounted OpenCode helper sessions.');
        }
      }
    }
  }
}

export function assertOpenCodeUnattendedLimits(effective: Record<string, unknown>, major: number): void {
  if (major < 2) return;
  const output = openCodeRecord(effective['tool_output']);
  const lines = openCodePositive(output['max_lines']);
  const bytes = openCodePositive(output['max_bytes']);
  const buffer = openCodeCompactionBuffer(openCodeRecord(effective['compaction'])['buffer']);
  if (!lines || lines > 1000 || !bytes || bytes > 30000 || buffer === undefined
    || (typeof buffer === 'number' ? buffer < 20000 : Number.parseFloat(buffer) < 15)) {
    throw new Error('Could not enforce unattended OpenCode output and compaction limits.');
  }
}

/**
 * Only automatic origins count: queue, loop, automation and the other machine sessions, plus overflow work.
 * A child session is a session with a parent, and James can chat in it, so it keeps helpers and normal output.
 */
export function isUnattendedOpenCodeSpawn(options: { machineSession?: string | null; concurrencyPriority?: string }): boolean {
  return Boolean(options.machineSession && options.machineSession !== 'child') || options.concurrencyPriority === 'overflow';
}
