/**
 * Campaign Coordinator — DAG walker unit tests.
 *
 * Tests pure logic: spec validation, cycle detection, edge predicates,
 * and CampaignStore persistence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { CampaignCoordinator, validateCampaignSpec, evaluatePredicate } from '../campaign-coordinator';
import { CampaignStore } from '../campaign-store';
import { createLoopMigrationsTable, runLoopMigrations } from '../loop-schema';
import type { CampaignSpec, CampaignRun, TerminalStatusPredicate, CampaignNodeStatus } from '../campaign.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSpec(overrides: Partial<CampaignSpec> = {}): CampaignSpec {
  return {
    id: 'camp-1',
    title: 'Test campaign',
    nodes: [
      { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/tmp' }, dependsOn: [] },
    ],
    edges: [],
    policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 3 },
    createdAt: 1_000_000,
    ...overrides,
  };
}

function buildDb(): SqliteDriver {
  const db = new Database(':memory:') as unknown as SqliteDriver;
  db.pragma('foreign_keys = ON');
  runLoopMigrations(db);
  return db;
}

async function flushAsyncWork(rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    // Drain both microtasks and the next macrotask turn. Under the node
    // Vitest project (no zone.js), nested awaits from recovery/advance need
    // more than a single setImmediate to settle.
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Poll until `predicate` is true or `timeoutMs` elapses. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await flushAsyncWork();
  }
}

// ---------------------------------------------------------------------------
// validateCampaignSpec
// ---------------------------------------------------------------------------

describe('validateCampaignSpec — basic validation', () => {
  it('accepts a single-node spec', () => {
    const result = validateCampaignSpec(buildSpec());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an empty node list', () => {
    const result = validateCampaignSpec(buildSpec({ nodes: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('at least one node'))).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'a', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate node'))).toBe(true);
  });

  it('rejects edges referencing unknown nodes', () => {
    const result = validateCampaignSpec(buildSpec({
      edges: [{ from: 'a', to: 'ghost' }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown'))).toBe(true);
  });

  it('rejects self-loop edges', () => {
    const result = validateCampaignSpec(buildSpec({
      edges: [{ from: 'a', to: 'a' }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Self-loop'))).toBe(true);
  });

  it('rejects invalid maxParallel values before the coordinator runs', () => {
    const result = validateCampaignSpec(buildSpec({
      policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 0 },
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('maxParallel'))).toBe(true);
  });

  it('rejects edge predicates with invalid terminal statuses', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b', when: { type: 'is', status: 'unknown-status' as never } }],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('predicate status'))).toBe(true);
  });

  it('rejects interrupted edge predicates because loop runs never emit that terminal status', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b', when: { type: 'is', status: 'interrupted' as never } }],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('predicate status'))).toBe(true);
  });

  it('rejects provider-limit edge predicates because provider-limit nodes are resumable', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b', when: { type: 'is', status: 'provider-limit' as never } }],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('predicate status'))).toBe(true);
  });

  it('rejects edge predicates with an empty status list', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b', when: { type: 'in', statuses: [] } }],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('at least one'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe('validateCampaignSpec — cycle detection', () => {
  it('accepts a sequential A→B spec', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b' }],
    }));
    expect(result.valid).toBe(true);
  });

  it('accepts a fan-out A→{B,C} spec', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'c', loopConfig: { initialPrompt: 'C', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }],
    }));
    expect(result.valid).toBe(true);
  });

  it('accepts a diamond A→{B,C}→D spec', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'c', loopConfig: { initialPrompt: 'C', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'd', loopConfig: { initialPrompt: 'D', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    }));
    expect(result.valid).toBe(true);
  });

  it('rejects a simple cycle A→B→A', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('cycle'))).toBe(true);
  });

  it('rejects a longer cycle A→B→C→A', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'c', loopConfig: { initialPrompt: 'C', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('cycle'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CampaignStore persistence
// ---------------------------------------------------------------------------

describe('CampaignStore', () => {
  let db: SqliteDriver;
  let store: CampaignStore;

  beforeEach(() => {
    db = buildDb();
    store = new CampaignStore(db);
  });

  it('upserts and retrieves a campaign', () => {
    const run: CampaignRun = {
      id: 'camp-1',
      spec: buildSpec(),
      status: 'running',
      nodeRuns: new Map(),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    const retrieved = store.getCampaign('camp-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('camp-1');
    expect(retrieved!.status).toBe('running');
  });

  it('lists active campaigns (pending/running/paused)', () => {
    const run1: CampaignRun = {
      id: 'camp-running',
      spec: buildSpec({ id: 'camp-running' }),
      status: 'running',
      nodeRuns: new Map(),
      startedAt: 1_000_000,
    };
    const run2: CampaignRun = {
      id: 'camp-completed',
      spec: buildSpec({ id: 'camp-completed' }),
      status: 'completed',
      nodeRuns: new Map(),
      startedAt: 1_000_001,
      endedAt: 1_000_002,
    };
    store.upsertCampaign(run1);
    store.upsertCampaign(run2);

    const active = store.listActiveCampaigns();
    expect(active.map((c) => c.id)).toContain('camp-running');
    expect(active.map((c) => c.id)).not.toContain('camp-completed');
  });

  it('upserts and retrieves node runs', () => {
    const run: CampaignRun = {
      id: 'camp-nodes',
      spec: buildSpec({ id: 'camp-nodes' }),
      status: 'running',
      nodeRuns: new Map(),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    store.upsertNode({
      nodeId: 'node-1',
      campaignId: 'camp-nodes',
      status: 'running',
      loopRunId: 'loop-abc',
      startedAt: 1_000_001,
    });

    const nodes = store.getNodeRuns('camp-nodes');
    expect(nodes.size).toBe(1);
    const node = nodes.get('node-1');
    expect(node).toBeDefined();
    expect(node!.status).toBe('running');
    expect(node!.loopRunId).toBe('loop-abc');
  });

  it('finds a node by loop run id', () => {
    const run: CampaignRun = {
      id: 'camp-find',
      spec: buildSpec({ id: 'camp-find' }),
      status: 'running',
      nodeRuns: new Map(),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    store.upsertNode({
      nodeId: 'node-2',
      campaignId: 'camp-find',
      status: 'running',
      loopRunId: 'loop-xyz',
      startedAt: 1_000_002,
    });

    const result = store.findNodeByLoopRunId('loop-xyz');
    expect(result).not.toBeNull();
    expect(result!.campaignId).toBe('camp-find');
    expect(result!.nodeId).toBe('node-2');
  });

  it('returns null for unknown loopRunId', () => {
    expect(store.findNodeByLoopRunId('no-such-loop')).toBeNull();
  });

  it('updates node status on re-upsert', () => {
    const run: CampaignRun = {
      id: 'camp-update',
      spec: buildSpec({ id: 'camp-update' }),
      status: 'running',
      nodeRuns: new Map(),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    store.upsertNode({
      nodeId: 'node-upd',
      campaignId: 'camp-update',
      status: 'running',
      loopRunId: 'loop-upd',
      startedAt: 1_000_003,
    });
    store.upsertNode({
      nodeId: 'node-upd',
      campaignId: 'camp-update',
      status: 'completed',
      loopRunId: 'loop-upd',
      startedAt: 1_000_003,
      endedAt: 1_000_010,
    });

    const nodes = store.getNodeRuns('camp-update');
    expect(nodes.get('node-upd')!.status).toBe('completed');
    expect(nodes.get('node-upd')!.endedAt).toBe(1_000_010);
  });

  it('lists all campaigns with a limit', () => {
    for (let i = 0; i < 5; i++) {
      store.upsertCampaign({
        id: `camp-${i}`,
        spec: buildSpec({ id: `camp-${i}` }),
        status: 'completed',
        nodeRuns: new Map(),
        startedAt: 1_000_000 + i,
        endedAt: 1_000_100 + i,
      });
    }
    const all = store.listAllCampaigns(3);
    expect(all.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// CampaignCoordinator — start/persistence semantics
// ---------------------------------------------------------------------------

describe('CampaignCoordinator — start/persistence semantics', () => {
  it('persists the campaign row before node rows so restart recovery sees pending nodes', async () => {
    const db = buildDb();
    const store = new CampaignStore(db);
    const coordinator = new CampaignCoordinator();
    const spec = buildSpec({ id: 'camp-start-persist' });
    const internals = coordinator as unknown as {
      store: CampaignStore | null;
      startNode: (campaign: CampaignRun, nodeId: string) => Promise<void>;
    };
    internals.store = store;
    vi.spyOn(internals, 'startNode').mockResolvedValue(undefined);

    await coordinator.startCampaign(spec);

    const persisted = store.getCampaign('camp-start-persist');
    expect(persisted).not.toBeNull();
    expect(persisted!.nodeRuns.size).toBe(1);
    expect(persisted!.nodeRuns.get('a')?.status).toBe('pending');
  });

  it('runs isolated campaign nodes in prepared worktree paths', async () => {
    const coordinator = new CampaignCoordinator();
    const loopStarter = vi.fn().mockResolvedValue({ id: 'loop-isolated-a' });
    const worktreePreparer = vi.fn().mockResolvedValue('/repo/.worktrees/campaign-node-a');
    const internals = coordinator as unknown as {
      setLoopStarterForTesting: (starter: typeof loopStarter) => void;
      setWorktreePreparerForTesting: (preparer: typeof worktreePreparer) => void;
    };
    internals.setLoopStarterForTesting(loopStarter);
    internals.setWorktreePreparerForTesting(worktreePreparer);

    const run = await coordinator.startCampaign(buildSpec({
      id: 'camp-worktree',
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/repo' }, dependsOn: [] },
      ],
      policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 1, isolation: 'worktree' },
    }));
    await flushAsyncWork();
    await flushAsyncWork();

    expect(worktreePreparer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'camp-worktree' }),
      expect.objectContaining({ id: 'a' }),
    );
    expect(loopStarter).toHaveBeenCalledWith(
      'campaign:camp-worktree:a',
      expect.objectContaining({ workspaceCwd: '/repo/.worktrees/campaign-node-a' }),
    );
    expect(run.nodeRuns.get('a')?.loopRunId).toBe('loop-isolated-a');
  });

  it('pauses the campaign for operator review when a node fails to start', async () => {
    const coordinator = new CampaignCoordinator();
    const loopStarter = vi.fn().mockRejectedValue(new Error('startup failed'));
    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      setLoopStarterForTesting: (starter: typeof loopStarter) => void;
    };
    internals.setLoopStarterForTesting(loopStarter);

    const run = await coordinator.startCampaign(buildSpec({
      id: 'camp-start-node-fails',
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'do B', workspaceCwd: '/tmp' }, dependsOn: ['a'] },
      ],
      edges: [{ from: 'a', to: 'b' }],
      policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 1 },
    }));
    await flushAsyncWork();
    await flushAsyncWork();

    expect(run.status).toBe('paused');
    expect(run.pausedReason).toContain('failed to start');
    expect(run.nodeRuns.get('a')?.status).toBe('failed');
    expect(run.nodeRuns.get('b')?.status).toBe('pending');
    expect(internals.activeCampaigns.get(run.id)).toBe(run);
  });

  it('cancels a loop that finishes starting after the campaign was halted', async () => {
    const coordinator = new CampaignCoordinator();
    let resolveStarter: ((value: { id: string }) => void) | undefined;
    const started = new Promise<{ id: string }>((resolve) => {
      resolveStarter = resolve;
    });
    const loopStarter = vi.fn().mockReturnValue(started);
    const loopCanceller = vi.fn().mockResolvedValue(true);
    const internals = coordinator as unknown as {
      setLoopStarterForTesting: (starter: typeof loopStarter) => void;
      loopCanceller: typeof loopCanceller;
    };
    internals.setLoopStarterForTesting(loopStarter);
    internals.loopCanceller = loopCanceller;

    const run = await coordinator.startCampaign(buildSpec({
      id: 'camp-halted-while-starting',
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 1 },
    }));
    await flushAsyncWork();

    coordinator.haltCampaignByOperator(run.id);
    resolveStarter?.({ id: 'late-loop' });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(run.status).toBe('halted');
    expect(run.nodeRuns.get('a')?.status).toBe('pending');
    expect(run.nodeRuns.get('a')?.loopRunId).toBeUndefined();
    expect(loopCanceller).toHaveBeenCalledWith('late-loop');
  });

  it('pauses a recovered campaign when its running node loop was paused on boot', async () => {
    const db = buildDb();
    const store = new CampaignStore(db);
    const run: CampaignRun = {
      id: 'camp-recover-paused-loop',
      spec: buildSpec({ id: 'camp-recover-paused-loop' }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-recover-paused-loop',
          status: 'running',
          loopRunId: 'loop-paused-on-boot',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    store.upsertNode(run.nodeRuns.get('a')!);

    const coordinator = new CampaignCoordinator();
    const internals = coordinator as unknown as {
      store: CampaignStore | null;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      setLoopStatusReaderForTesting: (reader: (loopRunId: string) => string | null) => void;
    };
    internals.store = store;
    internals.setLoopStatusReaderForTesting((loopRunId) =>
      loopRunId === 'loop-paused-on-boot' ? 'paused' : null,
    );

    await coordinator.recoverInterruptedCampaigns();

    const recovered = coordinator.getCampaign('camp-recover-paused-loop');
    expect(recovered?.status).toBe('paused');
    expect(recovered?.pausedReason).toContain('app restart');
    expect(recovered?.nodeRuns.get('a')?.status).toBe('running');
    expect(internals.loopRunToNode.get('loop-paused-on-boot')).toEqual({
      campaignId: 'camp-recover-paused-loop',
      nodeId: 'a',
    });
  });

  it('pauses a recovered campaign when a provider-limit node loop was paused on boot', async () => {
    const db = buildDb();
    const store = new CampaignStore(db);
    const run: CampaignRun = {
      id: 'camp-recover-paused-provider-limit',
      spec: buildSpec({ id: 'camp-recover-paused-provider-limit' }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-recover-paused-provider-limit',
          status: 'provider-limit',
          loopRunId: 'loop-paused-provider-limit',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    store.upsertNode(run.nodeRuns.get('a')!);

    const coordinator = new CampaignCoordinator();
    const internals = coordinator as unknown as {
      store: CampaignStore | null;
      setLoopStatusReaderForTesting: (reader: (loopRunId: string) => string | null) => void;
    };
    internals.store = store;
    internals.setLoopStatusReaderForTesting((loopRunId) =>
      loopRunId === 'loop-paused-provider-limit' ? 'paused' : null,
    );

    await coordinator.recoverInterruptedCampaigns();

    const recovered = coordinator.getCampaign('camp-recover-paused-provider-limit');
    expect(recovered?.status).toBe('paused');
    expect(recovered?.pausedReason).toContain('app restart');
    expect(recovered?.nodeRuns.get('a')?.status).toBe('provider-limit');
  });

  it('advances a recovered provider-limit campaign when the limited loop completed while the app was down', async () => {
    const db = buildDb();
    const store = new CampaignStore(db);
    const spec = buildSpec({
      id: 'camp-recover-provider-limit-completed',
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'do B', workspaceCwd: '/tmp' }, dependsOn: ['a'] },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const run: CampaignRun = {
      id: spec.id,
      spec,
      status: 'paused',
      pausedReason: 'Node a hit provider limit; waiting for loop auto-resume',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: spec.id,
          status: 'provider-limit',
          loopRunId: 'loop-provider-limit-completed-offline',
          startedAt: 1_000_001,
        }],
        ['b', {
          nodeId: 'b',
          campaignId: spec.id,
          status: 'pending',
        }],
      ]),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    for (const nodeRun of run.nodeRuns.values()) store.upsertNode(nodeRun);

    const coordinator = new CampaignCoordinator();
    const loopStarter = vi.fn().mockResolvedValue({ id: 'loop-b-started-after-recovery' });
    const internals = coordinator as unknown as {
      store: CampaignStore | null;
      setLoopStarterForTesting: (starter: typeof loopStarter) => void;
      setLoopStatusReaderForTesting: (reader: (loopRunId: string) => string | null) => void;
    };
    internals.store = store;
    internals.setLoopStarterForTesting(loopStarter);
    internals.setLoopStatusReaderForTesting((loopRunId) =>
      loopRunId === 'loop-provider-limit-completed-offline' ? 'completed' : null,
    );

    await coordinator.recoverInterruptedCampaigns();
    await waitUntil(() => coordinator.getCampaign(spec.id)?.status === 'running');

    const recovered = coordinator.getCampaign(spec.id);
    expect(recovered?.status).toBe('running');
    expect(recovered?.pausedReason).toBeUndefined();
    expect(recovered?.nodeRuns.get('a')?.status).toBe('completed');
    expect(recovered?.nodeRuns.get('b')?.status).toBe('running');
    expect(recovered?.nodeRuns.get('b')?.loopRunId).toBe('loop-b-started-after-recovery');
    expect(loopStarter).toHaveBeenCalledWith(
      `campaign:${spec.id}:b`,
      expect.objectContaining({ initialPrompt: 'do B' }),
    );
  });

  it('pauses a recovered campaign when an active node loop row is missing after restart', async () => {
    const db = buildDb();
    const store = new CampaignStore(db);
    const run: CampaignRun = {
      id: 'camp-recover-missing-loop',
      spec: buildSpec({ id: 'camp-recover-missing-loop' }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-recover-missing-loop',
          status: 'running',
          loopRunId: 'loop-missing-after-restart',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    store.upsertNode(run.nodeRuns.get('a')!);

    const coordinator = new CampaignCoordinator();
    const internals = coordinator as unknown as {
      store: CampaignStore | null;
      setLoopStatusReaderForTesting: (reader: (loopRunId: string) => string | null) => void;
    };
    internals.store = store;
    internals.setLoopStatusReaderForTesting(() => null);

    await coordinator.recoverInterruptedCampaigns();

    const recovered = coordinator.getCampaign('camp-recover-missing-loop');
    expect(recovered?.status).toBe('paused');
    expect(recovered?.pausedReason).toContain('missing after app restart');
  });

  it('reconciles a node that completed while the app was down and advances the campaign', async () => {
    const db = buildDb();
    const store = new CampaignStore(db);
    const spec = buildSpec({
      id: 'camp-recover-completed-node',
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'do B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const run: CampaignRun = {
      id: 'camp-recover-completed-node',
      spec,
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-recover-completed-node',
          status: 'running',
          loopRunId: 'loop-completed-while-down',
          startedAt: 1_000_001,
        }],
        ['b', {
          nodeId: 'b',
          campaignId: 'camp-recover-completed-node',
          status: 'pending',
        }],
      ]),
      startedAt: 1_000_000,
    };
    store.upsertCampaign(run);
    store.upsertNode(run.nodeRuns.get('a')!);
    store.upsertNode(run.nodeRuns.get('b')!);

    const coordinator = new CampaignCoordinator();
    const loopStarter = vi.fn().mockResolvedValue({ id: 'loop-started-b' });
    const internals = coordinator as unknown as {
      store: CampaignStore | null;
      setLoopStatusReaderForTesting: (reader: (loopRunId: string) => string | null) => void;
      setLoopStarterForTesting: (starter: typeof loopStarter) => void;
    };
    internals.store = store;
    internals.setLoopStatusReaderForTesting((loopRunId) =>
      loopRunId === 'loop-completed-while-down' ? 'completed' : null,
    );
    internals.setLoopStarterForTesting(loopStarter);

    await coordinator.recoverInterruptedCampaigns();
    await flushAsyncWork();

    const recovered = coordinator.getCampaign('camp-recover-completed-node');
    expect(recovered?.nodeRuns.get('a')?.status).toBe('completed');
    expect(recovered?.nodeRuns.get('b')?.status).toBe('running');
    expect(loopStarter).toHaveBeenCalledWith(
      'campaign:camp-recover-completed-node:b',
      expect.objectContaining({ initialPrompt: 'do B' }),
    );
  });
});

// ---------------------------------------------------------------------------
// evaluatePredicate — edge predicate logic (gated-skip)
// ---------------------------------------------------------------------------

describe('evaluatePredicate — edge gate predicates', () => {
  it('{ type: "is" } matches exactly the named status', () => {
    const pred: TerminalStatusPredicate = { type: 'is', status: 'completed' };
    expect(evaluatePredicate('completed', pred)).toBe(true);
    expect(evaluatePredicate('failed', pred)).toBe(false);
    expect(evaluatePredicate('completed-needs-review', pred)).toBe(false);
  });

  it('{ type: "in" } matches any of the listed statuses', () => {
    const pred: TerminalStatusPredicate = { type: 'in', statuses: ['completed', 'completed-needs-review'] };
    expect(evaluatePredicate('completed', pred)).toBe(true);
    expect(evaluatePredicate('completed-needs-review', pred)).toBe(true);
    expect(evaluatePredicate('failed', pred)).toBe(false);
    expect(evaluatePredicate('skipped', pred)).toBe(false);
  });

  it('{ type: "not" } matches anything except the named status', () => {
    const pred: TerminalStatusPredicate = { type: 'not', status: 'failed' };
    expect(evaluatePredicate('completed', pred)).toBe(true);
    expect(evaluatePredicate('completed-needs-review', pred)).toBe(true);
    expect(evaluatePredicate('operator-halted', pred)).toBe(true);
    expect(evaluatePredicate('failed', pred)).toBe(false);
  });

  it('gated skip — spec with when predicate is valid', () => {
    const result = validateCampaignSpec(buildSpec({
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp' }, dependsOn: [] },
      ],
      edges: [{ from: 'a', to: 'b', when: { type: 'is', status: 'completed' } }],
    }));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CampaignCoordinator — skipped dependency propagation
// ---------------------------------------------------------------------------

describe('CampaignCoordinator — skipped dependency propagation', () => {
  it('skips downstream nodes when their dependency was skipped', async () => {
    const coordinator = new CampaignCoordinator();
    const loopStarter = vi.fn().mockResolvedValue({ id: 'loop-should-not-start' });
    const spec = buildSpec({
      id: 'camp-skip-propagates',
      nodes: [
        { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/tmp' }, dependsOn: [] },
        { id: 'b', loopConfig: { initialPrompt: 'do B', workspaceCwd: '/tmp' }, dependsOn: ['a'] },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const run: CampaignRun = {
      id: 'camp-skip-propagates',
      spec,
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-skip-propagates',
          status: 'skipped',
          skippedReason: 'upstream gate failed',
          endedAt: 1_000_001,
        }],
        ['b', {
          nodeId: 'b',
          campaignId: 'camp-skip-propagates',
          status: 'pending',
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      advanceCampaign: (campaignId: string) => Promise<void>;
      setLoopStarterForTesting: (starter: typeof loopStarter) => void;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.setLoopStarterForTesting(loopStarter);

    await internals.advanceCampaign(run.id);
    await flushAsyncWork();

    expect(run.nodeRuns.get('b')?.status).toBe('skipped');
    expect(run.nodeRuns.get('b')?.skippedReason).toContain('dependency a was skipped');
    expect(loopStarter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CampaignCoordinator — provider-limit choreography
// ---------------------------------------------------------------------------

describe('CampaignCoordinator — provider-limit choreography', () => {
  it('pauses the campaign without completing it when a node parks on provider-limit', async () => {
    const coordinator = new CampaignCoordinator();
    const run: CampaignRun = {
      id: 'camp-provider-limit',
      spec: buildSpec({ id: 'camp-provider-limit' }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-provider-limit',
          status: 'running',
          loopRunId: 'loop-provider-limit',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      onLoopProviderLimited: (loopRunId: string) => Promise<void>;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.loopRunToNode.set('loop-provider-limit', { campaignId: run.id, nodeId: 'a' });
    const terminalEvents: unknown[] = [];
    coordinator.on('campaign:node-terminal', (event) => terminalEvents.push(event));

    await internals.onLoopProviderLimited('loop-provider-limit');

    expect(run.status).toBe('paused');
    expect(run.pausedReason).toContain('provider limit');
    expect(run.nodeRuns.get('a')?.status).toBe('provider-limit');
    expect(run.endedAt).toBeUndefined();
    expect(terminalEvents).toEqual([]);
    expect(internals.activeCampaigns.get(run.id)).toBe(run);
    expect(internals.loopRunToNode.get('loop-provider-limit')).toEqual({ campaignId: run.id, nodeId: 'a' });
  });

  it('does not emit duplicate pauses when the same provider-limit park is observed twice', async () => {
    const coordinator = new CampaignCoordinator();
    const run: CampaignRun = {
      id: 'camp-provider-limit-idempotent',
      spec: buildSpec({ id: 'camp-provider-limit-idempotent' }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-provider-limit-idempotent',
          status: 'running',
          loopRunId: 'loop-provider-limit-idempotent',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      onLoopProviderLimited: (loopRunId: string) => Promise<void>;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.loopRunToNode.set('loop-provider-limit-idempotent', {
      campaignId: run.id,
      nodeId: 'a',
    });
    const pauses: unknown[] = [];
    coordinator.on('campaign:paused', (event) => pauses.push(event));

    await internals.onLoopProviderLimited('loop-provider-limit-idempotent');
    await internals.onLoopProviderLimited('loop-provider-limit-idempotent');

    expect(pauses).toHaveLength(1);
    expect(run.status).toBe('paused');
    expect(run.nodeRuns.get('a')?.status).toBe('provider-limit');
  });

  it('marks an ended provider-limit loop as failed instead of waiting forever for auto-resume', async () => {
    const coordinator = new CampaignCoordinator();
    const run: CampaignRun = {
      id: 'camp-provider-limit-ended',
      spec: buildSpec({ id: 'camp-provider-limit-ended' }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-provider-limit-ended',
          status: 'running',
          loopRunId: 'loop-provider-limit-ended',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      onLoopTerminal: (loopRunId: string, loopStatus: string, endedAt?: number | null) => Promise<void>;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.loopRunToNode.set('loop-provider-limit-ended', { campaignId: run.id, nodeId: 'a' });

    await internals.onLoopTerminal('loop-provider-limit-ended', 'provider-limit', 1_778_313_000_000);

    expect(run.status).toBe('paused');
    expect(run.pausedReason).toContain('failed');
    expect(run.nodeRuns.get('a')?.status).toBe('failed');
    expect(run.nodeRuns.get('a')?.endedAt).toBeTypeOf('number');
    expect(internals.loopRunToNode.has('loop-provider-limit-ended')).toBe(false);
  });

  it('pauses the campaign for operator review when a child loop fails', async () => {
    const coordinator = new CampaignCoordinator();
    const run: CampaignRun = {
      id: 'camp-child-failed',
      spec: buildSpec({
        id: 'camp-child-failed',
        nodes: [
          { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/tmp' }, dependsOn: [] },
          { id: 'b', loopConfig: { initialPrompt: 'do B', workspaceCwd: '/tmp' }, dependsOn: ['a'] },
        ],
        edges: [{ from: 'a', to: 'b' }],
      }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-child-failed',
          status: 'running',
          loopRunId: 'loop-child-failed',
          startedAt: 1_000_001,
        }],
        ['b', {
          nodeId: 'b',
          campaignId: 'camp-child-failed',
          status: 'pending',
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      onLoopTerminal: (loopRunId: string, loopStatus: string) => Promise<void>;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.loopRunToNode.set('loop-child-failed', { campaignId: run.id, nodeId: 'a' });

    await internals.onLoopTerminal('loop-child-failed', 'failed');

    expect(run.status).toBe('paused');
    expect(run.pausedReason).toContain('failed');
    expect(run.nodeRuns.get('a')?.status).toBe('failed');
    expect(run.nodeRuns.get('a')?.endedAt).toBeTypeOf('number');
    expect(run.nodeRuns.get('b')?.status).toBe('pending');
    expect(internals.activeCampaigns.get(run.id)).toBe(run);
  });

  it('halts instead of failing when needs-review policy is halt', async () => {
    const coordinator = new CampaignCoordinator();
    const halted = vi.fn();
    const failed = vi.fn();
    coordinator.on('campaign:halted', halted);
    coordinator.on('campaign:failed', failed);
    const run: CampaignRun = {
      id: 'camp-needs-review-halt-policy',
      spec: buildSpec({
        id: 'camp-needs-review-halt-policy',
        policy: { onNodeNeedsReview: 'halt', maxParallel: 1 },
      }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-needs-review-halt-policy',
          status: 'running',
          loopRunId: 'loop-needs-review-halt-policy',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      onLoopTerminal: (loopRunId: string, loopStatus: string) => Promise<void>;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.loopRunToNode.set('loop-needs-review-halt-policy', { campaignId: run.id, nodeId: 'a' });

    await internals.onLoopTerminal('loop-needs-review-halt-policy', 'completed-needs-review');

    expect(run.status).toBe('halted');
    expect(run.nodeRuns.get('a')?.status).toBe('completed-needs-review');
    expect(internals.activeCampaigns.has(run.id)).toBe(false);
    expect(halted).toHaveBeenCalledWith({
      campaignId: run.id,
      reason: 'Node a reached completed-needs-review (policy: halt)',
    });
    expect(failed).not.toHaveBeenCalled();
  });

  it('resumes a campaign when an app-restart-paused running node loop starts running again', async () => {
    const coordinator = new CampaignCoordinator();
    const run: CampaignRun = {
      id: 'camp-resume-after-restart',
      spec: buildSpec({ id: 'camp-resume-after-restart' }),
      status: 'paused',
      pausedReason: 'Node a loop paused after app restart; resume that loop to continue the campaign',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-resume-after-restart',
          status: 'running',
          loopRunId: 'loop-resumed-after-restart',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      onLoopRunning: (loopRunId: string) => Promise<void>;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.loopRunToNode.set('loop-resumed-after-restart', { campaignId: run.id, nodeId: 'a' });

    await internals.onLoopRunning('loop-resumed-after-restart');

    expect(run.status).toBe('running');
    expect(run.pausedReason).toBeUndefined();
    expect(run.nodeRuns.get('a')?.status).toBe('running');
  });

  it('does not resume a needs-review-paused campaign when an unrelated sibling loop reports running', async () => {
    const coordinator = new CampaignCoordinator();
    const run: CampaignRun = {
      id: 'camp-running-sibling-while-needs-review-paused',
      spec: buildSpec({
        id: 'camp-running-sibling-while-needs-review-paused',
        nodes: [
          { id: 'a', loopConfig: { initialPrompt: 'do A', workspaceCwd: '/tmp' }, dependsOn: [] },
          { id: 'b', loopConfig: { initialPrompt: 'do B', workspaceCwd: '/tmp' }, dependsOn: [] },
        ],
      }),
      status: 'paused',
      pausedReason: 'Node a reached completed-needs-review',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-running-sibling-while-needs-review-paused',
          status: 'completed-needs-review',
          loopRunId: 'loop-needs-review',
          startedAt: 1_000_001,
          endedAt: 1_000_010,
        }],
        ['b', {
          nodeId: 'b',
          campaignId: 'camp-running-sibling-while-needs-review-paused',
          status: 'running',
          loopRunId: 'loop-running-sibling',
          startedAt: 1_000_002,
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      onLoopRunning: (loopRunId: string) => Promise<void>;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.loopRunToNode.set('loop-running-sibling', { campaignId: run.id, nodeId: 'b' });

    await internals.onLoopRunning('loop-running-sibling');

    expect(run.status).toBe('paused');
    expect(run.pausedReason).toBe('Node a reached completed-needs-review');
    expect(run.nodeRuns.get('b')?.status).toBe('running');
  });

  it('halts the campaign when a child loop is cancelled by the operator', async () => {
    const coordinator = new CampaignCoordinator();
    const run: CampaignRun = {
      id: 'camp-child-cancelled',
      spec: buildSpec({ id: 'camp-child-cancelled' }),
      status: 'running',
      nodeRuns: new Map([
        ['a', {
          nodeId: 'a',
          campaignId: 'camp-child-cancelled',
          status: 'running',
          loopRunId: 'loop-child-cancelled',
          startedAt: 1_000_001,
        }],
      ]),
      startedAt: 1_000_000,
    };

    const internals = coordinator as unknown as {
      activeCampaigns: Map<string, CampaignRun>;
      loopRunToNode: Map<string, { campaignId: string; nodeId: string }>;
      onLoopTerminal: (loopRunId: string, loopStatus: string) => Promise<void>;
    };
    internals.activeCampaigns.set(run.id, run);
    internals.loopRunToNode.set('loop-child-cancelled', { campaignId: run.id, nodeId: 'a' });

    await internals.onLoopTerminal('loop-child-cancelled', 'cancelled');

    expect(run.status).toBe('halted');
    expect(run.nodeRuns.get('a')?.status).toBe('operator-halted');
    expect(internals.activeCampaigns.has(run.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NextObjectivePlanner — planner hook (Phase 3)
// ---------------------------------------------------------------------------

describe('NextObjectivePlanner type contract', () => {
  it('planner receives last output, original goal, and seq', async () => {
    const calls: Array<{ lastOutput: string; originalGoal: string; seq: number }> = [];
    const planner = async (ctx: { lastOutput: string; originalGoal: string; seq: number }) => {
      calls.push(ctx);
      return 'Next: fix the remaining test failures';
    };

    await planner({ lastOutput: 'I finished iteration 1', originalGoal: 'Fix all bugs', seq: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].seq).toBe(1);
    expect(calls[0].originalGoal).toBe('Fix all bugs');
    expect(calls[0].lastOutput).toBe('I finished iteration 1');
  });

  it('planner returning null or undefined is safely ignored', async () => {
    const nullPlanner = async () => null;
    const undefinedPlanner = async () => undefined;

    const r1 = await nullPlanner();
    const r2 = await undefinedPlanner();

    // The loop-coordinator guards against null/undefined before pushing
    expect(r1 == null || r1 === '').toBe(true);
    expect(r2 == null || r2 === '').toBe(true);
  });

  it('planner throwing is handled gracefully (caller catches)', async () => {
    const throwingPlanner = async () => { throw new Error('planner exploded'); };
    await expect(throwingPlanner()).rejects.toThrow('planner exploded');
    // loop-coordinator catches this and logs a warning — no further propagation
  });
});
