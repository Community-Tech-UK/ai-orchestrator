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
import type { LoopCompletionDetector } from './loop-completion-detector';
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

export function effectiveLoopRepoCwd(config: Pick<LoopConfig, 'workspaceCwd' | 'executionCwd'>): string {
  return config.executionCwd?.trim() || config.workspaceCwd;
}

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

export async function runLoopPreflight(
  state: LoopState,
  completionDetector: Pick<LoopCompletionDetector, 'runQuickVerify' | 'runVerify'>,
): Promise<LoopPreflightResult> {
  const ranAt = Date.now();
  const commands: LoopPreflightResult['commands'] = [];
  const config = configForEffectiveRepoCwd(state);
  const quickCommand = config.completion.quickVerifyCommand?.trim();
  const verifyCommand = config.completion.verifyCommand.trim();
  if (quickCommand) {
    const quick = await completionDetector.runQuickVerify(config);
    commands.push({
      label: 'quick-verify',
      command: quickCommand,
      status: quick.status,
      durationMs: quick.durationMs,
      outputExcerpt: excerpt(quick.output, 4096),
    });
    if (quick.status === 'failed') return { status: 'failed', ranAt, commands };
  }
  if (verifyCommand) {
    const verify = await completionDetector.runVerify(config);
    commands.push({
      label: 'verify',
      command: verifyCommand,
      status: verify.status,
      durationMs: verify.durationMs,
      outputExcerpt: excerpt(verify.output, 4096),
    });
  }
  const status = commands.some((command) => command.status === 'failed')
    ? 'failed'
    : commands.length > 0 && commands.some((command) => command.status === 'passed')
      ? 'passed'
      : 'skipped';
  return { status, ranAt, commands };
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
  const repoCwd = effectiveLoopRepoCwd(state.config);
  return repoCwd === state.config.workspaceCwd
    ? state.config
    : { ...state.config, workspaceCwd: repoCwd };
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
