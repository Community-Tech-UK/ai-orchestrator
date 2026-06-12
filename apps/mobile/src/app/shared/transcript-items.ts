import type { MobileMessageDto } from '../core/models';

const STAMP_GAP_MS = 15 * 60_000;

export type DisplayItem =
  | { kind: 'stamp'; id: string; label: string }
  | { kind: 'msg'; message: MobileMessageDto }
  | { kind: 'tools'; id: string; items: MobileMessageDto[] };

export function buildDisplayItems(
  messages: MobileMessageDto[],
  now = Date.now(),
): DisplayItem[] {
  const out: DisplayItem[] = [];
  let bucket: MobileMessageDto[] | null = null;
  let previousTimestamp: number | null = null;

  for (const message of messages) {
    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : 0;
    if (timestamp > 0 && shouldInsertStamp(timestamp, previousTimestamp)) {
      bucket = null;
      out.push({
        kind: 'stamp',
        id: `stamp-${message.id}-${timestamp}`,
        label: formatStampLabel(timestamp, now),
      });
    }

    if (timestamp > 0) {
      previousTimestamp = timestamp;
    }

    if (message.type === 'tool_use' || message.type === 'tool_result') {
      if (!bucket) {
        bucket = [];
        out.push({ kind: 'tools', id: `tools-${message.id}`, items: bucket });
      }
      bucket.push(message);
    } else {
      bucket = null;
      out.push({ kind: 'msg', message });
    }
  }

  return out;
}

export function formatStampLabel(ts: number, now: number): string {
  const date = new Date(ts);
  const current = new Date(now);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  if (sameLocalDate(date, current)) {
    return `Today ${time}`;
  }

  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  if (sameLocalDate(date, yesterday)) {
    return `Yesterday ${time}`;
  }

  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
  return `${day}, ${time}`;
}

function shouldInsertStamp(timestamp: number, previousTimestamp: number | null): boolean {
  if (previousTimestamp === null) {
    return true;
  }
  const previous = new Date(previousTimestamp);
  const current = new Date(timestamp);
  return timestamp - previousTimestamp > STAMP_GAP_MS || !sameLocalDate(previous, current);
}

function sameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
