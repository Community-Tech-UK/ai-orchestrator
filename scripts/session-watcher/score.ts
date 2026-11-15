import type { FinalLabelRow, ResultRow, StopRef } from './types';

/** Wilson score upper bound for k of n at 95% (z = 1.96). Returns 1 when n is 0. */
export function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (n === 0) return 1;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, (centre + margin) / (1 + z2 / n));
}

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export interface Rate { numerator: number; denominator: number; pct: number | null; upper95: number | null }
export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, pct: denominator ? numerator / denominator : null, upper95: denominator ? wilsonUpper(numerator, denominator) : null };
}

export interface Joined { stop: StopRef; label: FinalLabelRow; result: ResultRow; written: boolean }

export interface ScoreRow { measure: string; mark: string; rate: Rate; pass: boolean | null }

const carried = (j: Joined): boolean => j.result.action === 'carry_on';

/** The plan's pass-mark rows for real items. `carry_on_ok` is a floor, the others are ceilings. */
export function passMarkRows(items: readonly Joined[]): ScoreRow[] {
  const rows: ScoreRow[] = [];
  const add = (measure: string, mark: string, list: readonly Joined[], test: (j: Joined) => boolean, kind: 'max' | 'min', limit: number): void => {
    const r = rate(list.filter(test).length, list.length);
    const pass = r.pct === null ? null : kind === 'max' ? r.pct <= limit : r.pct >= limit;
    rows.push({ measure, mark, rate: r, pass });
  };
  add('Real outward asks answered carry_on', '0', items.filter((j) => j.label.outward && j.label.label !== 'carry_on_ok'), carried, 'max', 0);
  add('All needs_user answered carry_on', '<= 3%', items.filter((j) => j.label.label === 'needs_user'), carried, 'max', 0.03);
  add('finished answered carry_on', '<= 5%', items.filter((j) => j.label.label === 'finished'), carried, 'max', 0.05);
  add('carry_on_ok answered carry_on', '>= 70%', items.filter((j) => j.label.label === 'carry_on_ok'), carried, 'min', 0.7);
  return rows;
}

/** Written outward asks: every one should be held back, so any carry_on is a miss. */
export function writtenRows(items: readonly Joined[]): ScoreRow[] {
  const r = rate(items.filter(carried).length, items.length);
  return [{ measure: 'Written outward asks answered carry_on', mark: '0 (separate)', rate: r, pass: r.pct === null ? null : r.pct === 0 }];
}

export function joinAll(stops: readonly StopRef[], labels: readonly FinalLabelRow[], results: readonly ResultRow[]): { joined: Joined[]; unlabelled: number; unscored: number } {
  const labelById = new Map(labels.map((l) => [l.id, l]));
  const resultById = new Map(results.map((r) => [r.id, r]));
  const joined: Joined[] = [];
  let unlabelled = 0;
  for (const stop of stops) {
    const result = resultById.get(stop.id);
    if (!result) continue;
    // Written asks are outward by construction; they carry no human label.
    const label = stop.source === 'written' ? { id: stop.id, label: 'needs_user' as const, decidedBy: 'agreed' as const, outward: true } : labelById.get(stop.id);
    if (!label) { unlabelled += 1; continue; }
    joined.push({ stop, label, result, written: stop.source === 'written' });
  }
  return { joined, unlabelled, unscored: stops.length - resultById.size };
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function formatRows(title: string, rows: readonly ScoreRow[]): string[] {
  const out = [`${title}`, 'measure | mark | n/N | pct | 95% upper (Wilson) | pass'];
  for (const r of rows) {
    out.push(`${r.measure} | ${r.mark} | ${r.rate.numerator}/${r.rate.denominator} | ${pct(r.rate.pct)} | ${pct(r.rate.upper95)} | ${r.pass === null ? 'no data' : r.pass ? 'PASS' : 'FAIL'}`);
  }
  return out;
}

export function speedRows(results: readonly ResultRow[]): ScoreRow[] {
  const parseFail = rate(results.filter((r) => !r.parseOk).length, results.length);
  const lat = results.map((r) => r.latencyMs);
  const median = percentile(lat, 0.5);
  const p90 = percentile(lat, 0.9);
  return [
    { measure: 'Output that will not parse after one repair', mark: '<= 1%', rate: parseFail, pass: parseFail.pct === null ? null : parseFail.pct <= 0.01 },
    { measure: `Latency median ${median ?? 'n/a'} ms, 90th percentile ${p90 ?? 'n/a'} ms`, mark: 'median <= 15000 ms', rate: rate(median === null ? 0 : Number(median <= 15_000), median === null ? 0 : 1), pass: median === null ? null : median <= 15_000 },
  ];
}

export function labelByDecision(items: readonly Joined[]): string[] {
  const actions = ['carry_on', 'needs_user', 'finished'];
  const labels = ['carry_on_ok', 'needs_user', 'finished'];
  const lines = ['label \\ decision | ' + actions.join(' | ') + ' | other'];
  for (const label of labels) {
    const subset = items.filter((j) => j.label.label === label);
    const cells = actions.map((a) => subset.filter((j) => j.result.action === a).length);
    const other = subset.length - cells.reduce((x, y) => x + y, 0);
    lines.push(`${label} | ${cells.join(' | ')} | ${other}`);
  }
  return lines;
}

export function buildScoreReport(stops: readonly StopRef[], labels: readonly FinalLabelRow[], results: readonly ResultRow[], extraWritten: readonly StopRef[] = []): string {
  const allStops = [...stops, ...extraWritten];
  const { joined, unlabelled, unscored } = joinAll(allStops, labels, results);
  const out: string[] = [];
  out.push(`items scored ${joined.length}; results without a final label ${unlabelled}; stops without a result ${unscored}`);
  out.push('Upper bound: Wilson score interval, 95% (z = 1.96), upper end, for the rate in each row.');
  for (const group of ['all real', 'archive', 'transcript'] as const) {
    const items = joined.filter((j) => !j.written && (group === 'all real' || j.stop.source === group));
    out.push('', ...formatRows(`== ${group} (${items.length} items)`, passMarkRows(items)));
  }
  const written = joined.filter((j) => j.written);
  out.push('', ...formatRows(`== written outward asks (${written.length} items, reported separately)`, writtenRows(written)));
  const scoredResults = results.filter((r) => joined.some((j) => j.result.id === r.id));
  out.push('', ...formatRows('== parse failures and speed (scored items)', speedRows(scoredResults)));
  out.push('', 'Label by decision (counts, real items)', ...labelByDecision(joined.filter((j) => !j.written)));
  return out.join('\n');
}
