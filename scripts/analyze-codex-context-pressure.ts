#!/usr/bin/env tsx
import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiagnosticLog } from './codex-context-pressure/diagnostic-source';
import {
  openDefaultDatabase,
  parseProviderCaptures,
} from './codex-context-pressure/provider-capture-source';
import { buildLimitations, buildReport } from './codex-context-pressure/report';
import { parseRollout } from './codex-context-pressure/rollout-source';
import {
  compareTimelineEvents,
  toJsonLines,
  zeroCounts,
} from './codex-context-pressure/shared';
import {
  DIAGNOSTIC_KINDS,
  PROVIDER_EVENT_KINDS,
  ROLLOUT_ENTRY_TYPES,
  type AnalysisState,
  type CodexContextAnalysisDependencies,
  type CodexContextAnalysisFiles,
  type CodexContextAnalysisOptions,
  type CodexContextAnalysisSummary,
  type SourceSummary,
} from './codex-context-pressure/types';

export type {
  CodexContextAnalysisDependencies,
  CodexContextAnalysisFiles,
  CodexContextAnalysisOptions,
  CodexContextAnalysisSummary,
} from './codex-context-pressure/types';

const DEFAULT_DEPENDENCIES: CodexContextAnalysisDependencies = {
  openDatabase: openDefaultDatabase,
};

export async function analyzeCodexContextPressure(
  options: CodexContextAnalysisOptions,
  dependencies: CodexContextAnalysisDependencies = DEFAULT_DEPENDENCIES,
): Promise<CodexContextAnalysisFiles> {
  validateOptions(options);
  const state = createState(options);
  if (options.logPath) await parseDiagnosticLog(resolve(options.logPath), state);
  if (options.dbPath && options.instanceId) {
    parseProviderCaptures(resolve(options.dbPath), options.instanceId, state, dependencies);
  }
  if (options.rolloutPath) await parseRollout(resolve(options.rolloutPath), state);

  state.timeline.sort(compareTimelineEvents);
  state.summary.counts.timelineEvents = state.timeline.length;
  state.summary.limitations = buildLimitations(state.summary);

  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const files = {
    summaryPath: join(outDir, 'summary.json'),
    timelinePath: join(outDir, 'timeline.jsonl'),
    reportPath: join(outDir, 'report.md'),
  };
  writeFileSync(files.summaryPath, `${JSON.stringify(state.summary, null, 2)}\n`, 'utf8');
  writeFileSync(files.timelinePath, toJsonLines(state.timeline), 'utf8');
  writeFileSync(files.reportPath, buildReport(state.summary, state.timeline), 'utf8');
  return files;
}

function validateOptions(options: CodexContextAnalysisOptions): void {
  if (!options.logPath && !options.dbPath && !options.rolloutPath) {
    throw new Error('At least one evidence source is required');
  }
  if (options.dbPath && !options.instanceId) throw new Error('--instance is required with --db');
  if (options.instanceId && !options.dbPath) throw new Error('--db is required with --instance');
  const outDir = canonicalPath(options.outDir);
  const inputDirectories = [options.logPath, options.dbPath, options.rolloutPath]
    .filter((value): value is string => Boolean(value))
    .map((value) => dirname(canonicalPath(value)));
  if (inputDirectories.some((directory) => pathContains(directory, outDir))) {
    throw new Error('Output directory must not be equal to or nested within an input directory');
  }
}

function canonicalPath(value: string): string {
  let cursor = resolve(value);
  const missingSegments: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(value);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missingSegments);
}

function pathContains(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (relation !== '..'
    && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(relation));
}

function createState(options: CodexContextAnalysisOptions): AnalysisState {
  const source = (provided: boolean): SourceSummary => ({
    provided,
    available: provided,
    acceptedRecords: 0,
    malformedRecords: 0,
  });
  return {
    timeline: [],
    summary: {
      schemaVersion: 1,
      sources: {
        diagnosticLog: source(Boolean(options.logPath)),
        providerCaptures: source(Boolean(options.dbPath)),
        rollout: source(Boolean(options.rolloutPath)),
      },
      counts: {
        timelineEvents: 0,
        diagnosticKinds: zeroCounts(DIAGNOSTIC_KINDS),
        providerEventKinds: zeroCounts(PROVIDER_EVENT_KINDS),
        rolloutEntryTypes: zeroCounts(ROLLOUT_ENTRY_TYPES),
      },
      coverage: {
        rawDiagnosticUsageNotifications: false,
        normalizedContextEvents: false,
        rolloutTokenCountEvents: false,
        itemSizeObservations: false,
        compactionMarkers: false,
        turnBoundaries: false,
      },
      limitations: [],
    },
  };
}

function parseArgs(argv: string[]): CodexContextAnalysisOptions {
  const valueFor = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const outDir = valueFor('--out');
  if (!outDir) {
    throw new Error('Usage: tsx scripts/analyze-codex-context-pressure.ts [--log <app.log>] [--db <ledger.db> --instance <id>] [--rollout <rollout.jsonl>] --out <directory>');
  }
  return {
    logPath: valueFor('--log'),
    dbPath: valueFor('--db'),
    instanceId: valueFor('--instance'),
    rolloutPath: valueFor('--rollout'),
    outDir,
  };
}

async function main(): Promise<void> {
  await analyzeCodexContextPressure(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Context-pressure analysis failed');
    process.exitCode = 1;
  });
}
