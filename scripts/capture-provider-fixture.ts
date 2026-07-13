#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactValue } from '../src/main/diagnostics/redaction';
import type { ProviderEventCaptureRecord } from '../src/main/conversation-ledger/provider-event-capture.types';
import type { AdapterEventFixtureRecord } from '../src/main/providers/provider-event-fixture-replay';

interface CaptureRow {
  event_id: string;
  provider: ProviderEventCaptureRecord['provider'];
  instance_id: string;
  session_id: string | null;
  sequence: number;
  created_at: number;
  event_json: string;
  raw_source: string;
  raw_json: string;
}

export interface ProviderFixtureFiles {
  fixtureJsonl: string;
  goldenJsonl: string;
}

/**
 * Convert durable capture records to checked-in JSONL fixture text. The caller
 * owns persistence; this pure step redacts before anything reaches disk.
 */
export function buildProviderFixtureFiles(
  captures: readonly ProviderEventCaptureRecord[],
): ProviderFixtureFiles {
  const fixture: AdapterEventFixtureRecord[] = [];
  const golden: unknown[] = [];
  for (const capture of captures) {
    const record = fixtureRecordFromCapture(capture);
    if (record) fixture.push(redactValue(record));
    golden.push(redactValue(capture.event));
  }
  return {
    fixtureJsonl: toJsonLines(fixture),
    goldenJsonl: toJsonLines(golden),
  };
}

function fixtureRecordFromCapture(capture: ProviderEventCaptureRecord): AdapterEventFixtureRecord | null {
  const name = capture.raw.source.startsWith('adapter-event:')
    ? capture.raw.source.slice('adapter-event:'.length)
    : null;
  if (!name || !isAdapterEventName(name)) return null;
  if (name === 'exit') {
    const value = capture.raw.payload as { code?: unknown; signal?: unknown } | null;
    return { name, args: [value?.code ?? null, value?.signal ?? null] };
  }
  return { name, args: [capture.raw.payload] };
}

function isAdapterEventName(value: string): value is AdapterEventFixtureRecord['name'] {
  return [
    'output', 'tool_use', 'tool_result', 'status', 'context',
    'error', 'complete', 'exit', 'spawned',
  ].includes(value);
}

function toJsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

function readCaptureRows(dbPath: string, instanceId: string, limit: number): ProviderEventCaptureRecord[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT event_id, provider, instance_id, session_id, sequence, created_at,
             event_json, raw_source, raw_json
      FROM provider_event_captures
      WHERE instance_id = ?
      ORDER BY created_at ASC, sequence ASC
      LIMIT ?
    `).all(instanceId, limit).map((row) => {
      const capture = row as CaptureRow;
      const raw = JSON.parse(capture.raw_json) as { payload?: unknown };
      return {
        eventId: capture.event_id,
        provider: capture.provider,
        instanceId: capture.instance_id,
        sessionId: capture.session_id,
        sequence: capture.sequence,
        createdAt: capture.created_at,
        event: JSON.parse(capture.event_json) as ProviderEventCaptureRecord['event'],
        raw: { source: capture.raw_source, payload: raw.payload },
      };
    });
  } finally {
    db.close();
  }
}

function parseArgs(argv: string[]): { dbPath: string; instanceId: string; scenario: string; limit: number } {
  const valueFor = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dbPath = valueFor('--db');
  const instanceId = valueFor('--instance');
  const scenario = valueFor('--scenario');
  const limit = Number(valueFor('--limit') ?? 1_000);
  if (!dbPath || !instanceId || !scenario || !Number.isFinite(limit) || limit < 1) {
    throw new Error('Usage: tsx scripts/capture-provider-fixture.ts --db <conversation-ledger.db> --instance <id> --scenario <name> [--limit <n>]');
  }
  return { dbPath, instanceId, scenario, limit: Math.min(Math.floor(limit), 10_000) };
}

function main(): void {
  const { dbPath, instanceId, scenario, limit } = parseArgs(process.argv.slice(2));
  const captures = readCaptureRows(resolve(dbPath), instanceId, limit);
  if (captures.length === 0) throw new Error(`No provider event captures found for instance ${instanceId}`);
  const { fixtureJsonl, goldenJsonl } = buildProviderFixtureFiles(captures);
  const outputDir = join(
    process.cwd(),
    'packages/contracts/src/__fixtures__/provider-events',
    captures[0]!.provider,
  );
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, `${scenario}.jsonl`), fixtureJsonl, 'utf8');
  writeFileSync(join(outputDir, `${scenario}.golden.jsonl`), goldenJsonl, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
