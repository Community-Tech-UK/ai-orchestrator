import { runCommand, tail } from './exec';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { scoringEnvironment, verifyScoringDependencies, type DependencyReceipt } from './scoring-setup';
import type { CommandResult, DamageCheckResult, HiddenTestScore, ScoreBundle, TaskDefinition } from './types';

export interface ScoreOptions {
  workspaceDir: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Full local command evidence, alongside the compact score output. */
  logDir?: string;
  /** Trusted setup receipt captured before the coder can edit its workspace. */
  dependencies?: DependencyReceipt;
}

async function scoringCommand(command: string[], options: ScoreOptions, label: string): Promise<CommandResult> {
  const result = await runCommand(command, {
    cwd: options.workspaceDir, env: scoringEnvironment(options.workspaceDir, options.env), timeoutMs: options.timeoutMs ?? 20 * 60_000,
  });
  if (options.logDir) {
    mkdirSync(options.logDir, { recursive: true });
    writeFileSync(join(options.logDir, `${label}.json`), JSON.stringify(result, null, 2));
  }
  const missingCachedTool = result.stderr.includes('npx canceled due to missing packages')
    || /npm (?:error|ERR!) code ENOTCACHED/.test(result.stderr);
  if (!result.timedOut && (result.exitCode === null || result.exitCode === 126 || result.exitCode === 127
    || (result.exitCode !== 0 && missingCachedTool))) {
    throw new Error(`scoring infrastructure failure: ${command.join(' ')} (exit ${result.exitCode}): ${tail(result.stderr)}`);
  }
  return result;
}

function toHiddenTestScore(command: string[], result: CommandResult): HiddenTestScore {
  return {
    passed: result.exitCode === 0 && !result.timedOut,
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTail: tail(`${result.stdout}\n${result.stderr}`),
  };
}

function toDamageResult(command: string[], result: CommandResult): DamageCheckResult {
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTail: tail(`${result.stdout}\n${result.stderr}`),
  };
}

export async function scoreHiddenTests(task: TaskDefinition, options: ScoreOptions): Promise<HiddenTestScore> {
  if (task.hiddenTestAmendment) {
    const amendment = task.hiddenTestAmendment;
    const patch = readFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), amendment.patchFile));
    if (createHash('sha256').update(patch).digest('hex') !== amendment.sha256) {
      throw new Error('hidden-test scoring amendment hash mismatch');
    }
    const apply = await runCommand(['git', 'apply', '--whitespace=error', '-'], {
      cwd: options.workspaceDir, stdin: patch.toString(), timeoutMs: 30_000,
    });
    if (apply.exitCode !== 0 || apply.timedOut) throw new Error(`hidden-test scoring amendment failed: ${tail(apply.stderr)}`);
  }
  const result = await scoringCommand(task.hiddenTestCommand, options, 'hidden-tests');
  return toHiddenTestScore(task.hiddenTestCommand, result);
}

export async function runDamageChecks(task: TaskDefinition, options: ScoreOptions): Promise<DamageCheckResult[]> {
  const results: DamageCheckResult[] = [];
  for (const command of task.damageCommands) {
    const result = await scoringCommand(command, options, `damage-${results.length + 1}`);
    results.push(toDamageResult(command, result));
  }
  return results;
}

export async function scoreRun(task: TaskDefinition, options: ScoreOptions): Promise<ScoreBundle> {
  const dependencies = verifyScoringDependencies(options.workspaceDir, options.dependencies);
  const hiddenTests = await scoreHiddenTests(task, options);
  const damage = await runDamageChecks(task, options);
  return {
    contract: {
      version: task.hiddenTestAmendment?.version ?? 'historical-v1',
      amendmentSha256: task.hiddenTestAmendment?.sha256,
      dependencyFingerprint: dependencies.fingerprint,
    },
    hiddenTests,
    damage,
    damageOk: damage.every((check) => check.ok),
  };
}

export function isSolved(score: ScoreBundle | undefined): boolean {
  return Boolean(score && score.hiddenTests.passed && score.damageOk);
}
