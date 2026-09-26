import { describe, expect, it, vi } from 'vitest';
import { TranscriptStore } from './transcript-store';
import type { MobileMessageDto, MobileMessagesResumeDto } from './models';

function message(id: string, seq: number): MobileMessageDto {
  return { id, seq, timestamp: seq, type: 'assistant', content: id };
}

describe('TranscriptStore generation boundaries', () => {
  it('accepts the first cursor epoch on a fresh full transcript load', async () => {
    const store = new TranscriptStore();
    let fullRequests = 0;

    await store.loadMessages('session', async () => {
      fullRequests += 1;
      return {
        messages: [message('initial', 0)],
        meta: {
          fromSeq: -1,
          returned: 1,
          hasMore: false,
          maxSeq: 0,
          streamSeq: 0,
          bufferGeneration: 0,
          adapterGeneration: 1,
          cursorEpoch: 'first-gateway-epoch',
        },
      };
    }, () => true);

    expect(fullRequests).toBe(1);
    expect(store.messageStateFor('session').status).toBe('loaded');
    expect(store.messagesFor('session').map((item) => item.id)).toEqual(['initial']);
  });

  it('retries an initial full transcript superseded by the first live cursor epoch', async () => {
    const store = new TranscriptStore();
    let finishStale!: (payload: MobileMessagesResumeDto) => void;
    const stale = new Promise<MobileMessagesResumeDto>((resolve) => { finishStale = resolve; });
    let fullRequests = 0;
    const loading = store.loadMessages('session', async () => {
      fullRequests += 1;
      if (fullRequests === 1) return stale;
      return {
        messages: [message('current-live-generation', 0)],
        meta: {
          fromSeq: -1,
          returned: 1,
          hasMore: false,
          maxSeq: 0,
          streamSeq: 0,
          bufferGeneration: 0,
          adapterGeneration: 1,
          cursorEpoch: 'current-gateway-epoch',
        },
      };
    }, () => true);

    await vi.waitFor(() => expect(fullRequests).toBe(1));
    store.applyOutput('session', {
      legacySeq: 1,
      streamSeq: 0,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
      cursorEpoch: 'current-gateway-epoch',
    }, message('current-live-generation', 0));
    finishStale({
      messages: [message('stale-initial-load', 0)],
      meta: {
        fromSeq: -1,
        returned: 1,
        hasMore: false,
        maxSeq: 0,
        streamSeq: 0,
        bufferGeneration: 0,
        adapterGeneration: 1,
        cursorEpoch: 'stale-gateway-epoch',
      },
    });
    await loading;

    expect(fullRequests).toBe(2);
    expect(store.messageStateFor('session').status).toBe('loaded');
    expect(store.messagesFor('session').map((item) => item.id))
      .toEqual(['current-live-generation']);
  });

  it('retries a full transcript when a live frame changes an established cursor epoch', async () => {
    const store = new TranscriptStore();
    store.applyOutput('session', {
      legacySeq: 1,
      streamSeq: 0,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
      cursorEpoch: 'gateway-before-restart',
    }, message('before-restart', 0));

    let finishStale!: (payload: MobileMessagesResumeDto) => void;
    const stale = new Promise<MobileMessagesResumeDto>((resolve) => { finishStale = resolve; });
    let fullRequests = 0;
    const loading = store.loadMessages('session', async () => {
      fullRequests += 1;
      if (fullRequests === 1) return stale;
      return {
        messages: [message('after-restart', 0)],
        meta: {
          fromSeq: -1,
          returned: 1,
          hasMore: false,
          maxSeq: 0,
          streamSeq: 0,
          bufferGeneration: 0,
          adapterGeneration: 1,
          cursorEpoch: 'gateway-after-restart',
        },
      };
    }, () => true);

    await vi.waitFor(() => expect(fullRequests).toBe(1));
    store.applyOutput('session', {
      legacySeq: 1,
      streamSeq: 0,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
      cursorEpoch: 'gateway-after-restart',
    }, message('after-restart', 0));
    finishStale({
      messages: [message('stale-before-restart', 0)],
      meta: {
        fromSeq: -1,
        returned: 1,
        hasMore: false,
        maxSeq: 0,
        streamSeq: 0,
        bufferGeneration: 0,
        adapterGeneration: 1,
        cursorEpoch: 'gateway-before-restart',
      },
    });
    await loading;

    expect(fullRequests).toBe(2);
    expect(store.messageStateFor('session').status).toBe('loaded');
    expect(store.messagesFor('session').map((item) => item.id)).toEqual(['after-restart']);
  });

  it('accepts a new generation first revealed by incremental replay', async () => {
    const store = new TranscriptStore();
    store.applyOutput('session', {
      legacySeq: 1, streamSeq: 1, bufferIndex: 0, bufferGeneration: 1, adapterGeneration: 1,
    }, message('old', 0));
    let fullRequests = 0;

    await store.resumeMessages('session', async () => ({
      messages: [],
      meta: {
        fromSeq: 0, returned: 0, hasMore: false, maxSeq: 0,
        bufferGeneration: 2, adapterGeneration: 2,
      },
    }), async () => {
      fullRequests += 1;
      return {
        messages: [message('replacement', 0)],
        meta: {
          fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0, streamSeq: 0,
          bufferGeneration: 2, adapterGeneration: 2,
        },
      };
    }, () => true);

    expect(fullRequests).toBe(1);
    expect(store.messageStateFor('session').status).toBe('loaded');
    expect(store.messagesFor('session').map((item) => item.id)).toEqual(['replacement']);
  });

  it('uses a full transcript watermark to detect the next missing live frame', async () => {
    const store = new TranscriptStore();

    await store.loadMessages('session', async () => ({
      messages: [message('loaded', 0)],
      meta: {
        fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0, streamSeq: 10,
        bufferGeneration: 1, adapterGeneration: 1,
      },
    }), () => true);

    expect(store.applyOutput('session', {
      legacySeq: 12, streamSeq: 12, bufferIndex: 0, bufferGeneration: 1, adapterGeneration: 1,
    }, message('updated', 0))).toBe('resume');
  });

  it('uses an incremental replay watermark to detect the next missing live frame', async () => {
    const store = new TranscriptStore();
    store.applyOutput('session', {
      legacySeq: 10, streamSeq: 10, bufferIndex: 0, bufferGeneration: 1, adapterGeneration: 1,
    }, message('initial', 0));

    await store.resumeMessages('session', async () => ({
      messages: [message('replayed', 0)],
      meta: {
        fromSeq: 0, returned: 1, hasMore: false, maxSeq: 0, streamSeq: 12,
        bufferGeneration: 1, adapterGeneration: 1,
      },
    }), async () => [], () => true);

    expect(store.applyOutput('session', {
      legacySeq: 13, streamSeq: 13, bufferIndex: 1, bufferGeneration: 1, adapterGeneration: 1,
    }, message('next', 1))).toBeNull();
  });

  it('ignores a delayed live frame already covered by an HTTP replay', async () => {
    const store = new TranscriptStore();
    store.applyOutput('session', {
      legacySeq: 10, streamSeq: 10, bufferIndex: 0, bufferGeneration: 1, adapterGeneration: 1,
    }, { ...message('assistant', 0), content: 'live before replay' });

    await store.resumeMessages('session', async () => ({
      messages: [{ ...message('assistant', 0), content: 'authoritative replay' }],
      meta: {
        fromSeq: 0, returned: 1, hasMore: false, maxSeq: 0, streamSeq: 12,
        bufferGeneration: 1, adapterGeneration: 1,
      },
    }), async () => [], () => true);

    const recovery = store.applyOutput('session', {
      legacySeq: 11, streamSeq: 11, bufferIndex: 0, bufferGeneration: 1, adapterGeneration: 1,
    }, { ...message('assistant', 0), content: 'stale delayed frame' });

    expect(recovery).toBeNull();
    expect(store.messagesFor('session')[0]?.content).toBe('authoritative replay');
    expect(store.applyOutput('session', {
      legacySeq: 13, streamSeq: 13, bufferIndex: 1, bufferGeneration: 1, adapterGeneration: 1,
    }, message('next', 1))).toBeNull();
  });

  it('accepts the first valid frame after the gateway cursor epoch changes', () => {
    const store = new TranscriptStore();
    const beforeRestart = {
      legacySeq: 10,
      streamSeq: 10,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
      cursorEpoch: 'gateway-before-restart',
    };
    store.applyOutput('session', beforeRestart, message('old', 0));

    const afterRestart = {
      legacySeq: 1,
      streamSeq: 0,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
      cursorEpoch: 'gateway-after-restart',
    };
    const recovery = store.applyOutput('session', afterRestart, message('new', 0));

    expect(recovery).toBe('full');
    expect(store.messagesFor('session').map((item) => item.id)).toEqual(['old', 'new']);
  });

  it('treats the first epoch from an upgraded gateway as a generation boundary', () => {
    const store = new TranscriptStore();
    store.applyOutput('session', {
      legacySeq: 10,
      streamSeq: 10,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
    }, message('from-legacy-gateway', 0));

    const recovery = store.applyOutput('session', {
      legacySeq: 1,
      streamSeq: 0,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
      cursorEpoch: 'first-epoch-after-upgrade',
    }, message('from-upgraded-gateway', 0));

    expect(recovery).toBe('full');
    expect(store.messagesFor('session').map((item) => item.id))
      .toEqual(['from-legacy-gateway', 'from-upgraded-gateway']);
  });

  it('resets the replay watermark when HTTP first observes a gateway epoch', async () => {
    const store = new TranscriptStore();
    store.applyOutput('session', {
      legacySeq: 10,
      streamSeq: 10,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
    }, message('from-legacy-gateway', 0));
    let fullRequests = 0;

    await store.resumeMessages('session', async () => ({
      messages: [],
      meta: {
        fromSeq: 0,
        returned: 0,
        hasMore: false,
        maxSeq: 0,
        streamSeq: 0,
        bufferGeneration: 0,
        adapterGeneration: 1,
        cursorEpoch: 'first-epoch-after-upgrade',
      },
    }), async () => {
      fullRequests += 1;
      return {
        messages: [message('authoritative-after-upgrade', 0)],
        meta: {
          fromSeq: -1,
          returned: 1,
          hasMore: false,
          maxSeq: 0,
          streamSeq: 0,
          bufferGeneration: 0,
          adapterGeneration: 1,
          cursorEpoch: 'first-epoch-after-upgrade',
        },
      };
    }, () => true);

    expect(fullRequests).toBe(1);
    expect(store.messagesFor('session').map((item) => item.id))
      .toEqual(['authoritative-after-upgrade']);
    expect(store.applyOutput('session', {
      legacySeq: 2,
      streamSeq: 1,
      bufferIndex: 1,
      bufferGeneration: 0,
      adapterGeneration: 1,
      cursorEpoch: 'first-epoch-after-upgrade',
    }, message('next-after-upgrade', 1))).toBeNull();
  });

  it('retries a full replay fallback superseded by a newer live generation', async () => {
    const store = new TranscriptStore();
    store.applyOutput('session', {
      legacySeq: 1, streamSeq: 0, bufferIndex: 0, bufferGeneration: 1, adapterGeneration: 1,
    }, message('generation-1', 0));

    let finishStale!: (payload: MobileMessagesResumeDto) => void;
    const stale = new Promise<MobileMessagesResumeDto>((resolve) => { finishStale = resolve; });
    let fullRequests = 0;
    const recovering = store.resumeMessages(
      'session',
      async () => ({
        messages: [],
        meta: {
          fromSeq: 0, returned: 0, hasMore: true, maxSeq: 0,
          bufferGeneration: 1, adapterGeneration: 1,
        },
      }),
      async () => {
        fullRequests += 1;
        if (fullRequests === 1) return stale;
        return {
          messages: [message('generation-3-live', 0)],
          meta: {
            fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0,
            bufferGeneration: 3, adapterGeneration: 3,
          },
        };
      },
      () => true,
    );

    await vi.waitFor(() => expect(fullRequests).toBe(1));
    store.applyOutput('session', {
      legacySeq: 2, streamSeq: 0, bufferIndex: 0, bufferGeneration: 3, adapterGeneration: 3,
    }, message('generation-3-live', 0));
    finishStale({
      messages: [message('stale-generation-2', 0)],
      meta: {
        fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0,
        bufferGeneration: 2, adapterGeneration: 2,
      },
    });
    await recovering;

    expect(fullRequests).toBe(2);
    expect(store.messagesFor('session').map((item) => item.id)).toEqual(['generation-3-live']);
    expect(store.resumeFromBufferIndex('session')).toBe(0);
  });
});

