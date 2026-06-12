import { describe, expect, it } from 'vitest';
import type { MobileMessageDto } from '../../../apps/mobile/src/app/core/models';
import {
  buildDisplayItems,
  formatStampLabel,
} from '../../../apps/mobile/src/app/shared/transcript-items';

function msg(
  id: string,
  timestamp: number,
  type: MobileMessageDto['type'] = 'assistant',
): MobileMessageDto {
  return {
    id,
    timestamp,
    type,
    content: id,
  };
}

function timeLabel(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

function dateLabel(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(ts));
}

describe('formatStampLabel', () => {
  it('labels today, yesterday, and older dates relative to now', () => {
    const now = new Date(2026, 5, 11, 14, 32).getTime();
    const yesterday = new Date(2026, 5, 10, 9, 5).getTime();
    const older = new Date(2026, 5, 8, 7, 45).getTime();

    expect(formatStampLabel(now, now)).toBe(`Today ${timeLabel(now)}`);
    expect(formatStampLabel(yesterday, now)).toBe(`Yesterday ${timeLabel(yesterday)}`);
    expect(formatStampLabel(older, now)).toBe(`${dateLabel(older)}, ${timeLabel(older)}`);
  });
});

describe('buildDisplayItems', () => {
  it('adds timestamp separators for the first valid message, large gaps, and day boundaries', () => {
    const now = new Date(2026, 5, 11, 14, 32).getTime();
    const first = new Date(2026, 5, 10, 23, 50).getTime();
    const sameCluster = new Date(2026, 5, 10, 23, 58).getTime();
    const nextDay = new Date(2026, 5, 11, 0, 3).getTime();
    const later = new Date(2026, 5, 11, 0, 20).getTime();

    const items = buildDisplayItems(
      [
        msg('zero', 0, 'system'),
        msg('first', first, 'user'),
        msg('same-cluster', sameCluster),
        msg('next-day', nextDay),
        msg('later', later),
      ],
      now,
    );

    expect(items.map((item) => item.kind)).toEqual([
      'msg',
      'stamp',
      'msg',
      'msg',
      'stamp',
      'msg',
      'stamp',
      'msg',
    ]);
    expect(items.filter((item) => item.kind === 'stamp').map((item) => item.label)).toEqual([
      `Yesterday ${timeLabel(first)}`,
      `Today ${timeLabel(nextDay)}`,
      `Today ${timeLabel(later)}`,
    ]);
  });

  it('keeps consecutive tool calls folded and splits tool groups when a stamp lands between them', () => {
    const now = new Date(2026, 5, 11, 14, 32).getTime();
    const first = new Date(2026, 5, 11, 14, 0).getTime();
    const second = new Date(2026, 5, 11, 14, 20).getTime();

    const items = buildDisplayItems(
      [
        msg('tool-1', first, 'tool_use'),
        msg('tool-2', first + 1_000, 'tool_result'),
        msg('tool-3', second, 'tool_use'),
      ],
      now,
    );

    expect(items.map((item) => item.kind)).toEqual(['stamp', 'tools', 'stamp', 'tools']);
    expect(items[1]).toMatchObject({ kind: 'tools', id: 'tools-tool-1' });
    expect(items[3]).toMatchObject({ kind: 'tools', id: 'tools-tool-3' });
  });
});
