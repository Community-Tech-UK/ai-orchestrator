/** Worker transport for the coordinator's existing runtime-reconciliation plan. */
import * as path from 'node:path';
import { getModelSwitchUnavailableReason } from '../shared/types/instance-status-policy';
import type { InstanceStatus } from '../shared/types/instance.types';
import type { ManagedInstance, SpawnParams } from './local-instance-manager';

interface ModelChangeDeps {
  getInstance(id: string): ManagedInstance | undefined;
  validateReplacement(params: SpawnParams): Promise<void>;
  terminate(id: string): Promise<void>;
  spawn(params: SpawnParams): Promise<void>;
}

export class WorkerModelChangeError extends Error {
  constructor(error: unknown, readonly previousRuntime: 'retained' | 'terminated' | 'unknown') {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'WorkerModelChangeError';
  }
}

export class WorkerInstanceModelChange {
  private readonly changing = new Map<string, { cancelled: boolean }>();
  constructor(private readonly deps: ModelChangeDeps) {}

  isChanging(id: string): boolean {
    return this.changing.has(id);
  }

  assertInputAllowed(id: string): void {
    if (this.isChanging(id)) throw new Error('The model change is still in progress. Wait before sending another request.');
  }
  cancel(id: string): void {
    const operation = this.changing.get(id);
    if (operation) operation.cancelled = true;
  }

  async change(previousInstanceId: string, replacement: SpawnParams): Promise<void> {
    const previous = this.deps.getInstance(previousInstanceId);
    let operation: { cancelled: boolean } | undefined;
    let teardownStarted = false;
    let previousTerminated = false;
    try {
      this.assertInputAllowed(previousInstanceId);
      this.assertInputAllowed(replacement.instanceId);
      if (!previous) throw new Error(`Instance not found: ${previousInstanceId}`);
      assertSettled(previous);
      if (previous.cliType !== replacement.cliType || path.resolve(previous.workingDirectory) !== path.resolve(replacement.workingDirectory)) {
        throw new Error('A model change must keep the same provider and working directory.');
      }
      for (const key of ['accountRoute', 'copilotAccountRoute'] as const) {
        const requested = replacement[key];
        const existing = previous.spawnParams[key];
        const identityKeys = ['provider', 'profileId', 'expectedIdentity', 'expectedLogin', 'host', 'region'] as const;
        if (requested && identityKeys.some(field => (requested as unknown as Record<string, unknown>)[field]
          !== (existing as unknown as Record<string, unknown> | undefined)?.[field])) {
          throw new Error('Changing the model cannot change the signed-in account.');
        }
      }
      const occupied = this.deps.getInstance(replacement.instanceId);
      if (occupied && occupied !== previous) throw new Error('The replacement session already exists.');
      // Keep resolved machine-session limits, account identity and worker attachments
      // when the model picker has no reason to send those fields again.
      const params = { ...previous.spawnParams, ...replacement,
        claudeSpawnPolicy: previous.spawnParams.claudeSpawnPolicy ?? replacement.claudeSpawnPolicy };
      operation = { cancelled: false };
      this.changing.set(previousInstanceId, operation); this.changing.set(replacement.instanceId, operation);
      await this.deps.validateReplacement(params);
      if (operation.cancelled) throw new Error('The model change was cancelled because the session was stopped.');
      if (this.deps.getInstance(previousInstanceId) !== previous) throw new Error('The worker session changed before the model change.');
      assertSettled(previous);
      teardownStarted = true;
      await this.deps.terminate(previousInstanceId);
      previousTerminated = true;
      if (operation.cancelled) throw new Error('The model change was cancelled because the session was stopped.');
      await this.deps.spawn(params);
    } catch (error) {
      const outcome = operation?.cancelled ? 'unknown' : previousTerminated ? 'terminated'
        : !teardownStarted && previous && this.deps.getInstance(previousInstanceId) === previous ? 'retained' : 'unknown';
      throw new WorkerModelChangeError(error, outcome);
    } finally {
      if (operation) {
        this.changing.delete(previousInstanceId); this.changing.delete(replacement.instanceId);
      }
    }
  }
}

function assertSettled(instance: ManagedInstance): void {
  const unavailable = getModelSwitchUnavailableReason(instance.lastStatus as InstanceStatus);
  if (unavailable) throw new Error(unavailable);
  if (instance.adapter.hasActiveTurn?.() || instance.adapter.hasActiveToolCalls?.()) {
    throw new Error('A turn is still running. Wait for it to finish before changing the model.');
  }
}
