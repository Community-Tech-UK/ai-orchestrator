import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultDriverFactory } from '../src/main/db/better-sqlite3-driver';
import type { EvidenceBlobReferenceScanPage } from '../src/main/conversation-ledger/context-evidence-ledger.types';
import { ContextEvidenceLedgerStore } from '../src/main/conversation-ledger/context-evidence-ledger-store';
import { runConversationLedgerMigrations } from '../src/main/conversation-ledger/conversation-ledger-schema';
import { seedEvidenceMaintenanceFixture } from './evidence-maintenance-fixture';

const reuse = process.env['EVIDENCE_BENCH_REUSE'] === '1';
const scratchRoot = resolve('_scratch/evidence-startup-delay/query');
mkdirSync(scratchRoot, { recursive: true });
const explicitOutput = process.env['EVIDENCE_BENCH_DIR'];
if (reuse && !explicitOutput) throw new Error('Reuse requires an explicit isolated fixture directory');
const output = explicitOutput ? resolve(explicitOutput) : mkdtempSync(join(scratchRoot, 'native-'));
mkdirSync(output, { recursive: true });
const dbPath = join(output, 'fixture.db');
if (!reuse && existsSync(dbPath)) throw new Error('Fresh benchmark refuses an existing database; choose a new directory');
if (reuse && !existsSync(dbPath)) throw new Error('Reuse requires an existing isolated fixture database');
const retained = reuse ? JSON.parse(readFileSync(join(output, 'baseline.json'), 'utf8')) as {
  fixture: ReturnType<typeof seedEvidenceMaintenanceFixture>;
  seededMs: number;
  baselinePlan: unknown[];
  baseline: ReturnType<typeof traverse>;
} : undefined;
const db = defaultDriverFactory(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const started = performance.now();
const fixture = retained?.fixture ?? seedEvidenceMaintenanceFixture(db, { schemaVersion: 6 });
const seededMs = retained?.seededMs ?? performance.now() - started;
const original = `SELECT blob_ref FROM (
  SELECT evidence_records.blob_ref AS blob_ref FROM evidence_records
  JOIN conversation_threads ON conversation_threads.id = evidence_records.conversation_id
  WHERE evidence_records.blob_ref IS NOT NULL AND evidence_records.status <> 'deleted'
    AND conversation_threads.deleted_at IS NULL
  UNION SELECT evidence_cards.blob_ref AS blob_ref FROM evidence_cards
  JOIN conversation_threads ON conversation_threads.id = evidence_cards.conversation_id
  WHERE evidence_cards.blob_ref IS NOT NULL AND conversation_threads.deleted_at IS NULL
  UNION SELECT blob_ref FROM evidence_deletion_queue WHERE completed_at IS NULL
) WHERE (? IS NULL OR blob_ref > ?) ORDER BY blob_ref ASC LIMIT ?`;
const originalStatement = db.prepare(original);
function traverse(fetch: (cursor?: string) => string[] | EvidenceBlobReferenceScanPage) {
  const began = performance.now();
  const pages: { count: number; durationMs: number }[] = [];
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const pageStart = performance.now();
    const page = fetch(cursor);
    const refs = Array.isArray(page) ? page : page.blobRefs;
    pages.push({ count: refs.length, durationMs: performance.now() - pageStart });
    count += refs.length;
    if (Array.isArray(page) ? !refs.length : page.done) break;
    cursor = Array.isArray(page) ? refs.at(-1) : page.afterBlobRef;
    if (cursor === undefined) throw new Error('Nonfinal scan page lacks its raw cursor');
  }
  return { count, durationMs: performance.now() - began, pages,
    peakMemoryKb: process.resourceUsage().maxRSS };
}
const baselinePlan = retained?.baselinePlan ?? db.prepare(`EXPLAIN QUERY PLAN ${original}`).all(null, null, 1000);
process.stdout.write((reuse
  ? 'Reusing isolated native fixture and retained original traversal'
  : 'Seeded native fixture; measuring original traversal') + '\n');
const baseline = retained?.baseline ?? traverse(cursor => originalStatement
  .all<{ blob_ref: string }>(cursor ?? null, cursor ?? null, 1000).map(row => row.blob_ref));
if (!reuse) {
  writeFileSync(join(output, 'baseline.json'), JSON.stringify({ fixture, seededMs, baselinePlan, baseline }, null, 2));
}
const alreadyMigrated = db.prepare('SELECT version FROM conversation_ledger_migrations WHERE version = 7').get() !== undefined;
const migrationStart = performance.now();
runConversationLedgerMigrations(db);
const migrationDurationMs = performance.now() - migrationStart;
const migrationTiming = { kind: alreadyMigrated ? 'already-migrated-check' : 'v6-upgrade', durationMs: migrationDurationMs };
const store = new ContextEvidenceLedgerStore(db);
const plans: unknown[] = [];
const observed = Object.create(db) as typeof db;
observed.prepare = (sql: string) => {
  if (sql.includes('blob_ref AS blob_ref') && !sql.includes('SELECT DISTINCT') && plans.length < 6) {
    const params = sql.includes('blob_ref > ?') ? ['placeholder/card-0200000.aioev', 1000] : [1000];
    plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
  }
  return db.prepare(sql);
};
const observedStore = new ContextEvidenceLedgerStore(observed);
observedStore.listEvidenceBlobReferenceScanPage({ limit: 1000 });
observedStore.listEvidenceBlobReferenceScanPage({ afterBlobRef: 'placeholder/card-0200000.aioev', limit: 1000 });
const compatibilityUnion = traverse(cursor => store.listReferencedEvidenceBlobRefs({ afterBlobRef: cursor, limit: 1000 }));
const improved = traverse(cursor => store.listEvidenceBlobReferenceScanPage({ afterBlobRef: cursor, limit: 1000 }));
const repeatedStart = performance.now();
runConversationLedgerMigrations(db);
const repeatedMigrationMs = performance.now() - repeatedStart;
const result = { mode: reuse ? 'reuse-retained-baseline' : 'fresh-v6-fixture',
  baselineSource: reuse ? join(output, 'baseline.json') : 'measured-in-this-run-before-upgrade',
  fixture, seededMs, baselinePlan, baseline, migrationTiming, repeatedMigrationMs, plans, improved, compatibilityUnion,
  improvedPath: 'maintenance-raw-scan-with-bounded-live-candidate-checks',
  compatibilityUnionLimitation: 'Exact legacy API may scan deleted-owner histories repeatedly; startup maintenance uses raw scan pages instead',
  speedup: baseline.durationMs / improved.durationMs };
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
db.close();
process.stdout.write(JSON.stringify({ output, baselineMs: baseline.durationMs, improvedMs: improved.durationMs,
  mode: result.mode, migrationTiming, repeatedMigrationMs, speedup: result.speedup, count: improved.count }) + '\n');
