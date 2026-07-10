import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserWorkflowCheckpointStore,
  resumeCheckpointedBrowserWorkflow,
} from './browser-workflow-checkpoint-store';

describe('BrowserWorkflowCheckpointStore', () => {
  const ownerId = 'instance-1';
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-workflow-checkpoint-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('persists completed browser workflow steps as JSON', async () => {
    const store = new BrowserWorkflowCheckpointStore(tempDir);

    await store.saveStep({
      ownerId,
      workflowId: 'play-data-safety/com.example.app',
      stepId: 'import-csv',
      pageFingerprint: 'url:/console/app/content/data-safety|saved:true',
      completedAt: 123,
    });

    await expect(store.get(ownerId, 'play-data-safety/com.example.app')).resolves.toMatchObject({
      ownerId,
      workflowId: 'play-data-safety/com.example.app',
      steps: [{
        stepId: 'import-csv',
        completedAt: 123,
        pageFingerprint: 'url:/console/app/content/data-safety|saved:true',
      }],
    });
  });

  it('supports maximum-length workflow ids without exceeding filesystem limits', async () => {
    const store = new BrowserWorkflowCheckpointStore(tempDir);
    const workflowId = `play-release/${'a'.repeat(487)}`;

    await store.saveStep({
      ownerId,
      workflowId,
      stepId: 'create-app',
      pageFingerprint: 'created',
    });

    await expect(store.get(ownerId, workflowId)).resolves.toMatchObject({
      workflowId,
      steps: [{ stepId: 'create-app' }],
    });
  });

  it('serializes concurrent step saves without losing completed steps', async () => {
    const store = new BrowserWorkflowCheckpointStore(tempDir);
    const stepIds = Array.from({ length: 20 }, (_, index) => `step-${index}`);

    await Promise.all(stepIds.map((stepId) => store.saveStep({
      ownerId,
      workflowId: 'concurrent-workflow',
      stepId,
      pageFingerprint: `fingerprint-${stepId}`,
    })));

    const checkpoint = await store.get(ownerId, 'concurrent-workflow');
    expect(checkpoint?.steps.map((step) => step.stepId).sort()).toEqual(stepIds.sort());
  });

  it('drops arbitrary legacy result payloads when loading checkpoints', async () => {
    const store = new BrowserWorkflowCheckpointStore(tempDir);
    await store.saveStep({
      ownerId,
      workflowId: 'legacy-workflow',
      stepId: 'login',
      pageFingerprint: 'logged-in',
    });
    const [checkpointFile] = await fs.readdir(tempDir);
    await fs.writeFile(path.join(tempDir, checkpointFile), JSON.stringify({
      ownerId,
      workflowId: 'legacy-workflow',
      updatedAt: 1,
      steps: [{
        stepId: 'login',
        completedAt: 1,
        pageFingerprint: 'logged-in',
        result: { password: 'must-not-load' },
      }],
    }));

    const checkpoint = await store.get(ownerId, 'legacy-workflow');

    expect(checkpoint?.steps[0]).toEqual({
      stepId: 'login',
      completedAt: 1,
      pageFingerprint: 'logged-in',
    });
  });

  it('rejects checkpoint files whose embedded workflow id does not match the requested workflow', async () => {
    const store = new BrowserWorkflowCheckpointStore(tempDir);
    await store.saveStep({
      ownerId,
      workflowId: 'expected-workflow',
      stepId: 'login',
      pageFingerprint: 'logged-in',
    });
    const [checkpointFile] = await fs.readdir(tempDir);
    await fs.writeFile(path.join(tempDir, checkpointFile), JSON.stringify({
      ownerId,
      workflowId: 'different-workflow',
      updatedAt: 1,
      steps: [],
    }));

    await expect(store.get(ownerId, 'expected-workflow')).rejects.toThrow(
      'browser_workflow_checkpoint_invalid',
    );
  });

  it('isolates identical workflow ids between agent instances', async () => {
    const store = new BrowserWorkflowCheckpointStore(tempDir);
    await store.saveStep({
      ownerId: 'instance-a',
      workflowId: 'release/app',
      stepId: 'step-a',
      pageFingerprint: 'a',
    });
    await store.saveStep({
      ownerId: 'instance-b',
      workflowId: 'release/app',
      stepId: 'step-b',
      pageFingerprint: 'b',
    });

    await expect(store.get('instance-a', 'release/app')).resolves.toMatchObject({
      steps: [{ stepId: 'step-a' }],
    });
    await expect(store.get('instance-b', 'release/app')).resolves.toMatchObject({
      steps: [{ stepId: 'step-b' }],
    });
  });

  it('re-verifies matching checkpoints instead of redoing completed steps', async () => {
    const store = new BrowserWorkflowCheckpointStore(tempDir);
    await store.saveStep({
      ownerId,
      workflowId: 'new-app',
      stepId: 'create-app',
      pageFingerprint: 'created',
      completedAt: 1,
    });
    const run = vi.fn(async () => ({ ok: true }));

    const result = await resumeCheckpointedBrowserWorkflow({
      ownerId,
      workflowId: 'new-app',
      steps: [{ id: 'create-app' }, { id: 'data-safety' }],
      store,
      ops: {
        fingerprint: async (step) => step.id === 'create-app' ? 'created' : 'data-safety-saved',
        verifyCompleted: async () => true,
        run,
      },
    });

    expect(result.resumedStepIds).toEqual(['create-app']);
    expect(result.executedStepIds).toEqual(['data-safety']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ id: 'data-safety' });
  });

  it('re-runs a prior step when the page fingerprint no longer matches', async () => {
    const store = new BrowserWorkflowCheckpointStore(tempDir);
    await store.saveStep({
      ownerId,
      workflowId: 'resolution-center',
      stepId: 'read-rejection',
      pageFingerprint: 'old-rejection',
      completedAt: 1,
    });
    const run = vi.fn(async () => ({ ok: true }));

    const result = await resumeCheckpointedBrowserWorkflow({
      ownerId,
      workflowId: 'resolution-center',
      steps: [{ id: 'read-rejection' }],
      store,
      ops: {
        fingerprint: async () => 'new-rejection',
        verifyCompleted: async () => true,
        run,
      },
    });

    expect(result.resumedStepIds).toEqual([]);
    expect(result.executedStepIds).toEqual(['read-rejection']);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
