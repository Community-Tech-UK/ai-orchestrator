/**
 * Task 18 governed incident replay: the plan's master proof test.
 *
 * Drives the REAL capture -> card -> working-set -> retrieval -> accuracy-gate
 * pipeline over the frozen Phase 0 manifest against a temp user-data
 * directory, and proves every item in the plan's Acceptance Checklist that is
 * agent-runnable (the renderer/provider-live items are out of scope here).
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextPressureSample } from '@contracts/types/context-evidence';
import {
  ContextSafetyPolicy,
  createInitialContextSafetyPolicyState,
} from './context-safety-policy';
import {
  createFakeSafeStorage,
  createIncidentReplayServices,
  PROVIDER_CAPABILITY_MATRIX,
  readIncidentManifest,
  runIncidentReplay,
} from './__fixtures__/incident-replay-harness';
import { expandIncidentManifest } from './__fixtures__/incident-replay-manifest';

describe('governed context-evidence incident replay', () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'aio-incident-replay-'));
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  it('freezes the manifest shape the replay depends on', () => {
    const { manifest } = readIncidentManifest();
    const calls = expandIncidentManifest(manifest);
    const totalCharacters = calls.reduce((sum, call) => sum + call.result.length, 0);

    expect(calls).toHaveLength(44);
    expect(calls.filter((call) => call.externalizable)).toHaveLength(25);
    expect(totalCharacters).toBe(900_532);
  });

  // Real AES-256-GCM + fsync-per-blob capture over 44 records is I/O bound
  // (~8s locally); give it headroom above the default 5s test timeout.
  it('preserves byte-for-byte evidence, builds inspectable cards, bounds the working set, and retrieves exact citations with truthful metrics', async () => {
    const { manifest } = readIncidentManifest();
    const services = createIncidentReplayServices({ userDataPath });

    const result = await runIncidentReplay(services, manifest);

    expect(result.totalCalls).toBe(44);
    expect(result.externalizableCount).toBe(25);
    expect(result.totalResultCharacters).toBe(900_532);
    expect(result.captured).toHaveLength(44);
    expect(result.captured.every((call) => call.roundTripEqual)).toBe(true);
    expect(result.cardsBuilt).toBe(25);

    // Truthful metrics: the ledger's own record count/byte sum must match what was replayed.
    const records = services.ledger.allRecords();
    expect(records).toHaveLength(44);
    expect(records.reduce((sum, record) => sum + record.byteCount, 0)).toBe(900_532);
    expect(records.every((record) => record.status === 'complete')).toBe(true);

    // Working set stays within the declared allocation / normal 60% ceiling.
    expect(result.workingSet.governedTokens).toBeLessThanOrEqual(
      Math.floor(manifest.incident.contextWindowTokens * 0.6),
    );

    // Exact authenticated retrieval of a cited range.
    expect(result.sampleCitation.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    const verify = await services.retrievalService.verify({
      requester: { id: 'test', path: 'local', localSensitiveAuthorized: true, localRestrictedAuthorized: true },
      conversationId: result.conversationId,
      evidenceId: result.sampleCitation.evidenceId,
      startByte: result.sampleCitation.startByte,
      endByte: result.sampleCitation.endByte,
      contentDigest: result.sampleCitation.contentDigest,
    });
    expect(verify.verified).toBe(true);

    // The accuracy gate passes the cited claim.
    expect(result.accuracyGateVerdict).toBe('pass');
  }, 30_000);

  // Same I/O-bound replay as above; see the comment there.
  it('measures at least a 60% cumulative-input reduction under enforce while the accuracy gate still passes', async () => {
    const { manifest } = readIncidentManifest();
    const services = createIncidentReplayServices({ userDataPath });

    const result = await runIncidentReplay(services, manifest);

    expect(result.workingSet.baselineCumulativeInputTokens).toBe(5_693_312);
    expect(result.workingSet.reductionPercent).toBeGreaterThanOrEqual(0.6);
    expect(result.workingSet.cumulativeReductionPercent).toBeGreaterThanOrEqual(0.6);
    expect(result.workingSet.governedCumulativeInputTokens).toBeLessThan(
      result.workingSet.baselineCumulativeInputTokens,
    );
    expect(result.accuracyGateVerdict).toBe('pass');
  }, 30_000);

  it('never duplicates evidence across a simulated restart mid-capture', async () => {
    const services = createIncidentReplayServices({ userDataPath });
    const conversationId = 'restart-conversation';
    const content = new TextEncoder().encode('restart-mid-capture fixture payload');

    // Simulate a crash: stage + prepare (write the blob) but never finalize.
    const staged = await services.ledger.stageEvidence({
      conversationId,
      provider: 'codex',
      toolName: 'shell-file-database',
      sourceKind: 'command',
      mimeType: 'text/plain',
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      captureKey: 'restart:call-0',
    });
    const write = await services.blobStore.write(conversationId, content, async (prepared) => {
      await services.ledger.prepareEvidenceBlob({
        evidenceId: staged.id,
        conversationId,
        blobRef: prepared.blobRef,
        keyedContentId: prepared.keyedContentId,
        byteCount: prepared.byteCount,
        keyVersion: prepared.keyVersion,
      });
    });
    expect(write.blobRef).toBeTruthy();

    // "Restart": fresh key manager + blob store over the same directory, same
    // (persisted-in-production) ledger. Reconciliation must recover the row.
    const restarted = createIncidentReplayServices({ userDataPath, ledger: services.ledger });
    const reconciliation = await restarted.maintenanceService.reconcileStartup();
    expect(reconciliation).toMatchObject({ recovered: 1, failed: 0, corrupt: 0 });

    // Replaying the identical logical capture now returns the SAME record, not a new one.
    const replay = await restarted.captureService.capture({
      captureKey: 'restart:call-0',
      conversationId,
      provider: 'codex',
      turnRef: 'turn-0',
      toolCallRef: 'call-0',
      toolName: 'shell-file-database',
      sourceKind: 'command',
      mimeType: 'text/plain',
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      content,
      observedBoundary: 'after-provider-retention',
    });
    expect(replay).toMatchObject({ status: 'duplicate', record: { id: staged.id } });
    expect(services.ledger.allRecords().filter((record) => record.conversationId === conversationId)).toHaveLength(1);
  });

  it('fails closed on authenticated corruption with a content-free audit', async () => {
    const services = createIncidentReplayServices({ userDataPath });
    const conversationId = 'corruption-conversation';
    const secretLikeContent = 'tamper-detection fixture payload, never logged';
    const capture = await services.captureService.capture({
      captureKey: 'corruption:call-0',
      conversationId,
      provider: 'codex',
      turnRef: 'turn-0',
      toolCallRef: 'call-0',
      toolName: 'shell-file-database',
      sourceKind: 'command',
      mimeType: 'text/plain',
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      content: new TextEncoder().encode(secretLikeContent),
      observedBoundary: 'after-provider-retention',
    });
    if (!('record' in capture)) throw new Error('unexpected capture failure');
    const record = await services.ledger.getEvidence(conversationId, capture.record.id);
    const blobPath = join(userDataPath, 'conversation-evidence', record!.blobRef!);
    const envelope = await readFile(blobPath);
    envelope[envelope.length - 1] ^= 0xff;
    await writeFile(blobPath, envelope);

    const requester = { id: 'test', path: 'local' as const, localSensitiveAuthorized: true, localRestrictedAuthorized: true };
    await expect(services.retrievalService.read({
      requester, conversationId, evidenceId: capture.record.id, startByte: 0, endByte: 10, tokenLimit: 512,
    })).rejects.toMatchObject({ code: 'EVIDENCE_CORRUPT' });

    const corrupted = await services.ledger.getEvidence(conversationId, capture.record.id);
    expect(corrupted?.status).toBe('corrupt');
    expect(JSON.stringify(services.ledger.accessLog)).not.toContain(secretLikeContent);

    // A second read fails closed without re-decrypting the tampered blob.
    await expect(services.retrievalService.read({
      requester, conversationId, evidenceId: capture.record.id, startByte: 0, endByte: 10, tokenLimit: 512,
    })).rejects.toMatchObject({ code: 'EVIDENCE_CORRUPT' });
  });

  it('fails closed with no plaintext when encryption is unavailable', async () => {
    const services = createIncidentReplayServices({
      userDataPath,
      safeStorage: createFakeSafeStorage(false),
    });

    const capture = await services.captureService.capture({
      captureKey: 'missing-key:call-0',
      conversationId: 'missing-key-conversation',
      provider: 'codex',
      turnRef: 'turn-0',
      toolCallRef: 'call-0',
      toolName: 'shell-file-database',
      sourceKind: 'command',
      mimeType: 'text/plain',
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      content: new TextEncoder().encode('this must never touch disk in plaintext'),
      observedBoundary: 'after-provider-retention',
    });

    expect(capture).toMatchObject({ status: 'failed' });
    await expect(readdir(userDataPath)).resolves.toEqual([]);
  });

  it('denies cross-conversation access and records a content-free audit outcome', async () => {
    const services = createIncidentReplayServices({ userDataPath });
    const capture = await services.captureService.capture({
      captureKey: 'cross-conversation:call-0',
      conversationId: 'conversation-owner',
      provider: 'codex',
      turnRef: 'turn-0',
      toolCallRef: 'call-0',
      toolName: 'shell-file-database',
      sourceKind: 'command',
      mimeType: 'text/plain',
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      content: new TextEncoder().encode('owner-only fixture payload'),
      observedBoundary: 'after-provider-retention',
    });
    if (!('record' in capture)) throw new Error('unexpected capture failure');

    await expect(services.retrievalService.read({
      requester: { id: 'attacker', path: 'provider', localSensitiveAuthorized: false, localRestrictedAuthorized: false },
      conversationId: 'conversation-intruder',
      evidenceId: capture.record.id,
      startByte: 0,
      endByte: 5,
      tokenLimit: 512,
    })).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' });

    expect(services.ledger.accessLog.at(-1)).toMatchObject({
      conversationId: 'conversation-intruder', outcomeCode: 'EVIDENCE_NOT_FOUND',
    });
    expect(JSON.stringify(services.ledger.accessLog)).not.toContain('owner-only fixture payload');
  });

  it('revokes deletion access immediately and completes queued blob removal via the janitor', async () => {
    const services = createIncidentReplayServices({ userDataPath });
    const conversationId = 'deletion-conversation';
    const capture = await services.captureService.capture({
      captureKey: 'deletion:call-0',
      conversationId,
      provider: 'codex',
      turnRef: 'turn-0',
      toolCallRef: 'call-0',
      toolName: 'shell-file-database',
      sourceKind: 'command',
      mimeType: 'text/plain',
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      content: new TextEncoder().encode('deletion fixture payload'),
      observedBoundary: 'after-provider-retention',
    });
    if (!('record' in capture)) throw new Error('unexpected capture failure');
    const record = await services.ledger.getEvidence(conversationId, capture.record.id);
    const blobPath = join(userDataPath, 'conversation-evidence', record!.blobRef!);

    const deletionResult = await services.deletionService.revokeConversation(conversationId);
    expect(deletionResult).toMatchObject({ conversationId, queuedBlobCount: 1, alreadyDeleted: false });

    await expect(services.retrievalService.read({
      requester: { id: 'test', path: 'local', localSensitiveAuthorized: true, localRestrictedAuthorized: true },
      conversationId,
      evidenceId: capture.record.id,
      startByte: 0,
      endByte: 5,
      tokenLimit: 512,
    })).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' });

    const janitorResult = await services.deletionService.runJanitor(10);
    expect(janitorResult).toMatchObject({ claimed: 1, deleted: 1, failed: 0 });
    await expect(readFile(blobPath)).rejects.toMatchObject({ code: 'ENOENT' });

    // Idempotent revocation: a second deletion request is a no-op.
    await expect(services.deletionService.revokeConversation(conversationId)).resolves.toMatchObject({
      alreadyDeleted: true,
    });
  });

  it('stops after three recoveries per outer send even across epoch resets', () => {
    const policy = new ContextSafetyPolicy();
    const capabilities = PROVIDER_CAPABILITY_MATRIX['codex-app-server']!;
    const window = 100_000;
    let state = createInitialContextSafetyPolicyState('outer-send-1');

    for (let attempt = 0; attempt < 3; attempt++) {
      const sample = cumulativeSample(state, window);
      const decision = policy.decide({ sample, capabilities, state, now: 1, effectiveWindowTokens: window });
      expect(decision.action.kind).toBe('controlled-recovery');
      state = policy.advanceEpoch(decision.nextState, 'compaction-observed', sample.cumulativeTokens!);
    }

    const fourthSample = cumulativeSample(state, window);
    const fourthDecision = policy.decide({
      sample: fourthSample, capabilities, state, now: 1, effectiveWindowTokens: window,
    });
    expect(fourthDecision.action.kind).toBe('pause');
    expect(fourthDecision.reasonCode).toBe('RECOVERY_CEILING_REACHED');
  });

  it('drives the safety policy across the locked provider-capability defaults', () => {
    const policy = new ContextSafetyPolicy();
    const window = 100_000;
    // Providers with `occupancyReporting: 'current'` (codex app-server, resident
    // Claude) get a known 92%-occupancy sample; the shared policy never
    // synthesizes a percentage for `aggregate-only` reporters, so those instead
    // get an unknown-occupancy byte-budget sample. Each provider must only
    // receive an action its own capabilities permit.
    const knownOccupancySample: ContextPressureSample = {
      occupancy: { status: 'known', used: 93_000, total: window },
      outputBytesSinceCompaction: 0,
      providerRequestCount: 1,
      newEvidenceCount: 0,
      newValidatedFindingCount: 0,
      recoveryEpoch: 0,
    };
    const unknownBudgetSample: ContextPressureSample = {
      occupancy: { status: 'unknown', reason: 'aggregate-only reporting' },
      outputBytesSinceCompaction: 2_000_000,
      providerRequestCount: 1,
      newEvidenceCount: 0,
      newValidatedFindingCount: 0,
      recoveryEpoch: 0,
    };
    const expected: Record<string, {
      sample: ContextPressureSample;
      action: 'controlled-interrupt' | 'pause';
      reasonCode: string;
    }> = {
      'codex-app-server': {
        sample: knownOccupancySample, action: 'controlled-interrupt', reasonCode: 'CONTROLLED_CONTINUATION_REQUIRED',
      },
      'codex-exec': {
        sample: unknownBudgetSample, action: 'pause', reasonCode: 'UNKNOWN_OCCUPANCY_BUDGET_REACHED',
      },
      'claude-resident': {
        sample: knownOccupancySample, action: 'pause', reasonCode: 'CONTROLLED_CONTINUATION_UNAVAILABLE',
      },
      'claude-nonresident': {
        sample: unknownBudgetSample, action: 'pause', reasonCode: 'UNKNOWN_OCCUPANCY_BUDGET_REACHED',
      },
      'gemini-stateless': {
        sample: unknownBudgetSample, action: 'pause', reasonCode: 'UNKNOWN_OCCUPANCY_BUDGET_REACHED',
      },
      'copilot-acp': {
        sample: unknownBudgetSample, action: 'pause', reasonCode: 'UNKNOWN_OCCUPANCY_BUDGET_REACHED',
      },
    };

    for (const [providerKey, capabilities] of Object.entries(PROVIDER_CAPABILITY_MATRIX)) {
      const state = createInitialContextSafetyPolicyState(`outer-${providerKey}`);
      const { sample, action, reasonCode } = expected[providerKey]!;
      const decision = policy.decide({ sample, capabilities, state, now: 1, effectiveWindowTokens: window });
      expect(decision.action.kind, `provider capability: ${providerKey}`).toBe(action);
      expect(decision.reasonCode, `provider capability: ${providerKey}`).toBe(reasonCode);
    }
  });
});

function cumulativeSample(
  state: ReturnType<typeof createInitialContextSafetyPolicyState>,
  window: number,
): ContextPressureSample {
  return {
    occupancy: { status: 'known', used: window / 2, total: window },
    cumulativeTokens: state.cumulativeBaselineTokens + window * 4 + 1,
    outputBytesSinceCompaction: 0,
    providerRequestCount: 1,
    newEvidenceCount: 0,
    newValidatedFindingCount: 0,
    recoveryEpoch: state.epoch,
  };
}
