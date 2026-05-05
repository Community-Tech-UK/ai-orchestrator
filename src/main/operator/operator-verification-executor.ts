import { execFile, type ExecFileException } from 'node:child_process';
import type {
  OperatorProjectRecord,
  OperatorRunNodeRecord,
  OperatorRunRecord,
  OperatorShellCommandEventPayload,
  OperatorVerificationCheckResult,
  OperatorVerificationResultEventPayload,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';
import { getOperatorDatabase } from './operator-database';
import { OperatorRunStore } from './operator-run-store';
import {
  planProjectVerification,
  type OperatorVerificationCheck,
  type OperatorVerificationPlan,
} from './operator-verification-planner';

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_MAX_EXCERPT_CHARS = 8 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export interface OperatorVerificationCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

export interface OperatorVerificationCommandRunner {
  run(
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; maxBufferBytes: number },
  ): Promise<OperatorVerificationCommandResult>;
}

export interface OperatorVerificationExecutorConfig {
  runStore?: OperatorRunStore;
  commandRunner?: OperatorVerificationCommandRunner;
  planProjectVerification?: typeof planProjectVerification;
  now?: () => number;
  maxBufferBytes?: number;
  maxExcerptChars?: number;
  heartbeatIntervalMs?: number;
}

export interface OperatorVerificationExecutionInput {
  run: OperatorRunRecord;
  node: OperatorRunNodeRecord;
  project: OperatorProjectRecord;
  plan?: OperatorVerificationPlan;
}

export class OperatorVerificationExecutor {
  private readonly runStore: OperatorRunStore;
  private readonly commandRunner: OperatorVerificationCommandRunner;
  private readonly planProjectVerification: typeof planProjectVerification;
  private readonly now: () => number;
  private readonly maxBufferBytes: number;
  private readonly maxExcerptChars: number;
  private readonly heartbeatIntervalMs: number;

  constructor(config: OperatorVerificationExecutorConfig = {}) {
    this.runStore = config.runStore ?? new OperatorRunStore(getOperatorDatabase().db);
    this.commandRunner = config.commandRunner ?? new ExecFileVerificationCommandRunner();
    this.planProjectVerification = config.planProjectVerification ?? planProjectVerification;
    this.now = config.now ?? Date.now;
    this.maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.maxExcerptChars = config.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  async execute(input: OperatorVerificationExecutionInput): Promise<OperatorVerificationSummary> {
    const plan = input.plan ?? await this.planProjectVerification(input.project.canonicalPath);
    if (plan.checks.length === 0) {
      const summary: OperatorVerificationSummary = {
        status: 'skipped',
        projectPath: plan.projectPath,
        kinds: plan.kinds,
        requiredFailed: 0,
        optionalFailed: 0,
        checks: [],
        ...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {}),
      };
      this.appendVerificationResult(input, summary);
      return summary;
    }

    const checks: OperatorVerificationCheckResult[] = [];
    for (const check of plan.checks) {
      checks.push(await this.executeCheck(input, check));
    }

    const requiredFailed = checks.filter((check) => check.required && check.status === 'failed').length;
    const optionalFailed = checks.filter((check) => !check.required && check.status === 'failed').length;
    const summary: OperatorVerificationSummary = {
      status: requiredFailed > 0 ? 'failed' : 'passed',
      projectPath: plan.projectPath,
      kinds: plan.kinds,
      requiredFailed,
      optionalFailed,
      checks,
      ...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {}),
    };
    this.appendVerificationResult(input, summary);
    return summary;
  }

  private async executeCheck(
    input: OperatorVerificationExecutionInput,
    check: OperatorVerificationCheck,
  ): Promise<OperatorVerificationCheckResult> {
    const cwd = input.project.canonicalPath;
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: input.node.id,
      kind: 'progress',
      payload: {
        message: `Starting verification command: ${check.label}`,
        label: check.label,
        cmd: check.command,
        args: check.args,
        cwd,
      },
    });
    const startedAt = this.now();
    const heartbeat = setInterval(() => {
      this.runStore.appendEvent({
        runId: input.run.id,
        nodeId: input.node.id,
        kind: 'progress',
        payload: {
          message: `Verification command still running: ${check.label}`,
          label: check.label,
          cmd: check.command,
          args: check.args,
          cwd,
        },
      });
    }, this.heartbeatIntervalMs);
    if (heartbeat.unref) {
      heartbeat.unref();
    }

    let result: OperatorVerificationCommandResult;
    try {
      result = await this.commandRunner.run(check.command, check.args, {
        cwd,
        timeoutMs: check.timeoutMs,
        maxBufferBytes: this.maxBufferBytes,
      });
    } finally {
      clearInterval(heartbeat);
    }

    const durationMs = this.now() - startedAt;
    const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
    const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');
    const eventPayload: OperatorShellCommandEventPayload = {
      cmd: check.command,
      args: check.args,
      cwd,
      exitCode: result.exitCode,
      durationMs,
      stdoutBytes,
      stderrBytes,
      timedOut: result.timedOut,
      ...(result.error ? { error: result.error } : {}),
    };
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: input.node.id,
      kind: 'shell-command',
      payload: eventPayload,
    });

    const passed = result.exitCode === 0 && !result.timedOut && result.error === null;
    return {
      label: check.label,
      command: check.command,
      args: check.args,
      cwd,
      required: check.required,
      status: passed ? 'passed' : 'failed',
      exitCode: result.exitCode,
      durationMs,
      timedOut: result.timedOut,
      stdoutBytes,
      stderrBytes,
      stdoutExcerpt: excerptOutput(result.stdout, this.maxExcerptChars),
      stderrExcerpt: excerptOutput(result.stderr, this.maxExcerptChars),
      error: result.error,
    };
  }

  private appendVerificationResult(
    input: OperatorVerificationExecutionInput,
    summary: OperatorVerificationSummary,
  ): void {
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: input.node.id,
      kind: 'verification-result',
      payload: summary as OperatorVerificationResultEventPayload,
    });
  }
}

class ExecFileVerificationCommandRunner implements OperatorVerificationCommandRunner {
  run(
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; maxBufferBytes: number },
  ): Promise<OperatorVerificationCommandResult> {
    return new Promise((resolve) => {
      execFile(command, args, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        const stdoutText = bufferToString(stdout);
        const stderrText = bufferToString(stderr);
        if (!error) {
          resolve({
            exitCode: 0,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut: false,
            error: null,
          });
          return;
        }

        resolve(mapExecFileError(error, stdoutText, stderrText, options.timeoutMs));
      });
    });
  }
}

function mapExecFileError(
  error: ExecFileException,
  stdout: string,
  stderr: string,
  timeoutMs: number,
): OperatorVerificationCommandResult {
  if (error.killed === true && error.signal === 'SIGTERM') {
    return {
      exitCode: null,
      stdout,
      stderr,
      timedOut: true,
      error: `Process timed out after ${timeoutMs}ms`,
    };
  }

  if (typeof error.code === 'number') {
    return {
      exitCode: error.code,
      stdout,
      stderr,
      timedOut: false,
      error: error.message,
    };
  }

  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return {
      exitCode: null,
      stdout,
      stderr,
      timedOut: false,
      error: 'Output exceeded maxBuffer',
    };
  }

  return {
    exitCode: null,
    stdout,
    stderr,
    timedOut: false,
    error: error.message,
  };
}

function excerptOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const half = Math.floor(maxChars / 2);
  return `${value.slice(0, half)}\n...[truncated]...\n${value.slice(-half)}`;
}

function bufferToString(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}
