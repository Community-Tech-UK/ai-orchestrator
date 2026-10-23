import type { Baseline } from './baseline.js';
interface ConfigBlock { rules?: Record<string, unknown> }
export function checkLink(config: ConfigBlock[], baseline: Baseline): string[] {
  const rules = Object.assign({}, ...config.map(block => block.rules ?? {})) as Record<string, unknown>;
  const total = (code: string): number => Object.values(baseline.rules[code] ?? {}).reduce((sum, count) => sum + count, 0);
  const errors: string[] = [];
  const check = (name: string, enabled: boolean): void => {
    const value = rules['ui-hints/' + name];
    if (value === undefined) { errors.push('Missing ui-hints/' + name); return; }
    const severity = Array.isArray(value) ? value[0] : value;
    if (enabled ? severity !== 'error' && severity !== 2 : severity !== 'off' && severity !== 0) errors.push(`ui-hints/${name}: ${enabled ? 'switch it on' : 'it would redden CI; switch it off'}`);
  };
  check('no-hardcoded-shortcut', total('H5') === 0);
  check('icon-control-needs-name-and-tooltip', total('H1a') + total('H1b') === 0);
  check('no-native-title', total('H2a') === 0);
  const title = rules['ui-hints/no-native-title'];
  const option = Array.isArray(title) ? title[1] as { scope?: string } | undefined : undefined;
  const all = total('H2a') + total('H2b') + total('H2c') === 0;
  if (option?.scope !== (all ? 'all' : 'controls')) errors.push('ui-hints/no-native-title: scope must be ' + (all ? 'all' : 'controls'));
  return errors;
}
