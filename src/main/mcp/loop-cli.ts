/**
 * `aio-mcp loop` — inspect and restart parked loops from an agent shell.
 *
 * This is deliberately separate from `aio-loop-control`. That binary is the
 * control channel *inside* a running loop iteration: it needs the per-iteration
 * `AIO_LOOP_CONTROL_FILE` in its environment and only records complete / block /
 * wakeup / fail intents for the loop it is running in. Nothing there can restart
 * a loop that has already parked, which left the renderer as the only surface
 * able to resume one. This subcommand closes that gap by routing to the same
 * coordinator path the renderer's Resume button uses.
 */

import {
  LOOP_CLI_DEFAULT_LIST_LIMIT,
  LOOP_CLI_MAX_LIST_LIMIT,
  LOOP_CLI_METHODS,
  LoopCliListResultSchema,
  LoopCliResumeResultSchema,
  type LoopCliListResult,
  type LoopCliResumeResult,
  type LoopCliRun,
} from './loop-cli-contracts';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import { isParkedLoopRuntimeState } from '../orchestration/loop-runtime-status';

export interface LoopCliDeps {
  client?: OrchestratorToolsRpcClientLike;
  stdout?: (text: string) => void;
}

const LOOP_CLI_RPC_TIMEOUT_MS = 30_000;

export async function runLoopCli(
  argv: readonly string[],
  deps: LoopCliDeps = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    stdout(formatLoopHelp());
    return;
  }

  switch (command) {
    case 'list': {
      const parsed = parseListArgs(argv.slice(1));
      const client = clientFor(deps);
      const result = parseResult(
        LoopCliListResultSchema,
        await client.call(LOOP_CLI_METHODS.list, { all: parsed.all, limit: parsed.limit }),
        'loop list',
      );
      stdout(parsed.json ? formatJson(result) : formatList(result, parsed.all));
      return;
    }
    case 'resume': {
      const parsed = parseResumeArgs(argv.slice(1));
      const client = clientFor(deps);
      const result = parseResult(
        LoopCliResumeResultSchema,
        await client.call(LOOP_CLI_METHODS.resume, { loopRunId: parsed.loopRunId }),
        'loop resume',
      );
      stdout(parsed.json ? formatJson(result) : formatResume(result));
      return;
    }
    default:
      throw new Error(`Unknown loop command: ${command}`);
  }
}

function clientFor(deps: LoopCliDeps): OrchestratorToolsRpcClientLike {
  return deps.client ?? new OrchestratorToolsRpcClient({ timeoutMs: LOOP_CLI_RPC_TIMEOUT_MS });
}

interface ParsedListArgs {
  json: boolean;
  all: boolean;
  limit: number;
}

function parseListArgs(argv: readonly string[]): ParsedListArgs {
  let json = false;
  let all = false;
  let limit = LOOP_CLI_DEFAULT_LIST_LIMIT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--limit') {
      limit = parseLimit(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = parseLimit(arg.slice('--limit='.length));
      continue;
    }
    throw new Error(`Unknown loop list option: ${arg}`);
  }
  return { json, all, limit };
}

function parseLimit(value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > LOOP_CLI_MAX_LIST_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${LOOP_CLI_MAX_LIST_LIMIT}`);
  }
  return parsed;
}

function parseResumeArgs(argv: readonly string[]): { json: boolean; loopRunId: string } {
  let json = false;
  let loopRunId: string | undefined;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown loop resume option: ${arg}`);
    } else if (loopRunId === undefined) {
      loopRunId = arg;
    } else {
      throw new Error(`Unexpected loop resume argument: ${arg}`);
    }
  }
  if (!loopRunId) {
    throw new Error('loop resume requires <loop-run-id> — run `aio-mcp loop list` to find it');
  }
  return { json, loopRunId };
}

function parseResult<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Parent returned an invalid ${label} result`);
  }
  return parsed.data;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatList(result: LoopCliListResult, all: boolean): string {
  if (result.count === 0) {
    return all
      ? 'No loop runs recorded.\n'
      : 'No resumable loops. Add --all to list every recorded run.\n';
  }
  const heading = all
    ? `Loop runs: ${result.count}`
    : `Resumable loops: ${result.count}`;
  return `${[heading, '', ...result.runs.map(formatRun)].join('\n')}\n`;
}

function formatRun(run: LoopCliRun): string {
  const lines = [
    `${run.loopRunId} | ${formatStatus(run)} | started ${formatTimestamp(run.startedAt)} `
      + `| ${run.totalIterations} iteration(s)`,
  ];
  if (run.workspaceCwd) lines.push(`  workspace: ${run.workspaceCwd}`);
  if (run.goal) lines.push(`  goal: ${run.goal}`);
  if (run.endReason) lines.push(`  why: ${run.endReason}`);
  lines.push(run.resumable
    ? `  resume: aio-mcp loop resume ${run.loopRunId}`
    : `  not resumable: ${notResumableHint(run)}`);
  lines.push('');
  return lines.join('\n');
}

function formatStatus(run: LoopCliRun): string {
  const suffixes: string[] = [];
  if (run.status === 'provider-limit' && run.endedAt == null) suffixes.push('parked');
  if (run.live) suffixes.push('live');
  return suffixes.length > 0 ? `${run.status} (${suffixes.join(', ')})` : run.status;
}

function notResumableHint(run: LoopCliRun): string {
  if (run.status === 'running') return 'already running';
  if (!isParkedLoopRuntimeState(run)) return `${run.status} is a terminal state`;
  return 'no stored checkpoint to restore from';
}

function formatResume(result: LoopCliResumeResult): string {
  const restored = result.restoredFromCheckpoint
    ? ' (re-hydrated from its stored checkpoint)'
    : '';
  return `Resumed ${result.loopRunId}${restored}: `
    + `${result.previousStatus} -> ${result.status}\n`;
}

function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function formatLoopHelp(): string {
  return [
    'Usage:',
    '  aio-mcp loop list [--all] [--limit <n>] [--json]',
    '  aio-mcp loop resume <loop-run-id> [--json]',
    '',
    'list   Resumable loops by default: paused loops, and provider-limit loops',
    '       parked with no end time. --all lists every recorded run.',
    'resume Restart a parked loop, re-hydrating it from its stored checkpoint',
    '       when the app has been restarted since it parked. Resuming spends',
    '       provider tokens — it starts the next iteration immediately.',
    '',
    'To end the loop you are running inside, use aio-loop-control instead.',
    '',
  ].join('\n');
}
