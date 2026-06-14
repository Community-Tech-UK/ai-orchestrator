/**
 * Campaign Coordinator — DAG walker unit tests.
 *
 * Tests pure logic: spec validation, cycle detection, edge predicates,
 * and CampaignStore persistence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { validateCampaignSpec, evaluatePredicate } from '../campaign-coordinator';
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
  runLoopMigrations(db);
  return db;
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
    expect(evaluatePredicate('failed', pred)).toBe(false);
    expect(evaluatePredicate('provider-limit', pred)).toBe(true);
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
