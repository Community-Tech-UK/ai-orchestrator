import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEvidenceLedger } from './__fixtures__/incident-replay-ledger';
import { createFakeSafeStorage } from './__fixtures__/incident-replay-harness';
import {
  createContextEvidenceRuntime, initializeContextEvidenceRuntime, getContextEvidenceRuntime,
  _resetContextEvidenceRuntimeForTesting,
} from './evidence-maintenance-runtime';

describe('production evidence runtime construction', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'evidence-runtime-construction-')); });
  afterEach(async () => {
    _resetContextEvidenceRuntimeForTesting();
    await rm(directory, { recursive: true, force: true });
  });

  it('awaits ledger readiness with an empty bounded RPC and never enumerates references', async () => {
    const ledger = new InMemoryEvidenceLedger();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const check = vi.spyOn(ledger, 'listReferencedEvidenceBlobRefsForCandidates').mockImplementation(async (refs) => {
      expect(refs).toEqual([]);
      entered();
      await pending;
      return [];
    });
    const enumerate = vi.spyOn(ledger, 'listReferencedEvidenceBlobRefs');
    const scan = vi.spyOn(ledger, 'listEvidenceBlobReferenceScanPage');
    const initialization = initializeContextEvidenceRuntime(() => createContextEvidenceRuntime({
      ledger, userDataPath: directory, safeStorage: createFakeSafeStorage(),
    }));
    await ready;
    expect(() => getContextEvidenceRuntime()).toThrow('CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE');
    release();
    await initialization;
    expect(getContextEvidenceRuntime().captureService).toBeDefined();
    expect(check).toHaveBeenCalledOnce();
    expect(enumerate).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it('keeps durable capture unavailable when the worker readiness request fails', async () => {
    const ledger = new InMemoryEvidenceLedger();
    vi.spyOn(ledger, 'listReferencedEvidenceBlobRefsForCandidates').mockRejectedValue(new Error('FIXTURE_LEDGER_UNAVAILABLE'));
    await expect(initializeContextEvidenceRuntime(() => createContextEvidenceRuntime({
      ledger, userDataPath: directory, safeStorage: createFakeSafeStorage(),
    }))).rejects.toThrow('FIXTURE_LEDGER_UNAVAILABLE');
    expect(() => getContextEvidenceRuntime()).toThrow('CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE');
  });

  it('validates encryption before making even the empty ledger readiness request', async () => {
    const ledger = new InMemoryEvidenceLedger();
    const check = vi.spyOn(ledger, 'listReferencedEvidenceBlobRefsForCandidates');
    await expect(createContextEvidenceRuntime({
      ledger, userDataPath: directory, safeStorage: createFakeSafeStorage(false),
    })).rejects.toMatchObject({ code: 'SAFE_STORAGE_UNAVAILABLE' });
    expect(check).not.toHaveBeenCalled();
  });
});
