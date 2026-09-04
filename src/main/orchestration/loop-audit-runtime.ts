import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import type {
  LoopConfig,
  LoopFinalAuditResult,
  LoopIteration,
  LoopPlanPacketSummary,
  LoopPreflightResult,
  LoopRepoBaselineSnapshot,
  LoopState,
} from '../../shared/types/loop.types';
import { excerpt } from './loop-coordinator-utils';
import { configForLoopExecutionCwd, loopExecutionCwd } from './loop-cwd';
import type { LoopCompletionDetector, VerifyOutcome } from './loop-completion-detector';
import { resolveLoopArtifactPaths, type LoopArtifactPaths } from './loop-artifact-paths';
import {
  evaluateLoopFinalAudit,
  renderLoopFinalAuditMarkdown,
  scanAddedLinesForCleanliness,
  type LoopCleanlinessResult,
} from './loop-final-audit';
import { readLoopPlanPacket } from './loop-plan-packet';
import {
  captureLoopRepoBaseline,
  compareLoopRepoState,
  type LoopRepoBaseline,
} from './loop-repo-state';
import type { LoopStageMachine } from './loop-stage-machine';

const logger = getLogger('LoopAuditRuntime');

export interface LoopPreflightVerificationExecution {
  label: 'quick-verify' | 'verify';
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  startedAt: number;
}

/**
 * @deprecated Prefer `loopExecutionCwd` from `./loop-cwd` — the single home for
 * the state-cwd vs execution-cwd decision. Kept as a re-export so existing
 * audit-runtime call sites keep working without churn.
 */
export const effectiveLoopRepoCwd = loopExecutionCwd;

