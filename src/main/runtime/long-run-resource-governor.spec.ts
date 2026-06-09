import { describe, expect, it } from 'vitest';
import { LongRunResourceGovernor } from './long-run-resource-governor';

describe('LongRunResourceGovernor', () => {
  it('allows normal loop progress when resources are healthy', () => {
    const governor = new LongRunResourceGovernor({
      warnRssBytes: 10_000,
      criticalRssBytes: 20_000,
      maxCodememDbBytes: 30_000,
      maxRlmDbBytes: 40_000,
    });
    expect(governor.evaluate({
      rssBytes: 5_000,
      codememDbBytes: 1_000,
      rlmDbBytes: 1_000,
      contextWorkerDegraded: false,
      indexWorkerDegraded: false,
    })).toEqual({ level: 'ok', actions: [], reasons: [] });
  });

  it('degrades optional context when RSS is above warning threshold', () => {
    const governor = new LongRunResourceGovernor({
      warnRssBytes: 10_000,
      criticalRssBytes: 20_000,
      maxCodememDbBytes: 30_000,
      maxRlmDbBytes: 40_000,
    });
    expect(governor.evaluate({
      rssBytes: 12_000,
      codememDbBytes: 1_000,
      rlmDbBytes: 1_000,
      contextWorkerDegraded: false,
      indexWorkerDegraded: false,
    })).toEqual({
      level: 'warn',
      actions: ['disable-warm-start', 'skip-optional-memory-context'],
      reasons: ['rss-above-warning'],
    });
  });

  it('pauses loops before critical memory exhaustion', () => {
    const governor = new LongRunResourceGovernor({
      warnRssBytes: 10_000,
      criticalRssBytes: 20_000,
      maxCodememDbBytes: 30_000,
      maxRlmDbBytes: 40_000,
    });
    expect(governor.evaluate({
      rssBytes: 22_000,
      codememDbBytes: 1_000,
      rlmDbBytes: 1_000,
      contextWorkerDegraded: false,
      indexWorkerDegraded: false,
    })).toEqual({
      level: 'critical',
      actions: ['pause-loop', 'disable-warm-start', 'skip-optional-memory-context'],
      reasons: ['rss-above-critical'],
    });
  });
});
