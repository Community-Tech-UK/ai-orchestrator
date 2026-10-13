#!/usr/bin/env -S npx tsx
/** Headless evidence readiness seam, NOT a packaged window startup measurement. */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SqliteDriver, SqliteDriverFactory } from '../src/main/db/sqlite-driver';
import type { SafeStorageAccessor } from '../src/main/session/safe-storage-accessor';
import { ContextEvidenceLedgerStore } from '../src/main/conversation-ledger/context-evidence-ledger-store';
import { runConversationLedgerMigrations } from '../src/main/conversation-ledger/conversation-ledger-schema';
import type { EvidenceCaptureLedger } from '../src/main/context-evidence/evidence-capture-service';
import { EvidenceDeletionService, EVIDENCE_DELETION_GRACE_MS, type EvidenceDeletionLedger } from '../src/main/context-evidence/evidence-deletion-service';
import {
  EvidenceMaintenanceService, EVIDENCE_STAGING_STALE_MS,
  type EvidenceMaintenanceLedger, type ContextEvidenceRuntime,
  initializeContextEvidenceRuntime, getContextEvidenceRuntime,
  startContextEvidenceMaintenance, stopContextEvidenceMaintenance,
  _resetContextEvidenceRuntimeForTesting,
} from '../src/main/context-evidence/evidence-maintenance-service';
import { createContextEvidenceRuntime } from '../src/main/context-evidence/evidence-maintenance-runtime';
import { seedEvidenceMaintenanceFixture } from './evidence-maintenance-fixture';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Random, process-only wrapping key: no real keychain, credentials or plaintext blobs. */
function createIsolatedSafeStorage(): SafeStorageAccessor {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

type HarnessLedger = EvidenceCaptureLedger & EvidenceMaintenanceLedger & EvidenceDeletionLedger;

function asyncLedger(store: ContextEvidenceLedgerStore): HarnessLedger {
  return new Proxy(store, {
    get(target, property) {
      const member = Reflect.get(target, property);
      return typeof member === 'function'
        ? (...args: unknown[]) => Promise.resolve(Reflect.apply(member, target, args))
        : member;
    },
  }) as unknown as HarnessLedger;
}

const captureInput = (conversationId: string, captureKey: string) => ({
  conversationId, captureKey, provider: 'codex', toolName: 'placeholder-tool',
  sourceKind: 'other' as const, mimeType: 'text/plain', sensitivity: 'normal' as const,
  provenanceTrust: 'runtime-authenticated' as const, captureMode: 'post-retention' as const,
  captureCompleteness: 'complete' as const, observedBoundary: 'after-provider-retention' as const,
  content: new TextEncoder().encode('Synthetic evidence placeholder for isolated verification.'),
});

export interface IsolatedEvidenceStartupOptions {
  directory: string;
  rows?: number;
  driverFactory?: SqliteDriverFactory;
}

export async function runIsolatedEvidenceStartup(options: IsolatedEvidenceStartupOptions) {
  // A caller can choose the scratch parent, but the profile itself is ALWAYS new.
  await mkdir(options.directory, { recursive: true });
  const profile = await mkdtemp(join(options.directory, 'isolated-profile-'));
  // Lazy CJS resolution works with Electron RUN_AS_NODE + tsx/cjs and avoids
  // loading the Electron ABI native driver when tests inject the WASM backend.
  const factory: SqliteDriverFactory = options.driverFactory
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ?? (require('../src/main/db/better-sqlite3-driver') as typeof import('../src/main/db/better-sqlite3-driver')).defaultDriverFactory;
  const db: SqliteDriver = factory(join(profile, 'conversation-ledger.db'));
  const safeStorage = createIsolatedSafeStorage();
  const fixture = seedEvidenceMaintenanceFixture(db, { rows: options.rows, schemaVersion: 6 });
  const readiness: { launch: string; migrationMs: number; readinessMs: number }[] = [];
  const sweepEntered = deferred();
  const releaseSweep = deferred();
  const old = new Date(Date.now() - EVIDENCE_STAGING_STALE_MS - 60_000);
  const referenced: { conversationId: string; evidenceId: string; blobRef: string; digest: string }[] = [];
  let runtime!: ContextEvidenceRuntime;
  let store!: ContextEvidenceLedgerStore;
  let maintenanceStartedAt = 0;
  const createRuntime = async () => {
    store = new ContextEvidenceLedgerStore(db);
    const ledger = asyncLedger(store);
    return createContextEvidenceRuntime({ ledger, userDataPath: profile, safeStorage });
  };
  try {
    runtime = await createRuntime();
    // Real authenticated blobs across multiple conversation directories.
    for (let i = 0; i < 16; i++) {
      const conversationId = `placeholder-live-${i}`;
      db.prepare(`INSERT INTO conversation_threads (id, provider, source_kind, created_at, updated_at)
        VALUES (?, 'codex', 'orchestrator', 1, 1)`).run(conversationId);
      const captured = await runtime.captureService.capture(captureInput(conversationId, `fixture-${i}`));
      assert.equal(captured.status, 'captured');
      if (captured.status !== 'captured') throw new Error('FIXTURE_CAPTURE_FAILED');
      const row = store.getEvidence(conversationId, captured.record.id)!;
      referenced.push({ conversationId, evidenceId: row.id, blobRef: row.blobRef!, digest: row.keyedContentId! });
      await utimes(join(profile, 'conversation-evidence', row.blobRef!), old, old);
    }
    const prepared = store.stageEvidence({ ...captureInput(fixture.conversationId, 'prepared-recovery'), id: 'prepared-recovery' });
    await runtime.blobStore.write(fixture.conversationId, captureInput('', '').content, async (written) => {
      store.prepareEvidenceBlob({ evidenceId: prepared.id, conversationId: prepared.conversationId, ...written });
    });
    const orphan = await runtime.blobStore.write('placeholder-orphan', captureInput('', '').content);
    const orphanPath = join(profile, 'conversation-evidence', orphan.blobRef);
    await utimes(orphanPath, old, old);
    const recent = await runtime.blobStore.write('placeholder-recent', captureInput('', '').content);

    // Each generation revalidates the persisted keyring over the populated v6
    // fixture. This measures evidence readiness, not OS/process/window launch.
    for (let launch = 0; launch < 3; launch++) {
      const started = performance.now();
      const migrationStarted = performance.now();
      runConversationLedgerMigrations(db);
      const migrationMs = performance.now() - migrationStarted;
      runtime = await createRuntime();
      await initializeContextEvidenceRuntime(async () => runtime);
      assert.equal(getContextEvidenceRuntime(), runtime);
      const readinessMs = performance.now() - started;
      assert(readinessMs < 30_000, 'CLI evidence readiness exceeded 30 seconds');
      readiness.push({ launch: launch === 0 ? 'populated-v6-upgrade' : `migrated-${launch}`, migrationMs, readinessMs });
      if (launch < 2) {
        await stopContextEvidenceMaintenance();
        _resetContextEvidenceRuntimeForTesting();
      }
    }

    // Hold the actual maintenance ledger call, not the runtime initializer.
    const ledger = asyncLedger(store);
    const listRefs = ledger.listEvidenceBlobReferenceScanPage.bind(ledger);
    ledger.listEvidenceBlobReferenceScanPage = async (query) => {
      sweepEntered.resolve();
      await releaseSweep.promise;
      return listRefs(query);
    };
    runtime.maintenanceService = new EvidenceMaintenanceService({ ledger, blobStore: runtime.blobStore, keyManager: runtime.keyManager });
    maintenanceStartedAt = performance.now();
    startContextEvidenceMaintenance();
    startContextEvidenceMaintenance();
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([sweepEntered.promise, new Promise<never>((_, reject) => {
        // Keep this CLI alive while the production scheduler's unref timer waits.
        waitTimer = setTimeout(() => reject(new Error('MAINTENANCE_DID_NOT_START')), 15_000);
      })]);
    } finally {
      clearTimeout(waitTimer);
    }
    const capturedDuringSweep = await runtime.captureService.capture(captureInput(fixture.conversationId, 'during-sweep'));
    assert.equal(capturedDuringSweep.status, 'captured');
    if (capturedDuringSweep.status !== 'captured') throw new Error('CONCURRENT_CAPTURE_FAILED');
    const capturedRow = store.getEvidence(fixture.conversationId, capturedDuringSweep.record.id)!;
    const plaintext = await runtime.blobStore.read(capturedRow.blobRef!, capturedRow.keyedContentId!);
    assert.equal(Buffer.compare(Buffer.from(plaintext), Buffer.from(captureInput('', '').content)), 0);
    plaintext.fill(0);
    const deletionRef = referenced.pop()!;
    await runtime.deletionService.revokeConversation(deletionRef.conversationId);
    assert.equal(store.getEvidence(deletionRef.conversationId, deletionRef.evidenceId), null);
    assert.equal((await runtime.deletionService.runJanitor()).claimed, 0);
    releaseSweep.resolve();
    // stop cancels any remaining destruction; restart must safely finish it.
    await stopContextEvidenceMaintenance();
    assert.equal(await stat(orphanPath).then(() => true, () => false), true,
      'Cancelled sweep performed finalized orphan deletion');
    _resetContextEvidenceRuntimeForTesting();
    runtime = await createRuntime();
    await initializeContextEvidenceRuntime(async () => runtime);
    const restartSweepStarted = performance.now();
    const restartResult = await runtime.maintenanceService.reconcileStartup();
    const restartSweepMs = performance.now() - restartSweepStarted;
    for (const ref of referenced) {
      const bytes = await runtime.blobStore.read(ref.blobRef, ref.digest);
      assert.equal(Buffer.compare(Buffer.from(bytes), Buffer.from(captureInput('', '').content)), 0);
      bytes.fill(0);
    }
    assert.equal(store.getEvidence(prepared.conversationId, prepared.id)?.status, 'complete');
    const concurrentBytes = await runtime.blobStore.read(capturedRow.blobRef!, capturedRow.keyedContentId!);
    assert.equal(Buffer.compare(Buffer.from(concurrentBytes), Buffer.from(captureInput('', '').content)), 0);
    concurrentBytes.fill(0);
    assert.equal(await stat(orphanPath).then(() => true, () => false), false);
    assert.equal(await stat(join(profile, 'conversation-evidence', recent.blobRef)).then(() => true, () => false), true);
    assert.equal(await stat(join(profile, 'conversation-evidence', deletionRef.blobRef)).then(() => true, () => false), true);
    const janitor = new EvidenceDeletionService({ ledger, blobStore: runtime.blobStore,
      now: () => Date.now() + EVIDENCE_DELETION_GRACE_MS + 1000 });
    const deletion = await janitor.runJanitor();
    assert.equal(deletion.deleted, 1);
    assert.equal(deletion.failed, 0);
    const result = {
      mode: 'headless-cli-evidence-readiness-seam', packagedWindowVerified: false,
      profile, fixture, readiness,
      databaseBytes: await stat(join(profile, 'conversation-ledger.db')).then((file) => file.size, () => null),
      metadataCounts: {
        evidenceRecords: db.prepare('SELECT COUNT(*) AS count FROM evidence_records').get<{ count: number }>()!.count,
        evidenceCards: db.prepare('SELECT COUNT(*) AS count FROM evidence_cards').get<{ count: number }>()!.count,
        conversations: db.prepare('SELECT COUNT(*) AS count FROM conversation_threads').get<{ count: number }>()!.count,
      },
      encryptedFixtureBlobs: 19, encryptedFixtureDirectories: 19,
      encryptedReferencedBlobs: referenced.length, maintenanceMs: performance.now() - maintenanceStartedAt,
      restartSweepMs,
      capturedAndReadDuringSweep: true, preparedRecovered: true,
      staleOrphanRemoved: true, recentOrphanSurvived: true, referencedSurvived: true,
      stopRestartVerified: true, cancelledSweepPreventedDeletion: true, restartResult,
      deletionRevokedDuringSweep: true, deletionGraceProtected: true, deletion,
    };
    await writeFile(join(options.directory, 'startup-results.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    releaseSweep.resolve();
    await stopContextEvidenceMaintenance();
    _resetContextEvidenceRuntimeForTesting();
    db.close();
  }
}

if (require.main === module) {
  runIsolatedEvidenceStartup({ directory: join(process.cwd(), '_scratch/evidence-startup-delay/startup') })
    // eslint-disable-next-line no-console
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
