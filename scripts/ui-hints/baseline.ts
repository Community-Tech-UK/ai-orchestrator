import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXEMPT_REASONS, RULE_CODES, normalizePath, type Analysis } from './types';

export interface MarkerRecord { count: number; reason: string }
export interface Baseline { rules: Record<string, Record<string, number>>; markers: Record<string, Record<string, MarkerRecord>>; unreadable: Record<string, number> }
export interface BaselineFinding { kind: 'new' | 'stale' | 'unknown-rule' | 'unsorted' | 'zero-entry'; code: string; owner: string; measured: number; recorded: number }
export const emptyBaseline = (): Baseline => ({ rules: {}, markers: {}, unreadable: {} });

/** Record shard for an owner: the top-level renderer folder (`features`, `shared`, `core`, `app`). */
export function ownerGroup(owner: string): string {
  const parts = normalizePath(owner).split('/').slice(2);
  const first = parts[0] ?? 'app';
  if (first.includes('.')) return 'app';
  if (first !== 'app') return first;
  const second = parts[1];
  return second && !second.includes('.') ? second : 'app';
}

const add = (table: Record<string, number>, owner: string): void => { table[normalizePath(owner)] = (table[normalizePath(owner)] ?? 0) + 1; };
const addMarker = (table: Record<string, MarkerRecord>, owner: string): void => {
  const key = normalizePath(owner);
  table[key] = { count: (table[key]?.count ?? 0) + 1, reason: table[key]?.reason ?? '' };
};
const markerCounts = (table: Record<string, MarkerRecord>): Record<string, number> => Object.fromEntries(Object.entries(table).map(([owner, entry]) => [owner, entry.count]));

