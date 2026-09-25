import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { MobileGatewayStreamCursor } from './mobile-gateway-stream-cursor';

function message(id: string, timestamp: number, content = id): OutputMessage {
  return { id, timestamp, type: 'assistant', content };
}

describe('MobileGatewayStreamCursor', () => {
  it('advances streamSeq only when a live output is recorded', () => {
    const cursor = new MobileGatewayStreamCursor();
    const buffer = [message('a', 1), message('b', 2)];

    expect(cursor.recordLive('session', buffer, buffer[0]).streamSeq).toBe(0);
    expect(cursor.inspect('session', buffer).nextStreamSeq).toBe(1);
    expect(cursor.recordLive('session', buffer, buffer[1]).streamSeq).toBe(1);
  });

  it('keeps absolute buffer cursors stable when the retained buffer trims', () => {
    const cursor = new MobileGatewayStreamCursor();
    const first = [message('a', 1), message('b', 2), message('c', 3)];
    expect(cursor.recordLive('session', first, first[2]).bufferIndex).toBe(2);

    const trimmed = [message('b-renumbered', 2, 'b'), message('c-renumbered', 3, 'c'), message('d', 4)];
    const live = cursor.recordLive('session', trimmed, trimmed[2]);

    expect(live.bufferIndex).toBe(3);
    expect(cursor.inspect('session', trimmed).offset).toBe(1);
  });

  it('detects a replaced buffer without trusting message ids', () => {
    const cursor = new MobileGatewayStreamCursor();
    const original = [message('same-id', 1, 'old')];
    cursor.recordLive('session', original, original[0]);

    const replacement = [message('same-id', 9, 'new')];
    const live = cursor.recordLive('session', replacement, replacement[0]);

    expect(live.bufferGeneration).toBe(1);
    expect(live.bufferIndex).toBe(0);
  });

  it('maps a raw streaming revision onto the buffered message by stable id', () => {
    const cursor = new MobileGatewayStreamCursor();
    const buffered = message('streaming-assistant', 100, 'accumulated text');
    const buffer = [message('user', 90), buffered];

    expect(cursor.recordLive('session', buffer, buffered).bufferIndex).toBe(1);

    const rawRevision = message('streaming-assistant', 101, ' next delta');
    const live = cursor.recordLive('session', buffer, rawRevision);

    expect(live.bufferIndex).toBe(1);
    expect(live.message).toBe(buffered);
    expect(live.bufferGeneration).toBe(0);
  });

  it('keeps the generation when a streaming revision finalizes before buffer growth', () => {
    const cursor = new MobileGatewayStreamCursor();
    const partial = [message('streaming', 100, 'partial')];
    cursor.recordLive('session', partial, partial[0]);

    const grown = [
      message('streaming', 100, 'final'),
      message('later', 200, 'later'),
    ];
    const view = cursor.inspect('session', grown);

    expect(view.bufferGeneration).toBe(0);
    expect(view.offset).toBe(0);
    expect(cursor.recordLive('session', grown, grown[1]).bufferIndex).toBe(1);
  });

  it('rotates the cursor epoch when gateway cursor state is cleared', () => {
    const cursor = new MobileGatewayStreamCursor();
    const buffer = [message('before-restart', 100)];
    const before = cursor.inspect('session', buffer) as { cursorEpoch?: string };

    cursor.clear();

    const after = cursor.inspect('session', buffer) as { cursorEpoch?: string };
    expect(before.cursorEpoch).toBeTypeOf('string');
    expect(after.cursorEpoch).toBeTypeOf('string');
    expect(after.cursorEpoch).not.toBe(before.cursorEpoch);
  });
});
