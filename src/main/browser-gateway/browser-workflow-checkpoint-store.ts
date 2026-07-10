import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getProjectStoragePaths } from '../storage/project-storage-paths';

export interface BrowserWorkflowCheckpointStep {
  stepId: string;
  completedAt: number;
  pageFingerprint: string;
  resultSummary?: string;
}

export interface BrowserWorkflowCheckpoint {
  ownerId: string;
  workflowId: string;
  updatedAt: number;
  steps: BrowserWorkflowCheckpointStep[];
}

export interface BrowserWorkflowStepDefinition {
  id: string;
}

export interface BrowserWorkflowResumeOps<TStep extends BrowserWorkflowStepDefinition> {
  fingerprint(step: TStep): Promise<string>;
  verifyCompleted(step: TStep, checkpoint: BrowserWorkflowCheckpointStep): Promise<boolean>;
  run(step: TStep): Promise<unknown>;
}

export interface BrowserWorkflowResumeResult {
  workflowId: string;
  resumedStepIds: string[];
  executedStepIds: string[];
  checkpoint: BrowserWorkflowCheckpoint;
}

export class BrowserWorkflowCheckpointStore {
  private static instance: BrowserWorkflowCheckpointStore | null = null;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly rootDir = defaultCheckpointRoot()) {}

  static getInstance(): BrowserWorkflowCheckpointStore {
    if (!this.instance) {
      this.instance = new BrowserWorkflowCheckpointStore();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async get(ownerId: string, workflowId: string): Promise<BrowserWorkflowCheckpoint | null> {
    try {
      const raw = await fs.readFile(this.pathFor(ownerId, workflowId), 'utf8');
      return normalizeCheckpoint(JSON.parse(raw), ownerId, workflowId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async saveStep(params: {
    ownerId: string;
    workflowId: string;
    stepId: string;
    pageFingerprint: string;
    resultSummary?: string;
    completedAt?: number;
  }): Promise<BrowserWorkflowCheckpoint> {
    const queueKey = `${params.ownerId}\0${params.workflowId}`;
    const previous = this.writeQueues.get(queueKey) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.saveStepUnlocked(params));
    const tail = operation.then(() => undefined, () => undefined);
    this.writeQueues.set(queueKey, tail);
    try {
      return await operation;
    } finally {
      if (this.writeQueues.get(queueKey) === tail) {
        this.writeQueues.delete(queueKey);
      }
    }
  }

  private async saveStepUnlocked(params: {
    ownerId: string;
    workflowId: string;
    stepId: string;
    pageFingerprint: string;
    resultSummary?: string;
    completedAt?: number;
  }): Promise<BrowserWorkflowCheckpoint> {
    const existing = await this.get(params.ownerId, params.workflowId);
    const step: BrowserWorkflowCheckpointStep = {
      stepId: params.stepId,
      completedAt: params.completedAt ?? Date.now(),
      pageFingerprint: params.pageFingerprint,
      ...(params.resultSummary === undefined ? {} : { resultSummary: params.resultSummary }),
    };
    const steps = [
      ...(existing?.steps.filter((item) => item.stepId !== params.stepId) ?? []),
      step,
    ];
    const checkpoint = {
      ownerId: params.ownerId,
      workflowId: params.workflowId,
      updatedAt: step.completedAt,
      steps,
    };
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const checkpointPath = this.pathFor(params.ownerId, params.workflowId);
    const temporaryPath = `${checkpointPath}.tmp`;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.rename(temporaryPath, checkpointPath);
    return checkpoint;
  }

  private pathFor(ownerId: string, workflowId: string): string {
    return path.join(this.rootDir, `${safeStorageId(ownerId)}-${safeStorageId(workflowId)}.json`);
  }
}

export async function resumeCheckpointedBrowserWorkflow<TStep extends BrowserWorkflowStepDefinition>(
  params: {
    ownerId: string;
    workflowId: string;
    steps: TStep[];
    store: BrowserWorkflowCheckpointStore;
    ops: BrowserWorkflowResumeOps<TStep>;
  },
): Promise<BrowserWorkflowResumeResult> {
  const existing = await params.store.get(params.ownerId, params.workflowId);
  const completed = new Map(existing?.steps.map((step) => [step.stepId, step]) ?? []);
  const resumedStepIds: string[] = [];
  const executedStepIds: string[] = [];
  let checkpoint = existing ?? {
    ownerId: params.ownerId,
    workflowId: params.workflowId,
    updatedAt: Date.now(),
    steps: [],
  };

  for (const step of params.steps) {
    const prior = completed.get(step.id);
    if (prior) {
      const fingerprint = await params.ops.fingerprint(step);
      if (fingerprint === prior.pageFingerprint && await params.ops.verifyCompleted(step, prior)) {
        resumedStepIds.push(step.id);
        continue;
      }
    }
    await params.ops.run(step);
    const pageFingerprint = await params.ops.fingerprint(step);
    checkpoint = await params.store.saveStep({
      ownerId: params.ownerId,
      workflowId: params.workflowId,
      stepId: step.id,
      pageFingerprint,
    });
    executedStepIds.push(step.id);
  }

  return {
    workflowId: params.workflowId,
    resumedStepIds,
    executedStepIds,
    checkpoint,
  };
}

function normalizeCheckpoint(
  value: unknown,
  ownerId: string,
  workflowId: string,
): BrowserWorkflowCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser_workflow_checkpoint_invalid');
  }
  const record = value as Record<string, unknown>;
  if (record['ownerId'] !== ownerId || record['workflowId'] !== workflowId) {
    throw new Error('browser_workflow_checkpoint_invalid');
  }
  const steps = Array.isArray(record['steps'])
    ? record['steps'].map(normalizeCheckpointStep).filter((step) => step !== null)
    : [];
  return {
    ownerId,
    workflowId,
    updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : 0,
    steps,
  };
}

function normalizeCheckpointStep(value: unknown): BrowserWorkflowCheckpointStep | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['stepId'] !== 'string'
    || typeof record['completedAt'] !== 'number'
    || typeof record['pageFingerprint'] !== 'string'
  ) {
    return null;
  }
  return {
    stepId: record['stepId'],
    completedAt: record['completedAt'],
    pageFingerprint: record['pageFingerprint'],
    ...(typeof record['resultSummary'] === 'string' && record['resultSummary'].length <= 2_000
      ? { resultSummary: record['resultSummary'] }
      : {}),
  };
}

function defaultCheckpointRoot(): string {
  return getProjectStoragePaths().getGlobalDomainRoot('browser-workflow-checkpoints');
}

function safeStorageId(value: string): string {
  const readable = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workflow';
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `${readable}-${digest}`;
}

export function getBrowserWorkflowCheckpointStore(): BrowserWorkflowCheckpointStore {
  return BrowserWorkflowCheckpointStore.getInstance();
}
