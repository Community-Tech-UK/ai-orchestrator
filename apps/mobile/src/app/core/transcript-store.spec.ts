import { describe, expect, it, vi } from 'vitest';
import { TranscriptStore } from './transcript-store';
import type { MobileMessageDto, MobileMessagesResumeDto } from './models';

function message(id: string, seq: number): MobileMessageDto {
  return { id, seq, timestamp: seq, type: 'assistant', content: id };
}

describe('TranscriptStore generation boundaries', () => {
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
