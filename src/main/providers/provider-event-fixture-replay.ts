import {
  mapAdapterRuntimeEvent,
  type AdapterRuntimeEventName,
  type MappedAdapterRuntimeEvent,
} from './adapter-runtime-event-bridge';

/** Sanitized adapter-event fixture record. One JSON object per JSONL line. */
export interface AdapterEventFixtureRecord {
  name: AdapterRuntimeEventName;
  args: unknown[];
}

/** Replay a recorded adapter-event fixture through the same pure mapper as runtime. */
export function replayAdapterEventFixture(
  records: readonly AdapterEventFixtureRecord[],
): MappedAdapterRuntimeEvent[] {
  const events: MappedAdapterRuntimeEvent[] = [];
  for (const record of records) {
    const mapped = mapAdapterRuntimeEvent(record.name, record.args);
    if (mapped) events.push(mapped);
  }
  return events;
}
