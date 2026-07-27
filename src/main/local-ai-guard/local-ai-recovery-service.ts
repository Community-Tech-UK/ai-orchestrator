import { randomUUID } from 'node:crypto';
import type {
  LocalAiDiagnosticReport,
  LocalAiHealthSample,
  LocalAiHealthTransition,
  LocalAiProbeResult,
  LocalAiRepairAction,
  LocalAiRepairResult,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiHealthSampleSchema,
  LocalAiProbeResultSchema,
  LocalAiRepairActionSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import type { LocalAiHealthRepository } from './local-ai-health-repository';
import type { LocalAiIncidentService } from './local-ai-incident-service';
import type { LocalAiProbeService } from './local-ai-probe-service';
import type { LocalAiRecoveryAttemptCompletion } from './local-ai-recovery-attempt-store';
import type { LocalAiTargetRepository } from './local-ai-target-repository';

export type LocalAiRecoveryProbePort = Pick<
  LocalAiProbeService,
  'check' | 'diagnose' | 'repair'
>;

export interface LocalAiRecoveryServiceDependencies {
  targets: Pick<LocalAiTargetRepository, 'get'>;
  health: Pick<
    LocalAiHealthRepository,
    | 'appendSample'
    | 'latestSamples'
    | 'listIncidents'
    | 'claimRecoveryAttempt'
    | 'completeRecoveryAttempt'
  >;
  probes: LocalAiRecoveryProbePort;
  engine?: LocalAiHealthEngine;
  incidents: Pick<LocalAiIncidentService, 'handleTransition'>;
  now?: () => number;
  platform?: NodeJS.Platform;
  createId?: () => string;
}

interface GuidedRepair {
  supported: boolean;
  message: string;
}

interface VerificationResult {
  recovered: boolean;
  completedAt: number;
}

const SUPPORTED_COORDINATOR_RESTART_PLATFORMS = new Set<NodeJS.Platform>([
  'darwin',
  'linux',
  'win32',
]);

export class LocalAiRecoveryService {
  private readonly engine: LocalAiHealthEngine;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly createId: () => string;

  constructor(private readonly dependencies: LocalAiRecoveryServiceDependencies) {
    this.engine = dependencies.engine ?? new LocalAiHealthEngine();
    this.now = dependencies.now ?? Date.now;
    this.platform = dependencies.platform ?? process.platform;
    this.createId = dependencies.createId ?? randomUUID;
  }

  async diagnose(targetId: string): Promise<LocalAiDiagnosticReport> {
    return this.dependencies.probes.diagnose(this.requireTarget(targetId));
  }

  async repair(
    targetId: string,
    rawAction: LocalAiRepairAction,
    mode: 'guided' | 'automatic',
  ): Promise<LocalAiRepairResult> {
    const target = this.requireTarget(targetId);
    const action = LocalAiRepairActionSchema.parse(rawAction);
    if (mode === 'guided') return this.guidedResult(target, action);
    if (mode !== 'automatic') throw new Error('Invalid Local AI recovery mode');
    return this.automaticRepair(target, action);
  }

  private guidedResult(
    target: LocalAiTarget,
    action: LocalAiRepairAction,
  ): LocalAiRepairResult {
    const guided = this.guidedRepair(target, action);
    return {
      targetId: target.id,
      action,
      supported: guided.supported,
      attempted: false,
      recovered: false,
      message: guided.message,
      completedAt: this.currentTimestamp(),
    };
  }

  private async automaticRepair(
    target: LocalAiTarget,
    action: LocalAiRepairAction,
  ): Promise<LocalAiRepairResult> {
    const startedAt = this.currentTimestamp();
    if (!target.recovery.automatic) {
      return fixedResult(
        target,
        action,
        true,
        false,
        false,
        'Automatic Local AI repair is disabled for this target.',
        startedAt,
      );
    }
    if (!this.supportsAutomaticRepair(target, action)) {
      return fixedResult(
        target,
        action,
        false,
        false,
        false,
        action === 'restart-ollama'
          ? 'Ollama restart is not supported on this platform.'
          : 'This named repair is not supported for this target.',
        startedAt,
      );
    }

    const claim = this.dependencies.health.claimRecoveryAttempt({
      id: this.createId(),
      targetId: target.id,
      action,
      claimedAt: startedAt,
      maxAttempts: target.recovery.maxAttempts,
      cooldownMs: target.recovery.cooldownMs,
    });
    if (!claim.claimed) {
      return fixedResult(
        target,
        action,
        true,
        false,
        false,
        claim.reason === 'max-attempts'
          ? 'Automatic Local AI repair has reached its maximum attempt count.'
          : `Automatic Local AI repair is in cooldown until ${claim.nextEligibleAt ?? startedAt}.`,
        startedAt,
      );
    }

    try {
      const namedRepair = await this.dependencies.probes.repair(target, action);
      if (!namedRepair.supported) {
        const completedAt = this.completionTimestamp(startedAt, namedRepair.completedAt);
        this.completeAttempt(claim.attempt.id, {
          completedAt,
          outcome: 'unsupported',
          supported: false,
          attempted: false,
          recovered: false,
        });
        return fixedResult(
          target,
          action,
          false,
          false,
          false,
          'The named repair is not supported for this target.',
          completedAt,
        );
      }
      if (!namedRepair.attempted) {
        const completedAt = this.completionTimestamp(startedAt, namedRepair.completedAt);
        this.completeAttempt(claim.attempt.id, {
          completedAt,
          outcome: 'failed',
          supported: true,
          attempted: false,
          recovered: false,
        });
        return fixedResult(
          target,
          action,
          true,
          false,
          false,
          'The named repair did not execute.',
          completedAt,
        );
      }

      const verification = await this.verifyHealth(target);
      const completion: LocalAiRecoveryAttemptCompletion = {
        completedAt: verification.completedAt,
        outcome: verification.recovered ? 'recovered' : 'not-recovered',
        supported: true,
        attempted: true,
        recovered: verification.recovered,
      };
      this.completeAttempt(claim.attempt.id, completion);
      return fixedResult(
        target,
        action,
        true,
        true,
        verification.recovered,
        verification.recovered
          ? 'The named repair completed and required health checks passed.'
          : 'The named repair completed, but required health checks did not pass.',
        verification.completedAt,
      );
    } catch {
      const completedAt = this.completionTimestamp(startedAt);
      this.completeAttempt(claim.attempt.id, {
        completedAt,
        outcome: 'failed',
        supported: true,
        attempted: true,
        recovered: false,
      });
      return fixedResult(
        target,
        action,
        true,
        true,
        false,
        'The bounded Local AI repair could not be completed.',
        completedAt,
      );
    }
  }

  private async verifyHealth(target: LocalAiTarget): Promise<VerificationResult> {
    let previous = this.rebuildStatus(target);
    let finalTransition: LocalAiHealthTransition | undefined;
    let bothProbeKindsPassed = true;
    let completedAt = this.currentTimestamp();

    for (const kind of ['lightweight', 'functional'] as const) {
      const rawSamples = await this.safeCheck(target, kind);
      const samples = rawSamples.map((sample) =>
        this.sanitizeRecoverySample(target, kind, sample));
      bothProbeKindsPassed = bothProbeKindsPassed && requiredChecksPassed(samples);
      for (const sample of samples) {
        this.dependencies.health.appendSample(sample);
        completedAt = Math.max(completedAt, sample.checkedAt);
      }
      finalTransition = this.engine.apply(target, previous, samples, completedAt);
      previous = finalTransition.current;
      this.dependencies.incidents.handleTransition(finalTransition);
    }

    return {
      recovered: bothProbeKindsPassed
        && finalTransition !== undefined
        && (finalTransition.current.state === 'healthy' || finalTransition.current.state === 'degraded'),
      completedAt: this.completionTimestamp(completedAt),
    };
  }

  private rebuildStatus(target: LocalAiTarget): LocalAiTargetStatus | undefined {
    const samples = [...this.dependencies.health.latestSamples(target.id)]
      .sort((left, right) => left.checkedAt - right.checkedAt || left.id.localeCompare(right.id));
    let previous: LocalAiTargetStatus | undefined;
    for (const group of groupEvaluationCycles(samples)) {
      previous = this.engine.apply(target, previous, group, newestSampleTimestamp(group)).current;
    }
    const activeIncidents = [
      ...this.dependencies.health.listIncidents({ targetId: target.id, state: 'open', limit: 1_000 }),
      ...this.dependencies.health.listIncidents({ targetId: target.id, state: 'acknowledged', limit: 1_000 }),
    ];
    if (activeIncidents.length > 0) {
      const base = previous ?? this.engine.checking(target, target.updatedAt);
      previous = {
        ...base,
        state: 'unavailable',
        routableRoles: [],
        consecutiveFailures: Math.max(1, base.consecutiveFailures),
        consecutiveSuccesses: 0,
        recoveryState: 'unavailable',
        incidentOpen: true,
        checkedAt: Math.max(
          base.checkedAt,
          ...activeIncidents.map((incident) => incident.updatedAt),
        ),
      };
    }
    return previous;
  }

  private async safeCheck(
    target: LocalAiTarget,
    kind: 'lightweight' | 'functional',
  ): Promise<LocalAiProbeResult[]> {
    try {
      const samples = await this.dependencies.probes.check(target, kind);
      return samples.length ? samples : [this.monitorFailure(target, kind)];
    } catch {
      return [this.monitorFailure(target, kind)];
    }
  }

  private monitorFailure(
    target: LocalAiTarget,
    kind: 'lightweight' | 'functional',
  ): LocalAiProbeResult {
    return {
      targetId: target.id,
      layer: 'effectiveness',
      checkType: kind,
      ok: false,
      required: true,
      affectedRoles: [...target.routingRoles],
      checkedAt: this.currentTimestamp(),
      durationMs: 0,
      failureCode: 'monitor-error',
      evidence: { errorKind: 'probe-error' },
    };
  }

  private sanitizeRecoverySample(
    target: LocalAiTarget,
    kind: 'lightweight' | 'functional',
    raw: LocalAiProbeResult,
  ): LocalAiHealthSample {
    const parsed = LocalAiProbeResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.targetId !== target.id || parsed.data.checkType !== kind) {
      return LocalAiHealthSampleSchema.parse({
        targetId: target.id,
        layer: 'effectiveness',
        checkType: kind,
        ok: false,
        required: true,
        affectedRoles: [...target.routingRoles],
        checkedAt: this.currentTimestamp(),
        durationMs: 0,
        failureCode: 'monitor-error',
        evidence: {},
        id: randomUUID(),
        origin: 'recovery',
      });
    }
    return LocalAiHealthSampleSchema.parse({
      targetId: target.id,
      layer: parsed.data.layer,
      checkType: kind,
      ok: parsed.data.ok,
      required: parsed.data.required,
      affectedRoles: parsed.data.affectedRoles,
      checkedAt: parsed.data.checkedAt,
      durationMs: parsed.data.durationMs,
      ...(parsed.data.failureCode ? { failureCode: parsed.data.failureCode } : {}),
      evidence: {},
      id: randomUUID(),
      origin: 'recovery',
    });
  }

  private supportsAutomaticRepair(
    target: LocalAiTarget,
    action: LocalAiRepairAction,
  ): boolean {
    if (action === 'reconnect-worker') return false;
    if (action !== 'restart-ollama') return true;
    if (target.provider !== 'ollama') return false;
    return target.location.type === 'worker'
      || SUPPORTED_COORDINATOR_RESTART_PLATFORMS.has(this.platform);
  }

  private guidedRepair(target: LocalAiTarget, action: LocalAiRepairAction): GuidedRepair {
    switch (action) {
      case 'recheck-layer':
        return { supported: true, message: 'Run a lightweight health check for this target.' };
      case 'deep-check':
        return { supported: true, message: 'Run a functional health check for this target.' };
      case 'validate-models':
        return { supported: true, message: 'Compare the advertised models with the required model list.' };
      case 'reconnect-worker':
        return target.location.type === 'worker'
          ? { supported: true, message: 'Open Remote Nodes and reconnect the target worker.' }
          : { supported: false, message: 'This target does not use a remote worker.' };
      case 'restart-ollama':
        return this.guidedOllamaRestart(target);
    }
  }

  private guidedOllamaRestart(target: LocalAiTarget): GuidedRepair {
    if (target.provider !== 'ollama') {
      return { supported: false, message: 'This target is not an Ollama endpoint.' };
    }
    if (target.location.type === 'worker') {
      return {
        supported: true,
        message: 'Open Remote Nodes, select the target worker, and restart Ollama on that host.',
      };
    }
    switch (this.platform) {
      case 'darwin':
        return {
          supported: true,
          message: 'Quit Ollama, then open Ollama from the Applications folder.',
        };
      case 'win32':
        return {
          supported: true,
          message: 'Exit Ollama from the system tray, then open Ollama from the Start menu.',
        };
      case 'linux':
        return {
          supported: true,
          message: 'Restart the Ollama user service, then confirm that it is running.',
        };
      default:
        return { supported: false, message: 'Ollama restart is not supported on this platform.' };
    }
  }

  private completeAttempt(
    attemptId: string,
    completion: LocalAiRecoveryAttemptCompletion,
  ): void {
    if (!this.dependencies.health.completeRecoveryAttempt(attemptId, completion)) {
      throw new Error('Local AI recovery attempt could not be completed');
    }
  }

  private requireTarget(targetId: string): LocalAiTarget {
    const target = this.dependencies.targets.get(targetId);
    if (!target) throw new Error(`Local AI target not found: ${targetId}`);
    return target;
  }

  private currentTimestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('Local AI recovery clock must return a non-negative safe integer');
    }
    return now;
  }

  private completionTimestamp(...values: number[]): number {
    return Math.max(this.currentTimestamp(), ...values.filter((value) =>
      Number.isSafeInteger(value) && value >= 0));
  }
}

function groupEvaluationCycles(samples: LocalAiHealthSample[]): LocalAiHealthSample[][] {
  const groups = new Map<string, LocalAiHealthSample[]>();
  for (const sample of samples) {
    const key = `${sample.checkedAt}:${sample.checkType}:${sample.origin}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function newestSampleTimestamp(samples: LocalAiProbeResult[]): number {
  return samples.reduce((latest, sample) => Math.max(latest, sample.checkedAt), 0);
}

function requiredChecksPassed(samples: LocalAiProbeResult[]): boolean {
  const required = samples.filter((sample) => sample.required);
  return required.length > 0 && required.every((sample) => sample.ok);
}

function fixedResult(
  target: LocalAiTarget,
  action: LocalAiRepairAction,
  supported: boolean,
  attempted: boolean,
  recovered: boolean,
  message: string,
  completedAt: number,
): LocalAiRepairResult {
  return {
    targetId: target.id,
    action,
    supported,
    attempted,
    recovered,
    message,
    completedAt,
  };
}
