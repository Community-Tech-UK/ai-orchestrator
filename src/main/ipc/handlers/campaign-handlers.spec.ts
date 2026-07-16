/**
 * WS8 (loop-convergence plan) — campaign plan-import IPC behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@contracts/channels';
import { ipcMain } from 'electron';
import { registerCampaignHandlers } from './campaign-handlers';
import { computePlanSourceDigest } from '../../orchestration/campaign-plan-import';

const hoisted = vi.hoisted(() => ({
  coordinator: {
    on: vi.fn(),
    startCampaign: vi.fn(),
    getCampaign: vi.fn(),
    listCampaigns: vi.fn(),
    haltCampaignByOperator: vi.fn(),
    resumeCampaign: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../orchestration/campaign-coordinator', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getCampaignCoordinator: () => hoisted.coordinator,
  };
});

type IpcHandler = (event: unknown, payload: unknown) => Promise<{
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; timestamp: number };
}>;

function findIpcHandler(channel: string): IpcHandler {
  const handleMock = ipcMain.handle as unknown as { mock: { calls: [string, IpcHandler][] } };
  const call = handleMock.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`No IPC handler registered for ${channel}`);
  return call[1];
}

const PLAN = [
  '# Big plan',
  'implement one workstream per run.',
  '## WS1 — First',
  '- [ ] a',
  '## WS2 — Second',
  '- [ ] b',
].join('\n');

let workspace: string;

beforeEach(() => {
  vi.clearAllMocks();
  workspace = mkdtempSync(join(tmpdir(), 'campaign-import-'));
  writeFileSync(join(workspace, 'PLAN.md'), PLAN);
  registerCampaignHandlers({ windowManager: { sendToRenderer: vi.fn() } as never });
  hoisted.coordinator.startCampaign.mockImplementation(async (spec: { id: string }) => ({
    id: spec.id,
    spec,
    status: 'running',
    nodeRuns: new Map(),
    startedAt: 1,
  }));
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('CAMPAIGN_IMPORT_PLAN_PREVIEW', () => {
  it('builds the preview WITHOUT starting the campaign', async () => {
    const handler = findIpcHandler(IPC_CHANNELS.CAMPAIGN_IMPORT_PLAN_PREVIEW);

    const response = await handler({}, {
      workspaceCwd: workspace,
      planFile: 'PLAN.md',
      baseLoop: { verifyCommand: 'npm test' },
    });

    expect(response.success).toBe(true);
    const data = response.data as {
      spec: { nodes: { id: string }[] };
      sourceDigest: string;
      aggregateMaxCostCents: number;
    };
    expect(data.spec.nodes.map((n) => n.id)).toEqual(['ws1', 'ws2', 'integration-gate']);
    expect(data.sourceDigest).toBe(computePlanSourceDigest(PLAN));
    expect(data.aggregateMaxCostCents).toBe(3 * 3_000);
    // Import must never auto-start.
    expect(hoisted.coordinator.startCampaign).not.toHaveBeenCalled();
  });

  it('rejects a plan path outside the workspace', async () => {
    const handler = findIpcHandler(IPC_CHANNELS.CAMPAIGN_IMPORT_PLAN_PREVIEW);

    const response = await handler({}, {
      workspaceCwd: workspace,
      planFile: '../escape.md',
      baseLoop: { verifyCommand: 'npm test' },
    });

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('inside the workspace');
  });

  it('surfaces builder refusals (no verify command) as structured errors', async () => {
    const handler = findIpcHandler(IPC_CHANNELS.CAMPAIGN_IMPORT_PLAN_PREVIEW);

    const response = await handler({}, {
      workspaceCwd: workspace,
      planFile: 'PLAN.md',
      baseLoop: { verifyCommand: '' },
    });

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('verify command');
  });
});

describe('CAMPAIGN_START staleness check (WS8)', () => {
  function importedSpec(sourceDigest: string): Record<string, unknown> {
    return {
      id: 'plan-abc-1',
      title: 'Plan campaign: PLAN.md',
      nodes: [
        {
          id: 'ws1',
          loopConfig: {
            initialPrompt: 'do ws1',
            workspaceCwd: workspace,
            completion: { verifyCommand: 'npm test' },
          },
          dependsOn: [],
        },
      ],
      edges: [],
      policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 1 },
      createdAt: 1,
      sourceRef: 'PLAN.md',
      sourceDigest,
    };
  }

  it('refuses to start when the plan changed since preview', async () => {
    const handler = findIpcHandler(IPC_CHANNELS.CAMPAIGN_START);
    const staleSpec = importedSpec(computePlanSourceDigest(PLAN));
    writeFileSync(join(workspace, 'PLAN.md'), `${PLAN}\n## WS3 — Added later\n- [ ] c\n`);

    const response = await handler({}, staleSpec);

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('CAMPAIGN_PLAN_STALE');
    expect(hoisted.coordinator.startCampaign).not.toHaveBeenCalled();
  });

  it('starts when the current plan digest matches the preview digest', async () => {
    const handler = findIpcHandler(IPC_CHANNELS.CAMPAIGN_START);

    const response = await handler({}, importedSpec(computePlanSourceDigest(PLAN)));

    expect(response.success).toBe(true);
    expect(hoisted.coordinator.startCampaign).toHaveBeenCalledTimes(1);
  });

  it('specs without import metadata start as before (no staleness gate)', async () => {
    const handler = findIpcHandler(IPC_CHANNELS.CAMPAIGN_START);
    const spec = importedSpec(computePlanSourceDigest(PLAN));
    delete spec['sourceDigest'];
    delete spec['sourceRef'];

    const response = await handler({}, spec);

    expect(response.success).toBe(true);
    expect(hoisted.coordinator.startCampaign).toHaveBeenCalledTimes(1);
  });
});
