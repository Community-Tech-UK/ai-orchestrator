import { EvidenceCaptureService, type EvidenceCaptureLedger } from './evidence-capture-service';
import { EvidenceDeletionService, type EvidenceDeletionLedger } from './evidence-deletion-service';
import { EvidenceMaintenanceService, type EvidenceMaintenanceLedger } from './evidence-maintenance-service';
import { EvidenceMaintenanceScheduler } from './evidence-maintenance-scheduler';
import { EncryptedEvidenceBlobStore } from './encrypted-evidence-blob-store';
import { EvidenceKeyManager } from './evidence-key-manager';
import { getSafeStorage } from '../session/safe-storage-accessor';
import { registerCleanup } from '../util/cleanup-registry';
import { getLogger } from '../logging/logger';
import type { SafeStorageAccessor } from '../session/safe-storage-accessor';

export interface ContextEvidenceRuntime {
  keyManager: EvidenceKeyManager;
  blobStore: EncryptedEvidenceBlobStore;
  captureService: EvidenceCaptureService;
  maintenanceService: EvidenceMaintenanceService;
  deletionService: EvidenceDeletionService;
}

const logger = getLogger('ContextEvidenceRuntime');
let runtime: ContextEvidenceRuntime | null = null;
let initialization: Promise<void> | null = null;
let scheduler: EvidenceMaintenanceScheduler | null = null;
let unregisterCleanup: (() => void) | null = null;
let generation = 0;
let stopped = false;

/** Keyring validation and construction are readiness; bulk recovery is background work. */
export async function initializeContextEvidenceRuntime(
  createRuntime: () => Promise<ContextEvidenceRuntime> = createDefaultRuntime,
): Promise<void> {
  if (stopped) throw new Error('CONTEXT_EVIDENCE_RUNTIME_STOPPED');
  if (runtime) return;
  if (!initialization) {
    const currentGeneration = generation;
    const startedAt = performance.now();
    const pending = (async () => {
      const created = await createRuntime();
      if (stopped || currentGeneration !== generation) {
        await created.deletionService.stop();
        throw new Error('CONTEXT_EVIDENCE_RUNTIME_STOPPED');
      }
      const maintenance = new EvidenceMaintenanceScheduler(async (signal) => {
        await created.maintenanceService.reconcileStartup(signal);
        signal.throwIfAborted();
        await created.deletionService.runJanitor(100, signal);
        signal.throwIfAborted();
        created.deletionService.startJanitorScheduler();
      });
      unregisterCleanup = registerCleanup(async () => {
        maintenance.abort();
        created.deletionService.stopJanitorScheduler();
        await maintenance.stop();
        await created.deletionService.stop();
      });
      scheduler = maintenance;
      runtime = created;
      logger.info('Context evidence runtime ready', { durationMs: performance.now() - startedAt });
    })();
    initialization = pending;
    void pending.catch(() => {
      if (initialization === pending) initialization = null;
    });
  }
  await initialization;
}

export function getContextEvidenceRuntime(): ContextEvidenceRuntime {
  if (!runtime || stopped) throw new Error('CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE');
  return runtime;
}

export function startContextEvidenceMaintenance(): void {
  if (!stopped) scheduler?.start();
}

/** Called synchronously at quit entry, before shutdown starts closing resources. */
export function abortContextEvidenceMaintenance(): void {
  stopped = true;
  generation += 1;
  scheduler?.abort();
  runtime?.deletionService.stopJanitorScheduler();
}

export async function stopContextEvidenceMaintenance(): Promise<void> {
  abortContextEvidenceMaintenance();
  await scheduler?.stop();
  await runtime?.deletionService.stop();
  await initialization?.catch(() => undefined);
}

export function _resetContextEvidenceRuntimeForTesting(): void {
  abortContextEvidenceMaintenance();
  unregisterCleanup?.();
  unregisterCleanup = null;
  runtime = null;
  initialization = null;
  scheduler = null;
  stopped = false;
}

async function createDefaultRuntime(): Promise<ContextEvidenceRuntime> {
  // Lazy resolution keeps imports usable outside Electron and preserves keyring failure semantics.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConversationLedgerService } = require('../conversation-ledger') as typeof import('../conversation-ledger');
  return createContextEvidenceRuntime({
    ledger: getConversationLedgerService(),
    userDataPath: app.getPath('userData'),
    safeStorage: getSafeStorage(),
  });
}

/** Construct the same encrypted runtime for production and isolated headless hosts. */
export async function createContextEvidenceRuntime(options: {
  ledger: EvidenceCaptureLedger & EvidenceMaintenanceLedger & EvidenceDeletionLedger;
  userDataPath: string;
  safeStorage: SafeStorageAccessor;
}): Promise<ContextEvidenceRuntime> {
  const { ledger, userDataPath, safeStorage } = options;
  const keyManager = new EvidenceKeyManager({
    userDataPath, safeStorage,
  });
  await keyManager.initialize();
  // A keyring alone does not establish durable capture availability. This
  // empty bounded RPC waits for worker migration/readiness without enumerating
  // metadata, and preserves the existing deadline and unavailable IPC mode if
  // the ledger cannot open. The self-quitting smoke must not certify that case.
  await ledger.listReferencedEvidenceBlobRefsForCandidates([]);
  const blobStore = new EncryptedEvidenceBlobStore({ userDataPath, keyManager });
  const captureService = new EvidenceCaptureService({ ledger, blobStore });
  const maintenanceService = new EvidenceMaintenanceService({
    ledger, blobStore, keyManager,
    isCaptureActive: (row) => captureService.isCapturing(row.conversationId, row.captureKey),
  });
  const deletionService = new EvidenceDeletionService({ ledger, blobStore });
  return { keyManager, blobStore, captureService, maintenanceService, deletionService };
}
