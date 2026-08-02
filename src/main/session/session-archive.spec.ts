/**
 * SessionArchiveManager spec.
 *
 * This module had no spec at all. It is added for one narrow reason: LT-018.
 * `archiveSession` used to rebuild `contextUsage` field-by-field
 * (`{used, total, costEstimate}`), silently dropping `occupancyReported` and
 * `percentage` — so a restored archive could not tell a real measurement from
 * the create-time placeholder. That is the same field-by-field rebuild that
 * caused the live defect in the continuity-persistence path.
 *
 * The archive path is currently dormant (nothing reads `ArchivedSession` back),
 * which is exactly why it needs a test: a dormant bug is one that ships.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';

const writes = new Map<string, string>();

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/aio-archive-spec' },
}));

vi.mock('node:fs', () => {
  const existsSync = (): boolean => false;
  return {
    default: {
      existsSync,
      mkdirSync: vi.fn(),
      writeFileSync: (p: string, data: string) => { writes.set(String(p), String(data)); },
      readFileSync: () => '{}',
    },
    existsSync,
    mkdirSync: vi.fn(),
    writeFileSync: (p: string, data: string) => { writes.set(String(p), String(data)); },
    readFileSync: () => '{}',
  };
});

function makeInstance(contextUsage: Instance['contextUsage']): Instance {
  return {
    id: 'inst-archive-1',
    displayName: 'Archived',
    provider: 'claude',
    status: 'idle',
    workingDirectory: '/repo',
    createdAt: 1,
    lastActivity: 2,
    parentId: null,
    outputBuffer: [],
    contextUsage,
  } as unknown as Instance;
}

function archivedPayload(): { contextUsage: Record<string, unknown> } {
  const entry = [...writes.entries()].find(([p]) => p.endsWith('inst-archive-1.json'));
  if (!entry) throw new Error('archive file was never written');
  return JSON.parse(entry[1]) as { contextUsage: Record<string, unknown> };
}

describe('SessionArchiveManager.archiveSession contextUsage (LT-018)', () => {
  beforeEach(() => {
    writes.clear();
    vi.resetModules();
  });

  it('archives the whole ContextUsage, preserving occupancyReported', async () => {
    const { SessionArchiveManager } = await import('./session-archive');
    new SessionArchiveManager().archiveSession(
      makeInstance({
        used: 124_000, total: 200_000, percentage: 62, costEstimate: 4.25, occupancyReported: true,
      }),
    );

    expect(archivedPayload().contextUsage).toMatchObject({
      used: 124_000,
      total: 200_000,
      percentage: 62,
      costEstimate: 4.25,
      occupancyReported: true,
    });
  });

  it('does not invent occupancy for a session that never reported', async () => {
    const { SessionArchiveManager } = await import('./session-archive');
    new SessionArchiveManager().archiveSession(
      makeInstance({ used: 0, total: 200_000, percentage: 0 }),
    );

    expect(archivedPayload().contextUsage['occupancyReported']).toBeUndefined();
  });
});
