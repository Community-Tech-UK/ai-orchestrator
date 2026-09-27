import { beforeEach, describe, expect, it, vi } from 'vitest';

const { warn, info } = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ warn, info, error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../observability/lifecycle-trace', () => ({ recordLifecycleTrace: vi.fn() }));

import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { COMPACTION_STORM_PER_HOUR, ProviderCompactionLifecycleRecorder } from './provider-compaction-lifecycle';

const envelope = { instanceId: 'inst-1', provider: 'codex', sessionId: 'thread-1' } as ProviderRuntimeEventEnvelope;
// Offset from 0: a zero timestamp is treated as missing and replaced with now.
const BASE = 1_000_000;
const started = (offset: number) => ({
  id: `m-${offset}`, type: 'system' as const, timestamp: BASE + offset, content: 'compacting',
  metadata: { providerCompaction: 'started', providerCompactionTrigger: 'policy' },
});

describe('ProviderCompactionLifecycleRecorder storm canary', () => {
  beforeEach(() => { warn.mockClear(); info.mockClear(); });

  it('warns once compactions in the last hour exceed the storm threshold', () => {
    const recorder = new ProviderCompactionLifecycleRecorder();
    const minute = 60_000;
    for (let index = 0; index < COMPACTION_STORM_PER_HOUR; index += 1) recorder.record(envelope, started(index * minute), 'started');
    expect(warn).not.toHaveBeenCalled();

    recorder.record(envelope, started(COMPACTION_STORM_PER_HOUR * minute), 'started');
    expect(warn).toHaveBeenCalledWith('Codex compaction storm', {
      instanceId: 'inst-1', compactionsLastHour: COMPACTION_STORM_PER_HOUR + 1, trigger: 'policy',
    });
  });

  it('only counts the last hour', () => {
    const recorder = new ProviderCompactionLifecycleRecorder();
    const tenMinutes = 10 * 60_000;
    for (let index = 0; index < 20; index += 1) recorder.record(envelope, started(index * tenMinutes), 'started');
    expect(warn).not.toHaveBeenCalled();
  });
});