describe('TranscriptStore older pages', () => {
  const page = (start: number, end: number): MobileMessagesResumeDto => ({
    messages: Array.from({ length: end - start }, (_, i) => message(`m${start + i}`, start + i)),
    meta: { fromSeq: -1, returned: end - start, maxSeq: end - 1, nextBeforeSeq: start,
      hasMore: start > 0, streamSeq: 999, bufferGeneration: 1, adapterGeneration: 1 },
  });

  it.each([
    { recovery: 'full refresh', start: 0, total: 1000 },
    { recovery: 'full refresh', start: 700, total: 2000 },
    { recovery: 'incremental fallback', start: 0, total: 1000 },
    { recovery: 'incremental fallback', start: 700, total: 2000 },
  ])('pages every message after a disjoint $recovery from $start to $total', async ({ recovery, start, total }) => {
    const store = new TranscriptStore();
    const cached = page(start, start + 300);
    cached.meta.streamSeq = start + 299;
    await store.loadMessages('a', async () => cached, () => true);
    const latest = page(total - 300, total);
    latest.meta.streamSeq = total - 1;
    if (recovery === 'full refresh') {
      await store.loadMessages('a', async () => latest, () => true);
    } else {
      const incomplete = page(start + 299, start + 599);
      incomplete.meta = { ...incomplete.meta, fromSeq: start + 299, hasMore: true, streamSeq: total - 1 };
      await store.resumeMessages('a', async () => incomplete, async () => latest, () => true);
    }
    const requested: number[] = [];
    for (let attempt = 0; attempt < 20 && store.hasEarlierFor('a'); attempt++) {
      await store.loadEarlier('a', async before => {
        requested.push(before);
        const older = page(Math.max(0, before - 100), before);
        older.meta.streamSeq = total - 1;
        return older;
      }, () => true);
    }
    expect(store.messagesFor('a')).toHaveLength(total);
    expect(store.messagesFor('a').map(item => item.seq)).toEqual(Array.from({ length: total }, (_, seq) => seq));
    expect(new Set(store.messagesFor('a').map(item => item.id)).size).toBe(total);
    expect(requested).toEqual(Array.from({ length: (total - 300) / 100 }, (_, i) => total - 300 - i * 100));
    expect(store.hasEarlierFor('a')).toBe(false);
    expect(store.resumeFromBufferIndex('a')).toBe(total - 1);
  });

  it('does not mistake a lone newer live frame for coverage of the gap before a full refresh', async () => {
    const store = new TranscriptStore();
    const cached = page(0, 300);
    cached.meta.streamSeq = 299;
    await store.loadMessages('a', async () => cached, () => true);
    store.applyOutput('a', { legacySeq: 701, streamSeq: 700, bufferIndex: 700,
      bufferGeneration: 1, adapterGeneration: 1 }, message('m700', 700));
    await store.loadMessages('a', async () => page(700, 1000), () => true);
    expect(store.messagesFor('a')[0].seq).toBe(700);
    expect(store.hasEarlierFor('a')).toBe(true);
    const requested: number[] = [];
    await store.loadEarlier('a', async before => { requested.push(before); return page(before - 100, before); }, () => true);
    expect(requested).toEqual([700, 600]);
    expect(store.messagesFor('a')[0].seq).toBe(500);
  });

  it('retains overlapping authoritative coverage even when filtered records leave sequence holes', async () => {
    const store = new TranscriptStore();
    const cached = page(0, 300);
    cached.messages = cached.messages.filter(item => item.seq !== 199 && item.seq !== 200);
    await store.loadMessages('a', async () => cached, () => true);
    await store.loadMessages('a', async () => page(200, 500), () => true);
    expect(store.messagesFor('a').map(item => item.seq)).toEqual(Array.from({ length: 500 }, (_, seq) => seq).filter(seq => seq !== 199));
    expect(store.hasEarlierFor('a')).toBe(false);
  });

  it('does not retain a prefix from the old generation after a live frame changes the current cursor', async () => {
    const store = new TranscriptStore();
    await store.loadMessages('a', async () => page(0, 300), () => true);
    store.applyOutput('a', { legacySeq: 1, streamSeq: 0, bufferIndex: 200,
      bufferGeneration: 2, adapterGeneration: 2 }, message('replacement-live', 200));
    const replacement = page(200, 500);
    replacement.meta = { ...replacement.meta, bufferGeneration: 2, adapterGeneration: 2 };
    await store.loadMessages('a', async () => replacement, () => true);
    expect(store.messagesFor('a')).toHaveLength(300);
    expect(store.messagesFor('a')[0].seq).toBe(200);
    expect(store.hasEarlierFor('a')).toBe(true);
  });

  it.each(['before replay', 'after replay', 'rejected after replay'])('releases a superseded older-page request that settles %s', async (order) => {
    const store = new TranscriptStore();
    await store.loadMessages('a', async () => page(700, 1000), () => true);
    let finishOlder!: (value: MobileMessagesResumeDto) => void;
    let rejectOlder!: (error: Error) => void;
    const older = store.loadEarlier('a', () => new Promise((resolve, reject) => {
      finishOlder = resolve; rejectOlder = reject;
    }), () => true);
    let finishReplay!: (value: MobileMessagesResumeDto) => void;
    const replaying = store.resumeMessages('a', () => new Promise(resolve => { finishReplay = resolve; }), async () => [], () => true);
    const replay = page(1000, 1002);
    replay.meta = { ...replay.meta, fromSeq: 999, hasMore: false, streamSeq: 1001 };
    if (order === 'before replay') { finishOlder(page(600, 700)); await older; }
    finishReplay(replay);
    await replaying;
    if (order === 'after replay') finishOlder(page(600, 700));
    if (order === 'rejected after replay') rejectOlder(new Error('Old page unavailable'));
    await older;
    expect(store.earlierStateFor('a').status).not.toBe('loading');
    expect(store.earlierStateFor('a').error ?? '').toContain('refreshed');
    expect(store.messagesFor('a')[0].seq).toBe(700);
    await store.loadEarlier('a', async before => page(before - 100, before), () => true);
    expect(store.messagesFor('a')[0].seq).toBe(500);
    expect(store.messagesFor('a')).toHaveLength(502);
    expect(store.resumeFromBufferIndex('a')).toBe(1001);
  });

  it('does not clear a replacement instance generation’s pending older-page request', async () => {
    const store = new TranscriptStore();
    await store.loadMessages('a', async () => page(700, 1000), () => true);
    let finishOld!: (value: MobileMessagesResumeDto) => void;
    const old = store.loadEarlier('a', () => new Promise(resolve => { finishOld = resolve; }), () => true);
    store.dropInstance('a');
    const replacement = page(300, 600);
    replacement.meta.bufferGeneration = 2;
    await store.loadMessages('a', async () => replacement, () => true);
    let finishNew!: (value: MobileMessagesResumeDto) => void;
    const fresh = store.loadEarlier('a', () => new Promise(resolve => { finishNew = resolve; }), () => true);
    finishOld(page(600, 700)); await old;
    expect(store.earlierStateFor('a').status).toBe('loading');
    expect(store.messagesFor('a')[0].seq).toBe(300);
    const newPage = page(200, 300);
    newPage.meta = { ...newPage.meta, bufferGeneration: 2, hasMore: false };
    finishNew(newPage); await fresh;
    expect(store.earlierStateFor('a').status).toBe('loaded');
    expect(store.hasEarlierFor('a')).toBe(false);
    expect(store.messagesFor('a')[0].seq).toBe(200);
  });

  it('continues past collapsed activity until a page supplies 150 display items', async () => {
    const store = new TranscriptStore();
    await store.loadMessages('a', async () => page(700, 1000), () => true);
    const requested: number[] = [];
    await store.loadEarlier('a', async before => {
      requested.push(before);
      const result = page(before - 100, before);
      if (before > 500) result.messages = result.messages.map(item => ({ ...item, type: 'tool_use' }));
      return result;
    }, () => true);
    expect(requested).toEqual([700, 600, 500, 400]);
  });

  it('prepends enough history for 150 more display items without regressing the live cursor', async () => {
    const store = new TranscriptStore();
    await store.loadMessages('a', async () => page(700, 1000), () => true);
    expect(store.hasEarlierFor('a')).toBe(true);
    const requested: number[] = [];
    await store.loadEarlier('a', async before => { requested.push(before); return page(before - 100, before); }, () => true);
    expect(requested).toEqual([700, 600]);
    expect(store.messagesFor('a')).toHaveLength(500);
    expect(store.messagesFor('a')[0].seq).toBe(500);
    expect(store.resumeFromBufferIndex('a')).toBe(999);
    expect(store.earlierStateFor('a').status).toBe('loaded');
    await store.loadMessages('a', async () => page(700, 1000), () => true);
    expect(store.messagesFor('a')[0].seq).toBe(500);
  });

  it('does not duplicate a pending page request or apply it after instance removal', async () => {
    const store = new TranscriptStore();
    await store.loadMessages('a', async () => page(700, 1000), () => true);
    let finish!: (payload: MobileMessagesResumeDto) => void;
    const request = vi.fn(() => new Promise<MobileMessagesResumeDto>(resolve => { finish = resolve; }));
    const pending = store.loadEarlier('a', request, () => true);
    await store.loadEarlier('a', request, () => true);
    expect(request).toHaveBeenCalledTimes(1);
    store.dropInstance('a');
    finish(page(600, 700));
    await pending;
    expect(store.messagesFor('a')).toEqual([]);
    expect(store.hasEarlierFor('a')).toBe(false);
  });

  it('retains current messages on page failure and permits retry', async () => {
    const store = new TranscriptStore();
    await store.loadMessages('a', async () => page(100, 400), () => true);
    await store.loadEarlier('a', async () => { throw new Error('Page unavailable'); }, () => true);
    expect(store.messagesFor('a')).toHaveLength(300);
    expect(store.earlierStateFor('a').error).toBe('Page unavailable');
    await store.loadEarlier('a', async () => page(0, 100), () => true);
    expect(store.messagesFor('a')).toHaveLength(400);
    expect(store.hasEarlierFor('a')).toBe(false);
  });

  it('rejects older pages from a different transcript generation', async () => {
    const store = new TranscriptStore();
    await store.loadMessages('a', async () => page(700, 1000), () => true);
    await store.loadEarlier('a', async () => {
      const changed = page(600, 700); changed.meta.bufferGeneration = 2; return changed;
    }, () => true);
    expect(store.messagesFor('a')[0].seq).toBe(700);
    expect(store.earlierStateFor('a').status).toBe('error');
  });
});
