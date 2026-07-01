import type { LoopTerminalIntentEvidence, LoopTerminalIntentKind } from '../../shared/types/loop.types';
import {
  clampLoopWakeupResumeAt,
  readLoopControlFileFromEnv,
  writeIntentFromCli,
} from './loop-control';

export interface LoopControlCliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export async function runLoopControlCli(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  io: LoopControlCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const args = parseArgs(argv.slice(2));
    if (args.help) {
      io.stdout.write(helpText());
      return 0;
    }
    const control = await readLoopControlFileFromEnv(env);
    const filePath = await writeIntentFromCli(control, args.kind, args.summary, args.evidence, env, args.resumeAt);
    io.stdout.write(`Loop ${args.kind} intent recorded for ${control.loopRunId} iteration ${control.currentIterationSeq}: ${filePath}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`aio-loop-control: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

interface ParsedArgs {
  kind: LoopTerminalIntentKind;
  summary: string;
  evidence: LoopTerminalIntentEvidence[];
  resumeAt?: number;
  help: boolean;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const first = args[0];
  if (!first || first === '--help' || first === '-h') {
    return { kind: 'complete', summary: '', evidence: [], help: true };
  }
  if (first !== 'complete' && first !== 'block' && first !== 'fail' && first !== 'wakeup') {
    throw new Error('First argument must be complete, block, fail, or wakeup');
  }

  let summary = '';
  const evidence: LoopTerminalIntentEvidence[] = [];
  let resumeAt: number | undefined;
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === '--summary') {
      const value = rest[index + 1];
      if (!value) throw new Error('--summary requires a value');
      summary = value;
      index += 1;
      continue;
    }
    if (arg === '--evidence') {
      const value = rest[index + 1];
      if (!value) throw new Error('--evidence requires a value');
      evidence.push(parseEvidenceArg(value));
      index += 1;
      continue;
    }
    if (arg === '--note') {
      const value = rest[index + 1];
      if (!value) throw new Error('--note requires a value');
      evidence.push({ kind: 'note', label: 'note', value });
      index += 1;
      continue;
    }
    if (arg === '--resume-in') {
      const value = rest[index + 1];
      if (!value) throw new Error('--resume-in requires a value');
      resumeAt = resumeAtFromDelaySeconds(value);
      index += 1;
      continue;
    }
    if (arg === '--resume-at') {
      const value = rest[index + 1];
      if (!value) throw new Error('--resume-at requires a value');
      resumeAt = resumeAtFromEpochMs(value);
      index += 1;
      continue;
    }
    if (!arg.startsWith('-') && !summary) {
      summary = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!summary.trim()) {
    throw new Error('--summary is required');
  }
  if (first === 'wakeup' && resumeAt === undefined) {
    throw new Error('wakeup requires --resume-in <seconds> or --resume-at <epoch-ms>');
  }
  if (first !== 'wakeup' && resumeAt !== undefined) {
    throw new Error('--resume-in/--resume-at are only valid for wakeup');
  }

  return { kind: first, summary: summary.trim(), evidence, resumeAt, help: false };
}

function resumeAtFromDelaySeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('--resume-in must be a positive number of seconds');
  }
  const now = Date.now();
  return clampLoopWakeupResumeAt(now, now + Math.round(seconds * 1000));
}

function resumeAtFromEpochMs(value: string): number {
  const epochMs = Number(value);
  if (!Number.isInteger(epochMs) || epochMs <= 0) {
    throw new Error('--resume-at must be a positive epoch-ms timestamp');
  }
  return clampLoopWakeupResumeAt(Date.now(), epochMs);
}

function parseEvidenceArg(value: string): LoopTerminalIntentEvidence {
  const match = /^(summary|command|file|test|note):([^=]{1,256})=(.+)$/s.exec(value);
  if (!match) {
    throw new Error('--evidence must use kind:label=value');
  }
  return {
    kind: match[1] as LoopTerminalIntentEvidence['kind'],
    label: match[2]!.trim(),
    value: match[3]!.trim(),
  };
}

function helpText(): string {
  return [
    'Usage:',
    '  aio-loop-control complete --summary "<what is complete>" [--evidence kind:label=value]',
    '  aio-loop-control block --summary "<exact blocker>"',
    '  aio-loop-control wakeup --summary "<why to resume>" --resume-in "<seconds>"',
    '  aio-loop-control fail --summary "<failure reason>"',
    '',
  ].join('\n');
}

if (require.main === module) {
  void runLoopControlCli().then((code) => {
    process.exitCode = code;
  });
}
