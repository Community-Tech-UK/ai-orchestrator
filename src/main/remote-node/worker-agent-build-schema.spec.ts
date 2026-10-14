import { describe, expect, it } from 'vitest';
import { WorkerAgentBuildSummarySchema } from './worker-agent-build-schema';

const COMMIT = 'e'.repeat(40);

describe('WorkerAgentBuildSummarySchema', () => {
  it('keeps a well-formed build commit and update status', () => {
    const parsed = WorkerAgentBuildSummarySchema.parse({
      version: '0.1.0',
      startedAt: 1,
      buildCommit: COMMIT,
      autoUpdate: { state: 'restart_pending', targetCommit: COMMIT, reason: 'waiting', lastCheckedAt: 5 },
    });
    expect(parsed).toMatchObject({
      buildCommit: COMMIT,
      autoUpdate: { state: 'restart_pending', targetCommit: COMMIT },
    });
  });

  it('drops malformed diagnostics instead of rejecting the heartbeat', () => {
    const parsed = WorkerAgentBuildSummarySchema.parse({
      version: '0.1.0',
      startedAt: 1,
      buildCommit: 'not-a-commit',
      autoUpdate: { state: 'exploding' },
    });
    expect(parsed).toEqual({ version: '0.1.0', startedAt: 1 });
  });

  it('accepts the summary an older worker sends', () => {
    expect(WorkerAgentBuildSummarySchema.parse({ version: '0.1.0', startedAt: 1, hostBootedAt: 2 }))
      .toEqual({ version: '0.1.0', startedAt: 1, hostBootedAt: 2 });
  });
});