export async function captureAndPersistLoopRepoBaseline(
  repoCwd: string,
  loopRunId: string,
  repoBaselinePath: string,
): Promise<LoopRepoBaselineSnapshot> {
  const baseline = captureRepoBaseline(repoCwd);
  try {
    await fsp.mkdir(path.dirname(repoBaselinePath), { recursive: true });
    await fsp.writeFile(repoBaselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.warn('Failed to persist loop repo baseline', {
      loopRunId,
      repoBaselinePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return baseline;
}

export async function ensureLoopRepoBaselineForRestore(state: LoopState): Promise<LoopRepoBaselineSnapshot> {
  if (state.repoBaseline) return state.repoBaseline;
  const paths = resolveLoopArtifactPaths(state.config.workspaceCwd, state.id);
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.repoBaseline, 'utf8')) as Partial<LoopRepoBaselineSnapshot>;
    if (parsed.source === 'git' || parsed.source === 'none') {
      return {
        source: parsed.source,
        capturedAt: typeof parsed.capturedAt === 'number' ? parsed.capturedAt : Date.now(),
        workspaceCwd: typeof parsed.workspaceCwd === 'string' ? parsed.workspaceCwd : effectiveLoopRepoCwd(state.config),
        headRef: typeof parsed.headRef === 'string' ? parsed.headRef : null,
        dirtyAtStart: parsed.dirtyAtStart === true,
        trackedDirtyAtStart: Array.isArray(parsed.trackedDirtyAtStart) ? parsed.trackedDirtyAtStart.filter(isString) : [],
        untrackedAtStart: Array.isArray(parsed.untrackedAtStart) ? parsed.untrackedAtStart.filter(isString) : [],
        ...(isStringRecord(parsed.trackedDirtyHashes) ? { trackedDirtyHashes: parsed.trackedDirtyHashes } : {}),
        ...(isStringRecord(parsed.untrackedHashes) ? { untrackedHashes: parsed.untrackedHashes } : {}),
      };
    }
  } catch {
    // Missing/corrupt baseline from an older checkpoint; recapture below.
  }
  return captureAndPersistLoopRepoBaseline(
    effectiveLoopRepoCwd(state.config),
    state.id,
    paths.repoBaseline,
  );
}

/**
 * Budget for the preflight's full `verify` when the preflight is NOT a gate.
 *
 * The preflight is awaited before iteration 0, so its cost is dead time at the
 * head of every run. In `record` mode nothing gates on the result — it is a
 * baseline for the report — so it must not be allowed to spend the whole
 * `verifyTimeoutMs`. Observed 2026-09-02: a repo whose `verify` runs the full
 * suite burned the entire 600s budget, delayed the first iteration by ten
 * minutes, and produced only "timed out". `block` mode is a real gate and still
 * gets the configured budget, because there it has to prove something.
 */
export const LOOP_PREFLIGHT_VERIFY_BUDGET_MS = 180_000;

/** Why a non-gating preflight stopped after the cheap command. */
export const PREFLIGHT_VERIFY_SKIPPED_NOTE =
  '(not run: quick-verify already established the baseline, and a `record` preflight gates nothing)';

/**
 * Why a non-gating preflight skipped the slow command when no cheap one ran.
 * Observed 2026-09-03: with no quick-verify, the 180s cap still burned three
 * minutes of dead time to produce "timed out" — UNKNOWN, not a baseline.
 */
export const PREFLIGHT_VERIFY_SKIPPED_NO_CHEAP_NOTE =
  '(not run: no quick-verify configured, and a `record` preflight gates nothing)';

/** True when the preflight can actually stop the run, i.e. it has to prove something. */
function isGatingPreflight(config: LoopConfig): boolean {
  return config.audit.preflightMode === 'block';
}

/** Config the preflight runs under: repo-scoped, and budget-capped unless it is a gate. */
function preflightConfig(state: LoopState): LoopConfig {
  const config = configForEffectiveRepoCwd(state);
  if (isGatingPreflight(config)) return config;
  const capped = Math.min(config.completion.verifyTimeoutMs, LOOP_PREFLIGHT_VERIFY_BUDGET_MS);
  if (capped === config.completion.verifyTimeoutMs) return config;
  return { ...config, completion: { ...config.completion, verifyTimeoutMs: capped } };
}

export async function runLoopPreflight(
  state: LoopState,
  completionDetector: Pick<LoopCompletionDetector, 'runQuickVerify' | 'runVerify'>,
  onVerificationExecution?: (execution: LoopPreflightVerificationExecution) => void,
): Promise<LoopPreflightResult> {
  const ranAt = Date.now();
  const commands: LoopPreflightResult['commands'] = [];
  const config = preflightConfig(state);
  const quickCommand = config.completion.quickVerifyCommand?.trim();
  const verifyCommand = config.completion.verifyCommand.trim();
  if (quickCommand) {
    const startedAt = Date.now();
    const quick = await completionDetector.runQuickVerify(config);
    reportPreflightVerification(onVerificationExecution, 'quick-verify', quickCommand, quick, startedAt);
    commands.push({
      label: 'quick-verify',
      command: quickCommand,
      status: quick.status,
      durationMs: quick.durationMs,
      outputExcerpt: excerpt(quick.output, 4096),
      ...(quick.status === 'failed' ? { failureKind: quick.failureKind } : {}),
    });
    if (quick.status === 'failed') return { status: 'failed', ranAt, commands };
    // Nothing downstream reads a `record` preflight's status — it drives the
    // badge and PRE_FLIGHT.md only (the `preflight-red-baseline` finding has no
    // producer). Once the cheap command has answered "was this tree already
    // broken?", the slow one adds minutes of dead time at the head of the run
    // for a baseline nobody gates on. `block` mode still runs the command it
    // gates on, because there the answer has to be the real one.
    if (quick.status === 'passed' && !isGatingPreflight(config) && verifyCommand) {
      commands.push({
        label: 'verify',
        command: verifyCommand,
        status: 'skipped',
        durationMs: 0,
        outputExcerpt: PREFLIGHT_VERIFY_SKIPPED_NOTE,
      });
      return { status: 'passed', ranAt, commands };
    }
  }
  if (verifyCommand && config.audit.preflightMode === 'record') {
    // Same rationale as the quick-verify short-circuit above, for the case
    // where there is no cheap command at all. The auto-inferred workspace
    // `verify` in this repo cannot finish inside the capped budget, so running
    // it only produces a red timeout chip and delays iteration 1. `block`
    // still has to run the command it gates on.
    commands.push({
      label: 'verify',
      command: verifyCommand,
      status: 'skipped',
      durationMs: 0,
      outputExcerpt: PREFLIGHT_VERIFY_SKIPPED_NO_CHEAP_NOTE,
    });
    return { status: 'skipped', ranAt, commands };
  }
  if (verifyCommand) {
    const startedAt = Date.now();
    const verify = await completionDetector.runVerify(config);
    reportPreflightVerification(onVerificationExecution, 'verify', verifyCommand, verify, startedAt);
    commands.push({
      label: 'verify',
      command: verifyCommand,
      status: verify.status,
      durationMs: verify.durationMs,
      outputExcerpt: excerpt(verify.output, 4096),
      ...(verify.status === 'failed' ? { failureKind: verify.failureKind } : {}),
    });
  }
  const status = commands.some((command) => command.status === 'failed')
    ? 'failed'
    : commands.length > 0 && commands.some((command) => command.status === 'passed')
      ? 'passed'
      : 'skipped';
  return { status, ranAt, commands };
}

function reportPreflightVerification(
  callback: ((execution: LoopPreflightVerificationExecution) => void) | undefined,
  label: LoopPreflightVerificationExecution['label'],
  command: string,
  outcome: VerifyOutcome,
  startedAt: number,
): void {
  if (!callback || outcome.status === 'skipped') return;
  try {
    callback({
      label,
      command,
      exitCode: outcome.status === 'passed' ? 0 : outcome.exitCode,
      durationMs: outcome.durationMs,
      output: outcome.output,
      startedAt,
    });
  } catch (err) {
    logger.warn('Preflight verification ledger reporting failed (fail-soft)', {
      label,
      command,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function writeLoopPreflightArtifact(
  state: LoopState,
  preflight: LoopPreflightResult,
): Promise<void> {
  const paths = resolveLoopArtifactPaths(state.config.workspaceCwd, state.id);
  try {
    await fsp.mkdir(path.dirname(paths.preflight), { recursive: true });
    await fsp.writeFile(
      paths.preflight,
      renderLoopPreflightMarkdown(preflight, state.config.audit.preflightMode),
      'utf8',
    );
  } catch (err) {
    logger.warn('Failed to write loop preflight artifact', {
      loopRunId: state.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runLoopFinalAudit(
  state: LoopState,
  iteration: LoopIteration | undefined,
  verifyStatus: 'passed' | 'failed' | 'skipped',
  stageMachine: LoopStageMachine,
): Promise<LoopFinalAuditResult> {
  const paths = stageMachine.paths;
  const reportPath = paths.audit;
  if (state.config.audit.finalAuditMode === 'off') {
    const result = finalAuditDisabled();
    if (iteration) iteration.finalAudit = result;
    state.latestFinalAudit = result;
    return result;
  }
  let result: LoopFinalAuditResult;
  try {
    const baseline = state.repoBaseline ?? await ensureLoopRepoBaselineForRestore(state);
    state.repoBaseline = baseline;
    const repoComparison = compareLoopRepoState(
      effectiveLoopRepoCwd(state.config),
      baseline as LoopRepoBaseline,
    );
    const ledger = await stageMachine.readTaskLedger();
    const planPacket = await readPlanPacketForAudit(state, paths);
    const cleanliness = state.config.audit.cleanlinessScan
      ? scanAddedLinesForCleanliness(repoComparison.trackedDiff)
      : skippedCleanlinessResult();
    result = evaluateLoopFinalAudit({
      goalIntent: state.config.goalIntent ?? 'implementation',
      mode: state.config.audit.finalAuditMode,
      verifyStatus,
      repoComparison,
      ledger: {
        total: ledger.total,
        resolved: ledger.resolved,
        open: Math.max(0, ledger.total - ledger.resolved),
      },
      planPacket,
      cleanliness,
      reportPath,
    });
  } catch (err) {
    result = finalAuditInternalError(reportPath, err);
  }
  if (iteration) iteration.finalAudit = result;
  state.latestFinalAudit = result;
  await writeLoopFinalAuditArtifact(state, result, reportPath);
  return result;
}

export function buildFinalAuditIntervention(finalAudit: LoopFinalAuditResult): string {
  const findings = finalAudit.findings.filter((finding) => finding.severity === 'blocking');
  const visibleFindings = findings.length > 0 ? findings : finalAudit.findings;
  const bullets = visibleFindings.slice(0, 8)
    .map((finding) => `- ${finding.code}: ${finding.message}`)
    .join('\n');
  const remaining = visibleFindings.length > 8
    ? `\n- ... ${visibleFindings.length - 8} more finding(s) in ${finalAudit.reportPath ?? 'AUDIT.md'}`
    : '';
  const report = finalAudit.reportPath ? `\n\nAudit report: ${finalAudit.reportPath}` : '';
  return [
    'Your completion was rejected by the final audit. Fix these findings before re-declaring completion:',
    '',
    bullets || '- Final audit failed without a detailed finding.',
    remaining,
    report,
  ].filter((part) => part.length > 0).join('\n');
}

function captureRepoBaseline(repoCwd: string): LoopRepoBaselineSnapshot {
  try {
    return captureLoopRepoBaseline(repoCwd);
  } catch (err) {
    logger.warn('Failed to capture loop repo baseline', {
      repoCwd,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      source: 'none',
      capturedAt: Date.now(),
      workspaceCwd: repoCwd,
      headRef: null,
      dirtyAtStart: false,
      trackedDirtyAtStart: [],
      untrackedAtStart: [],
    };
  }
}

function configForEffectiveRepoCwd(state: LoopState): LoopConfig {
  return configForLoopExecutionCwd(state.config);
}

function renderLoopPreflightMarkdown(
  preflight: LoopPreflightResult,
  mode: LoopConfig['audit']['preflightMode'],
): string {
  const lines = [
    '# Loop Preflight',
    '',
    `- Status: ${preflight.status}`,
    `- Mode: ${mode}`,
    `- Ran at: ${new Date(preflight.ranAt).toISOString()}`,
    '',
  ];
  if (mode !== 'block' && preflight.commands.some((command) => command.failureKind === 'timeout')) {
    lines.push(
      '- Note: the baseline verify hit its time budget and was stopped. The starting state is'
      + ' UNKNOWN, not proven red — a `record` preflight never gates the run.',
      '',
    );
  }
  if (
    mode !== 'block'
    && preflight.commands.some((command) => command.label === 'verify' && command.status === 'skipped')
  ) {
    const skippedAfterQuick = preflight.commands.some(
      (command) => command.label === 'quick-verify' && command.status === 'passed',
    );
    lines.push(
      skippedAfterQuick
        ? '- Note: the baseline stopped after quick-verify. A `record` preflight never gates the run,'
          + ' so the full verify was not worth the dead time ahead of iteration 1.'
        : '- Note: the full verify was not run. A `record` preflight never gates the run, and with no'
          + ' quick-verify command a timeout would only prove the budget, not the tree.',
      '',
    );
  }
  if (preflight.commands.length === 0) {
    lines.push('- (none configured)', '');
    return lines.join('\n');
  }
  for (const command of preflight.commands) {
    lines.push(`## ${command.label}`, '');
    lines.push(`- Status: ${command.status}`);
    lines.push(`- Duration: ${command.durationMs}ms`);
    lines.push(`- Command: \`${command.command.replace(/`/g, '\\`')}\``);
    lines.push('');
    lines.push('```text');
    lines.push(command.outputExcerpt || '(no output)');
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

async function readPlanPacketForAudit(
  state: LoopState,
  paths: LoopArtifactPaths,
): Promise<LoopPlanPacketSummary | null> {
  if (state.config.audit.planPacketMode === 'off') return null;
  return await readLoopPlanPacket(paths) ?? missingPlanPacketSummary(paths);
}

function missingPlanPacketSummary(paths: LoopArtifactPaths): LoopPlanPacketSummary {
  return {
    roadmapPath: paths.roadmap,
    phases: [],
    criteriaTotal: 0,
    criteriaWithEvidence: 0,
    malformed: true,
  };
}

function skippedCleanlinessResult(): LoopCleanlinessResult {
  return { status: 'skipped', findings: [] };
}

function finalAuditInternalError(reportPath: string, err: unknown): LoopFinalAuditResult {
  return {
    status: 'failed',
    ranAt: Date.now(),
    coverage: {
      criteriaTotal: 0,
      criteriaVerified: 0,
      criteriaUnverified: 0,
      verifyCommandRan: false,
      repoComparisonRan: false,
      cleanlinessScanRan: false,
    },
    findings: [{
      severity: 'blocking',
      code: 'audit-internal-error',
      message: 'The final audit could not complete.',
      detail: { error: err instanceof Error ? err.message : String(err) },
    }],
    changedFiles: [],
    reportPath,
  };
}

function finalAuditDisabled(): LoopFinalAuditResult {
  return {
    status: 'skipped',
    ranAt: Date.now(),
    coverage: {
      criteriaTotal: 0,
      criteriaVerified: 0,
      criteriaUnverified: 0,
      verifyCommandRan: false,
      repoComparisonRan: false,
      cleanlinessScanRan: false,
    },
    findings: [],
    changedFiles: [],
  };
}

async function writeLoopFinalAuditArtifact(
  state: LoopState,
  result: LoopFinalAuditResult,
  reportPath: string,
): Promise<void> {
  if (state.config.audit.finalAuditMode === 'off') return;
  try {
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, renderLoopFinalAuditMarkdown(result), 'utf8');
  } catch (err) {
    logger.warn('Failed to write loop final audit artifact', {
      loopRunId: state.id,
      reportPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isString);
}