export function measure(analysis: Analysis): Baseline {
  const result = emptyBaseline();
  for (const violation of analysis.violations) if ((RULE_CODES as readonly string[]).includes(violation.code)) add(result.rules[violation.code] ??= {}, violation.ownerFile);
  for (const fact of analysis.facts) {
    if (fact.marker) addMarker(result.markers[fact.marker] ??= {}, fact.ownerFile);
    for (const hover of fact.hover) if (hover.unreadable) add(result.unreadable, fact.ownerFile);
  }
  return sortBaseline(result);
}
function sortTable(table: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(table).filter(([, count]) => count > 0).map(([key, count]) => [normalizePath(key), count] as const).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
function sortMarkerTable(table: Record<string, MarkerRecord>): Record<string, MarkerRecord> {
  return Object.fromEntries(Object.entries(table).filter(([, entry]) => entry.count > 0).map(([key, entry]) => [normalizePath(key), entry] as const).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
export function sortBaseline(value: Baseline): Baseline {
  const sort = (table: Record<string, Record<string, number>>): Record<string, Record<string, number>> => Object.fromEntries(Object.entries(table).map(([key, count]) => [key, sortTable(count)] as const).filter(([, count]) => Object.keys(count).length).sort(([a], [b]) => a.localeCompare(b, 'en')));
  const sortMarkers = (table: Record<string, Record<string, MarkerRecord>>): Record<string, Record<string, MarkerRecord>> => Object.fromEntries(Object.entries(table).map(([key, counts]) => [key, sortMarkerTable(counts)] as const).filter(([, counts]) => Object.keys(counts).length).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return { rules: sort(value.rules), markers: sortMarkers(value.markers), unreadable: sortTable(value.unreadable) };
}
function buckets(value: Baseline): Record<string, Record<string, number>> {
  return { ...value.rules, ...Object.fromEntries(Object.entries(value.markers).map(([key, table]) => ['marker:' + key, markerCounts(table)])), unreadable: value.unreadable };
}
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
  return initBaseline(measured, baseline);
}
/**
 * Record the measured counts, carrying each marker's written reason from the
 * previous record. A raised marker gets its reason from `--exempt --reason`.
 */
export function initBaseline(measured: Baseline, previous: Baseline = emptyBaseline()): Baseline {
  const markers: Record<string, Record<string, MarkerRecord>> = {};
  for (const [kind, table] of Object.entries(measured.markers)) {
    markers[kind] = Object.fromEntries(Object.entries(table).map(([owner, entry]) => [owner, { count: entry.count, reason: entry.reason || previous.markers[kind]?.[owner]?.reason || '' }]));
  }
  return sortBaseline({ ...measured, markers });
}
export function transfer(baseline: Baseline, from: string, to: string, options: { rule?: string; count?: number } = {}): Baseline {
  from = normalizePath(from); to = normalizePath(to);
  if (from === to || !from.startsWith('src/renderer/') || !to.startsWith('src/renderer/')) throw new Error('transfer requires different renderer owner paths');
  const next = structuredClone(baseline);
  const tables: Record<string, Record<string, number>> = { ...next.rules, unreadable: next.unreadable };
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
/**
 * A raised marker (count up on an owner) must carry a written reason in its
 * baseline entry; a fresh reason becomes a review notice, a missing or
 * unchanged one is an error.
 */
export function markerReview(previous: Baseline, next: Baseline): { errors: string[]; notices: string[] } {
  const errors: string[] = []; const notices: string[] = [];
  for (const [kind, table] of Object.entries(next.markers)) {
    for (const [owner, entry] of Object.entries(table)) {
      const before = previous.markers[kind]?.[owner];
      if (before && entry.count <= before.count) continue;
      const reason = entry.reason.trim();
      if (reason.length < 20 || (before && reason === before.reason.trim())) {
        errors.push(`raised marker needs a written reason in the baseline entry: ${owner} marker:${kind} ${before?.count ?? 0} -> ${entry.count}`);
      } else {
        notices.push(`Marker review notice: ${owner} ${kind} ${before?.count ?? 0} -> ${entry.count}; verify the reason and marker diff. Reason: ${reason}`);
      }
    }
  }
  return { errors, notices };
}
export function serialize(value: Baseline): string {
  const sorted = sortBaseline(value);
  const rules = Object.entries(sorted.rules).map(([code, owners]) => `    ${JSON.stringify(code)}: {\n${Object.entries(owners).map(([owner, count]) => `      ${JSON.stringify(owner)}: ${count}`).join(',\n')}\n    }`);
  const markers = Object.entries(sorted.markers).map(([code, owners]) => `    ${JSON.stringify(code)}: {\n${Object.entries(owners).map(([owner, entry]) => `      ${JSON.stringify(owner)}: { "count": ${entry.count}, "reason": ${JSON.stringify(entry.reason)} }`).join(',\n')}\n    }`);
  const unreadable = Object.entries(sorted.unreadable).map(([owner, count]) => `    ${JSON.stringify(owner)}: ${count}`).join(',\n');
  return `{\n  "rules": {${rules.length ? '\n' + rules.join(',\n') + '\n  ' : ''}},\n  "markers": {${markers.length ? '\n' + markers.join(',\n') + '\n  ' : ''}},\n  "unreadable": {${unreadable ? '\n' + unreadable + '\n  ' : ''}}\n}\n`;
}
function parseRecord(value: unknown, group?: string): Baseline {
  const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
  if (!object(value) || Object.keys(value).sort().join(',') !== 'markers,rules,unreadable' || !object(value['rules']) || !object(value['markers']) || !object(value['unreadable'])) throw new Error('H12 malformed baseline shape');
  for (const table of Object.values(value['rules'] as Record<string, unknown>)) if (!object(table) || Object.values(table).some(count => typeof count !== 'number')) throw new Error('H12 malformed baseline owner counts');
  for (const table of Object.values(value['markers'] as Record<string, unknown>)) {
    if (!object(table)) throw new Error('H12 malformed baseline owner counts');
    for (const entry of Object.values(table)) {
      if (!object(entry) || typeof entry['count'] !== 'number' || typeof entry['reason'] !== 'string') throw new Error('H12 malformed baseline marker entry');
    }
  }
  if (Object.values(value['unreadable']).some(count => typeof count !== 'number')) throw new Error('H12 malformed unreadable counts');
  const baseline = value as unknown as Baseline;
  if (group !== undefined) {
    for (const owner of [...Object.values(baseline.rules).flatMap(Object.keys), ...Object.values(baseline.markers).flatMap(Object.keys), ...Object.keys(baseline.unreadable)]) {
      if (ownerGroup(owner) !== group) throw new Error('H12 malformed baseline shape: ' + owner + ' does not belong in ' + group);
    }
  }
  return baseline;
}
export function mergeBaselines(target: Baseline, source: Baseline): Baseline {
  for (const [code, owners] of Object.entries(source.rules)) for (const [owner, count] of Object.entries(owners)) (target.rules[code] ??= {})[owner] = count;
  for (const [owner, count] of Object.entries(source.unreadable)) target.unreadable[owner] = count;
  for (const [kind, owners] of Object.entries(source.markers)) for (const [owner, entry] of Object.entries(owners)) (target.markers[kind] ??= {})[owner] = entry;
  return target;
}
export function parseRecordText(text: string, group?: string): Baseline {
  return parseRecord(JSON.parse(text), group);
}
export function readBaseline(dir: string): Baseline {
  const files = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')).sort() : [];
  const merged = emptyBaseline();
  for (const name of files) mergeBaselines(merged, parseRecord(JSON.parse(readFileSync(join(dir, name), 'utf8')), name.slice(0, -'.json'.length)));
  return sortBaseline(merged);
}
export function writeBaseline(dir: string, baseline: Baseline): void {
  const shards = new Map<string, Baseline>();
  const shard = (owner: string): Baseline => {
    const group = ownerGroup(owner);
    const existing = shards.get(group) ?? emptyBaseline();
    shards.set(group, existing);
    return existing;
  };
  for (const [code, owners] of Object.entries(baseline.rules)) for (const [owner, count] of Object.entries(owners)) (shard(owner).rules[code] ??= {})[owner] = count;
  for (const [kind, owners] of Object.entries(baseline.markers)) for (const [owner, entry] of Object.entries(owners)) (shard(owner).markers[kind] ??= {})[owner] = entry;
  for (const [owner, count] of Object.entries(baseline.unreadable)) shard(owner).unreadable[owner] = count;
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir).filter(file => file.endsWith('.json'))) if (!shards.has(name.slice(0, -'.json'.length))) rmSync(join(dir, name));
  for (const [group, value] of shards) writeFileSync(join(dir, group + '.json'), serialize(value));
}
