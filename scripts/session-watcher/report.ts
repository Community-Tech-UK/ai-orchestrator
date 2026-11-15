/**
 * Reads the session watcher's decision log and prints how it has been doing: what it decided, how often each
 * decision turned out wrong in either direction, and how long the judge takes. Counts only; the log holds no
 * conversation text. Run: npm run audit:session-watcher -- [--since 2026-11-15] [--dir <log folder>]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WatcherFollowUpRecord, WatcherStopRecord } from '../../src/main/session-watcher/watcher-decision-log';
import { parseArgs } from './jsonl';

type Row = (WatcherStopRecord | WatcherFollowUpRecord) & { at: string };

export function readLog(directory: string, sinceMs: number): Row[] {
  if (!existsSync(directory)) return [];
  const rows: Row[] = [];
  for (const file of readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()) {
    if (Date.parse(`${file.slice(0, 10)}T00:00:00Z`) + 86_400_000 <= sinceMs) continue;
    for (const line of readFileSync(join(directory, file), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Row;
        if (Date.parse(row.at) >= sinceMs) rows.push(row);
      } catch { /* a partly written line is skipped */ }
    }
  }
  return rows;
}

const tally = <T>(items: readonly T[], key: (item: T) => string | undefined): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) { const k = key(item) ?? '(none)'; out[k] = (out[k] ?? 0) + 1; }
  return out;
};
const share = (n: number, d: number): string => (d ? `${n} of ${d} (${Math.round((100 * n) / d)}%)` : `${n} of 0`);
const table = (counts: Record<string, number>): string[] =>
  Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => `  ${String(count).padStart(5)}  ${name}`);

export function buildReport(rows: readonly Row[]): string {
  const stops = rows.filter((row): row is WatcherStopRecord & { at: string } => row.event === 'stop');
  const followUps = new Map<string, WatcherFollowUpRecord[]>();
  for (const row of rows) {
    if (row.event !== 'follow-up') continue;
    const key = `${row.session}:${row.requestCount}`;
    followUps.set(key, [...(followUps.get(key) ?? []), row]);
  }
  const after = (stop: WatcherStopRecord): WatcherFollowUpRecord[] => followUps.get(`${stop.session}:${stop.requestCount}`) ?? [];
  const judged = stops.filter((stop) => stop.judge);
  const days = new Set(stops.map((stop) => stop.at.slice(0, 10))).size || 1;
  const latencies = judged.map((stop) => stop.judge!.latencyMs).sort((a, b) => a - b);
  const carried = stops.filter((stop) => stop.outcome === 'sent');
  const flagged = stops.filter((stop) => stop.outcome === 'needs_you');
  const calledFinished = stops.filter((stop) => stop.action === 'finished');
  const replied = (list: readonly WatcherStopRecord[]): WatcherFollowUpRecord[] =>
    list.flatMap(after).filter((row) => row.kind === 'person-message');
  const goAheads = (list: readonly WatcherStopRecord[]): string => {
    const answers = replied(list);
    return share(answers.filter((row) => row.bareGoAhead).length, answers.length);
  };
  const carriedTurns = carried.flatMap(after).filter((row) => row.kind === 'carried-turn');

  return [
    `Stops seen: ${stops.length} over ${days} day(s). Judged: ${judged.length} (${Math.round(judged.length / days)} a day).`,
    `Judge time: median ${latencies[Math.floor(latencies.length / 2)] ?? 'n/a'} ms, slowest tenth from ${latencies[Math.floor(latencies.length * 0.9)] ?? 'n/a'} ms.`,
    '', 'What became of each stop:', ...table(tally(stops, (stop) => stop.outcome)),
    '', 'Why a stop was not judged:', ...table(tally(stops.filter((stop) => stop.skipped), (stop) => stop.skipped)),
    '', 'No usable answer from the judge:', ...table(tally(stops.filter((stop) => stop.unreliable), (stop) => stop.unreliable)),
    '', 'Decisions on judged stops:', ...table(tally(judged.filter((stop) => stop.action), (stop) => `${stop.action}${stop.basis && stop.basis !== 'none' ? ` (${stop.basis})` : ''}`)),
    '', 'Code checks that overrode the judge:', ...table(tally(judged.filter((stop) => stop.override), (stop) => stop.override)),
    '', 'Carried on by itself:',
    `  ${carried.length} stops. Stop pressed during the turn it started: ${share(carried.flatMap(after).filter((row) => row.kind === 'stop-pressed').length, carried.length)}.`,
    `  Turns it started that ran an outward-looking command (commit, push, deploy, delete, send): ${share(carriedTurns.filter((row) => (row.outwardCommands ?? 0) > 0).length, carriedTurns.length)}. Each one is worth a look.`,
    '', 'Flagged as needing you:',
    `  ${flagged.length} stops. Answered with one click: ${flagged.flatMap(after).filter((row) => row.kind === 'yes-clicked').length}.`,
    `  Typed replies that were only a go-ahead (it could perhaps have carried on): ${goAheads(flagged)}.`,
    '', 'Called finished:',
    `  ${calledFinished.length} stops. Typed replies that were only a go-ahead (it missed that the session was waiting): ${goAheads(calledFinished)}.`,
    '', `Sessions switched off for the watcher: ${rows.filter((row) => row.event === 'follow-up' && row.kind === 'muted').length}.`,
  ].join('\n');
}

function defaultDirectory(): string {
  return process.env['AIO_SESSION_WATCHER_DIR']?.trim() || join(homedir(), 'Library', 'Application Support', 'harness', 'session-watcher');
}

if (process.argv[1]?.endsWith('report.ts')) {
  const args = parseArgs(process.argv.slice(2));
  const since = args.flags.get('since');
  const sinceMs = since ? Date.parse(`${since}T00:00:00`) : 0;
  if (!Number.isFinite(sinceMs)) { console.error(`bad date: ${since}`); process.exitCode = 2; } else {
    const directory = args.flags.get('dir') ?? defaultDirectory();
    const rows = readLog(directory, sinceMs);
    console.log(rows.length ? buildReport(rows) : `No session watcher log lines in ${directory}${since ? ` since ${since}` : ''}.`);
  }
}
