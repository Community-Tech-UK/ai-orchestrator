import { readFileSync, writeFileSync } from 'node:fs';
import { EXEMPT_REASONS, RULE_CODES, normalizePath, type Analysis } from './types';

export interface Baseline { rules: Record<string, Record<string, number>>; markers: Record<string, Record<string, number>>; unreadable: Record<string, number> }
export interface BaselineFinding { kind: 'new' | 'stale' | 'unknown-rule' | 'unsorted' | 'zero-entry'; code: string; owner: string; measured: number; recorded: number }
export const emptyBaseline = (): Baseline => ({ rules: {}, markers: {}, unreadable: {} });
const add = (table: Record<string, number>, owner: string): void => { table[normalizePath(owner)] = (table[normalizePath(owner)] ?? 0) + 1; };
export function measure(analysis: Analysis): Baseline {
  const result = emptyBaseline();
  for (const violation of analysis.violations) if ((RULE_CODES as readonly string[]).includes(violation.code)) add(result.rules[violation.code] ??= {}, violation.ownerFile);
  for (const fact of analysis.facts) {
    if (fact.marker) add(result.markers[fact.marker] ??= {}, fact.ownerFile);
    for (const hover of fact.hover) if (hover.unreadable) add(result.unreadable, fact.ownerFile);
  }
  return sortBaseline(result);
}
function sortTable(table: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(table).filter(([, count]) => count > 0).map(([key, count]) => [normalizePath(key), count] as const).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
function sortBaseline(value: Baseline): Baseline {
  const sort = (table: Record<string, Record<string, number>>): Record<string, Record<string, number>> => Object.fromEntries(Object.entries(table).map(([key, count]) => [key, sortTable(count)] as const).filter(([, count]) => Object.keys(count).length).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return { rules: sort(value.rules), markers: sort(value.markers), unreadable: sortTable(value.unreadable) };
}
function buckets(value: Baseline): Record<string, Record<string, number>> { return { ...value.rules, ...Object.fromEntries(Object.entries(value.markers).map(([key, table]) => ['marker:' + key, table])), unreadable: value.unreadable }; }
export function compare(measured: Baseline, baseline: Baseline): BaselineFinding[] {
  const findings: BaselineFinding[] = [];
  const actual = buckets(measured);
  const expected = buckets(baseline);
  const push = (kind: BaselineFinding['kind'], code: string, owner = '', measured = 0, recorded = 0): void => { findings.push({ kind, code, owner, measured, recorded }); };
  for (const [section, table] of Object.entries({ rules: baseline.rules, markers: baseline.markers })) {
    const keys = Object.keys(table);
    if (keys.join('|') !== [...keys].sort((a, b) => a.localeCompare(b, 'en')).join('|')) push('unsorted', section);
    for (const key of keys) if (!(section === 'rules' ? RULE_CODES : EXEMPT_REASONS as readonly string[]).includes(key as never)) push('unknown-rule', key);
  }
  for (const code of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    const table = expected[code] ?? {};
    const normalized: Record<string, number> = {};
    const keys = Object.keys(table);
    if (keys.map(normalizePath).join('|') !== keys.map(normalizePath).sort((a, b) => a.localeCompare(b, 'en')).join('|')) push('unsorted', code);
    for (const [owner, count] of Object.entries(table)) {
      const key = normalizePath(owner);
      if (!Number.isSafeInteger(count) || count <= 0) push('zero-entry', code, key, actual[code]?.[key] ?? 0, count);
      if (key.startsWith('/') || key.includes('../') || !key.startsWith('src/renderer/')) push('unknown-rule', code, key);
      if (normalized[key] !== undefined) push('unknown-rule', code, key);
      normalized[key] = count;
    }
    for (const owner of new Set([...Object.keys(actual[code] ?? {}), ...Object.keys(normalized)])) {
      const current = actual[code]?.[owner] ?? 0;
      const recorded = normalized[owner] ?? 0;
      if (current !== recorded) push(current > recorded ? 'new' : 'stale', code, owner, current, recorded);
    }
  }
  return findings;
}
export function tighten(measured: Baseline, baseline: Baseline): Baseline {
  const findings = compare(measured, baseline).filter(finding => finding.kind !== 'stale' && finding.kind !== 'unsorted' && finding.kind !== 'zero-entry');
  if (findings.length) throw new Error('Cannot tighten: ' + JSON.stringify(findings));
  return sortBaseline(measured);
}
export function initBaseline(measured: Baseline): Baseline { return sortBaseline(measured); }
export function transfer(baseline: Baseline, from: string, to: string, options: { rule?: string; count?: number } = {}): Baseline {
  from = normalizePath(from); to = normalizePath(to);
  if (from === to || !from.startsWith('src/renderer/') || !to.startsWith('src/renderer/')) throw new Error('transfer requires different renderer owner paths');
  const next = structuredClone(baseline);
  const tables = buckets(next);
  const codes = options.rule ? [options.rule] : Object.keys(tables);
  if (options.rule && !(RULE_CODES as readonly string[]).includes(options.rule) && options.rule !== 'unreadable') throw new Error('Unknown transfer rule');
  let moved = 0;
  for (const code of codes) {
    const table = tables[code];
    if (!table || !table[from]) continue;
    const count = options.count ?? table[from]!;
    if (!Number.isSafeInteger(count) || count <= 0 || count > table[from]!) throw new Error('Cannot transfer more debt than recorded');
    table[from] = table[from]! - count; table[to] = (table[to] ?? 0) + count; moved += count;
  }
  if (!moved) throw new Error('No recorded debt to transfer');
  return sortBaseline(next);
}
export function compareBaselines(previous: Baseline, next: Baseline): BaselineFinding[] {
  // Any owner increase fails, even if compensated elsewhere: transfers must be reviewed explicitly.
  return [...compare(next, previous).filter(finding => finding.kind !== 'stale' && !finding.code.startsWith('marker:')), ...compare(next, next).filter(finding => finding.kind !== 'new' && finding.kind !== 'stale')];
}
export function markerChanges(previous: Baseline, next: Baseline): string[] {
  return compare(next, previous).filter(finding => finding.kind === 'new' && finding.code.startsWith('marker:')).map(finding => `Marker review notice: ${finding.owner} ${finding.code.slice(7)} ${finding.recorded} -> ${finding.measured}; verify the reason and marker diff.`);
}
export function serialize(value: Baseline): string {
  const sorted = sortBaseline(value);
  const sections = ['rules', 'markers'].map(section => {
    const table = sorted[section as 'rules' | 'markers'];
    const rows = Object.entries(table).map(([code, owners]) => `    ${JSON.stringify(code)}: {\n${Object.entries(owners).map(([owner, count]) => `      ${JSON.stringify(owner)}: ${count}`).join(',\n')}\n    }`);
    return `  ${JSON.stringify(section)}: {${rows.length ? '\n' + rows.join(',\n') + '\n  ' : ''}}`;
  });
  const unreadable = Object.entries(sorted.unreadable).map(([owner, count]) => `    ${JSON.stringify(owner)}: ${count}`).join(',\n');
  return `{\n${sections.join(',\n')},\n  "unreadable": {${unreadable ? '\n' + unreadable + '\n  ' : ''}}\n}\n`;
}
export function readBaseline(file: string): Baseline {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
  if (!object(value) || Object.keys(value).sort().join(',') !== 'markers,rules,unreadable' || !object(value['rules']) || !object(value['markers']) || !object(value['unreadable'])) throw new Error('H12 malformed baseline shape');
  for (const section of ['rules', 'markers']) for (const table of Object.values(value[section] as Record<string, unknown>)) if (!object(table) || Object.values(table).some(count => typeof count !== 'number')) throw new Error('H12 malformed baseline owner counts');
  if (Object.values(value['unreadable']).some(count => typeof count !== 'number')) throw new Error('H12 malformed unreadable counts');
  return value as unknown as Baseline;
}
export function writeBaseline(file: string, baseline: Baseline): void { writeFileSync(file, serialize(baseline)); }
