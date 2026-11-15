/**
 * Offline test tooling for the session watcher (docs/plans/2026-11-14-session-watcher_plan_completed.md, Step 1).
 * Run: npm run bench:session-watcher -- <subcommand> [flags]   (see usage() below)
 * Nothing here sends anything to a session. Private conversation text stays in _scratch; output files hold ids and counts.
 */
import { resolve } from 'node:path';
import { createBackend } from './judge-backends';
import { numberFlag, parseArgs, readJsonl, requireFlag, writeJsonl, type ParsedArgs } from './jsonl';
import { stopsFromArchive, stopsFromTranscripts } from './load-messages';
import { runLabelling } from './labelling';
import { mergeLabels } from './merge-labels';
import { runJudge } from './run-judge';
import { buildScoreReport } from './score';
import type { FinalLabelRow, LabelRow, ResultRow, StopRef } from './types';
import { writeAsks } from './written-asks';

function usage(): string {
  return [
    'subcommands:',
    '  stops-from-archive --dir <folder of .json.gz> --out <stops.jsonl>',
    '  stops-from-transcripts --root <~/.claude/projects> --since 2026-10-15 --before 2026-11-08 --out <stops.jsonl>',
    '  label --stops <f> --labeller <name> --backend <claude-cli|codex-cli|openai-compatible|openai-via-command> --model <m> [--base-url <u>] [--command <c>] --out <f> [--limit n] [--concurrency n]',
    '  merge-labels --a <f> --b <f> --out <labels-final.jsonl> --disputes <f>',
    '  run --stops <f> --backend ... --model <m> [--base-url <u>] [--command <c>] --out <results.jsonl> [--level own-suggestions|clear-choices|planned-work] [--limit n] [--concurrency n]',
    '  score --results <f> --labels <labels-final.jsonl> --stops <f> [--written <written-results.jsonl>]',
    '  written-asks --backend ... --model <m> --count 150 --out <written.jsonl> [--concurrency n]',
  ].join('\n');
}

function summarise(stops: readonly StopRef[]): void {
  const byProvider: Record<string, number> = {};
  for (const s of stops) byProvider[s.provider] = (byProvider[s.provider] ?? 0) + 1;
  console.log(JSON.stringify({
    stops: stops.length, final: stops.filter((s) => s.final).length, bareGoAhead: stops.filter((s) => s.next.bareGoAhead).length,
    followedByPerson: stops.filter((s) => s.next.kind === 'person').length, byProvider,
  }));
}

function dayStart(text: string): number {
  const ms = new Date(`${text}T00:00:00`).getTime();
  if (!Number.isFinite(ms)) throw new Error(`bad date: ${text}`);
  return ms;
}

async function main(argv: string[]): Promise<void> {
  const args: ParsedArgs = parseArgs(argv);
  const [command] = args.positional;
  const concurrencyFor = (defaultValue: number): number => numberFlag(args, 'concurrency', defaultValue);
  switch (command) {
    case 'stops-from-archive': {
      const { stops, counts } = stopsFromArchive(resolve(requireFlag(args, 'dir')));
      writeJsonl(requireFlag(args, 'out'), stops);
      console.log(JSON.stringify(counts));
      summarise(stops);
      return;
    }
    case 'stops-from-transcripts': {
      const { stops, counts } = stopsFromTranscripts(resolve(requireFlag(args, 'root')), dayStart(requireFlag(args, 'since')), dayStart(requireFlag(args, 'before')));
      writeJsonl(requireFlag(args, 'out'), stops);
      console.log(JSON.stringify(counts));
      summarise(stops);
      return;
    }
    case 'label': {
      const backend = createBackend(args);
      const stops = readJsonl<StopRef>(requireFlag(args, 'stops'));
      const result = await runLabelling({
        stops, labeller: requireFlag(args, 'labeller'), backend, out: requireFlag(args, 'out'),
        limit: numberFlag(args, 'limit', 0), concurrency: concurrencyFor(backend.defaultConcurrency),
      });
      console.log(JSON.stringify(result));
      return;
    }
    case 'merge-labels': {
      const result = mergeLabels(readJsonl<LabelRow>(requireFlag(args, 'a')), readJsonl<LabelRow>(requireFlag(args, 'b')));
      writeJsonl(requireFlag(args, 'out'), result.final);
      writeJsonl(requireFlag(args, 'disputes'), result.disputes);
      const byRule: Record<string, number> = {};
      for (const row of result.final) byRule[row.decidedBy] = (byRule[row.decidedBy] ?? 0) + 1;
      console.log(JSON.stringify({ final: result.final.length, byRule, disputed: result.disputes.length, unpaired: result.unpaired }));
      return;
    }
    case 'run': {
      const backend = createBackend(args);
      const level = args.flags.get('level') ?? 'own-suggestions';
      if (level !== 'own-suggestions' && level !== 'clear-choices' && level !== 'planned-work') throw new Error('--level must be own-suggestions, clear-choices or planned-work');
      const result = await runJudge({
        stops: readJsonl<StopRef>(requireFlag(args, 'stops')), backend, level, out: requireFlag(args, 'out'),
        limit: numberFlag(args, 'limit', 0), concurrency: concurrencyFor(backend.defaultConcurrency),
      });
      console.log(JSON.stringify(result));
      return;
    }
    case 'score': {
      const stops = readJsonl<StopRef>(requireFlag(args, 'stops'));
      const results = readJsonl<ResultRow>(requireFlag(args, 'results'));
      const labels = readJsonl<FinalLabelRow>(requireFlag(args, 'labels'));
      let writtenStops: StopRef[] = [];
      let all = results;
      const writtenPath = args.flags.get('written');
      if (writtenPath) {
        const writtenResults = readJsonl<ResultRow>(writtenPath);
        writtenStops = writtenResults.map((r) => ({
          id: r.id, source: 'written', file: '', stopIndex: 0, provider: 'written', stoppedAt: 0, final: false,
          next: { kind: 'none', chars: 0, bareGoAhead: false, gapMs: null }, outward: true,
        }));
        all = [...results, ...writtenResults];
      }
      console.log(buildScoreReport(stops, labels, all, writtenStops));
      return;
    }
    case 'written-asks': {
      const backend = createBackend(args);
      const result = await writeAsks({ backend, count: numberFlag(args, 'count', 150), out: requireFlag(args, 'out'), concurrency: concurrencyFor(backend.defaultConcurrency) });
      console.log(JSON.stringify(result));
      return;
    }
    default:
      console.error(usage());
      process.exitCode = command ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
