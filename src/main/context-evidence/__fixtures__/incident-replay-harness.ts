/**
 * Shared harness for the Task 18 governed incident replay: the frozen Phase 0
 * manifest loader/expander (reused by context-evidence-baseline.spec.ts),
 * a real fail-closed crypto/blob stack over a temp user-data directory, and
 * the orchestration used by both context-evidence-incident-replay.spec.ts and
 * scripts/replay-context-evidence-incident.ts so the two never fork logic.
 */
import type {
  EvidenceCaptureResult,
  EvidenceRecord,
  ProviderContextCapabilities,
} from '@contracts/types/context-evidence';
import type { SafeStorageAccessor } from '../../session/safe-storage-accessor';
import { EvidenceKeyManager } from '../evidence-key-manager';
import { EncryptedEvidenceBlobStore } from '../encrypted-evidence-blob-store';
import { EvidenceCaptureService } from '../evidence-capture-service';
import { EvidenceCardService } from '../cards/evidence-card-service';
import { EvidenceRetrievalService } from '../evidence-retrieval-service';
import { EvidenceMaintenanceService } from '../evidence-maintenance-service';
import { EvidenceDeletionService } from '../evidence-deletion-service';
import { ConservativeEvidenceAccessPolicy } from '../evidence-access-policy';
import { ContextTokenEstimator } from '../context-token-estimator';
import { WorkingSetPlanner, type WorkingSetCandidate } from '../working-set-planner';
import { WorkingSetRenderer } from '../working-set-renderer';
import { AccuracyGate, type AccuracyEvidenceVerifier } from '../accuracy-gate';
import { InMemoryEvidenceLedger } from './incident-replay-ledger';
import {
  expandIncidentManifest,
  type ExpandedIncidentCall,
  type IncidentManifest,
} from './incident-replay-manifest';

export {
  readIncidentManifest,
  expandIncidentManifest,
  type IncidentManifest,
  type IncidentManifestGroup,
  type ExpandedIncidentCall,
} from './incident-replay-manifest';

const XOR_MASK = 0x5a;

/** Reversible fixture-only "encryption": exercises the real wrap/unwrap code path. */
export function createFakeSafeStorage(available = true): SafeStorageAccessor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext) => Buffer.from(Buffer.from(plaintext, 'utf8').map((byte) => byte ^ XOR_MASK)),
    decryptString: (ciphertext) => Buffer.from(ciphertext.map((byte) => byte ^ XOR_MASK)).toString('utf8'),
  };
}

function sourceKindFor(category: string): 'web' | 'command' | 'mcp' {
  if (category === 'web') return 'web';
  if (category === 'tool-discovery') return 'mcp';
  return 'command';
}

/** ~4 chars/token approximation of a real provider tokenizer, injected explicitly. */
export function createIncidentEstimator(): ContextTokenEstimator {
  return new ContextTokenEstimator((text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

export interface IncidentReplayServices {
  keyManager: EvidenceKeyManager;
  blobStore: EncryptedEvidenceBlobStore;
  ledger: InMemoryEvidenceLedger;
  captureService: EvidenceCaptureService;
  cardService: EvidenceCardService;
  retrievalService: EvidenceRetrievalService;
  maintenanceService: EvidenceMaintenanceService;
  deletionService: EvidenceDeletionService;
  workingSetPlanner: WorkingSetPlanner;
  workingSetRenderer: WorkingSetRenderer;
  accuracyGate: AccuracyGate;
  estimator: ContextTokenEstimator;
}

export interface IncidentReplayServiceOptions {
  userDataPath: string;
  safeStorage?: SafeStorageAccessor;
  ledger?: InMemoryEvidenceLedger;
  now?: () => number;
}

/** Wires the real crypto/capture/card/retrieval stack over a temp user-data dir. */
export function createIncidentReplayServices(options: IncidentReplayServiceOptions): IncidentReplayServices {
  const now = options.now ?? Date.now;
  const keyManager = new EvidenceKeyManager({
    userDataPath: options.userDataPath,
    safeStorage: options.safeStorage ?? createFakeSafeStorage(),
    now,
  });
  const blobStore = new EncryptedEvidenceBlobStore({ userDataPath: options.userDataPath, keyManager });
  const ledger = options.ledger ?? new InMemoryEvidenceLedger(now);
  const policy = new ConservativeEvidenceAccessPolicy();
  const estimator = createIncidentEstimator();
  const estimateTokens = (text: string) => estimator.estimate(text).tokens;
  const captureService = new EvidenceCaptureService({ ledger, blobStore, now });
  const cardService = new EvidenceCardService({ ledger, blobStore, policy, estimateTokens, now });
  const retrievalService = new EvidenceRetrievalService({ ledger, blobStore, policy, estimateTokens, now });
  const maintenanceService = new EvidenceMaintenanceService({ ledger, blobStore, keyManager, now });
  const deletionService = new EvidenceDeletionService({ ledger, blobStore, now });
  const accuracyGate = new AccuracyGate(createIncidentAccuracyVerifier(ledger, blobStore), policy, now);
  return {
    keyManager,
    blobStore,
    ledger,
    captureService,
    cardService,
    retrievalService,
    maintenanceService,
    deletionService,
    workingSetPlanner: new WorkingSetPlanner(estimator),
    workingSetRenderer: new WorkingSetRenderer(estimator),
    accuracyGate,
    estimator,
  };
}

/** Verifies `[evidence:...]` markers against the same real ledger + blob store. */
export function createIncidentAccuracyVerifier(
  ledger: InMemoryEvidenceLedger,
  blobStore: EncryptedEvidenceBlobStore,
): AccuracyEvidenceVerifier {
  return {
    async verify(conversationId, citation) {
      const record = ledger.findRecordById(citation.evidenceId);
      if (!record) return { status: 'missing-evidence' };
      if (record.conversationId !== conversationId) return { status: 'wrong-conversation' };
      if (record.status === 'corrupt') return { status: 'corrupt-evidence' };
      if (record.status !== 'complete' || !record.blobRef || !record.keyedContentId) {
        return { status: 'missing-evidence' };
      }
      if (
        citation.startByte < 0
        || citation.endByte <= citation.startByte
        || citation.endByte > record.byteCount
      ) {
        return { status: 'invalid-citation' };
      }
      let bytes: Uint8Array;
      try {
        bytes = await blobStore.readRange(
          record.blobRef, record.keyedContentId, citation.startByte, citation.endByte,
        );
      } catch {
        return { status: 'corrupt-evidence' };
      }
      try {
        const verified = await blobStore.verifyCitationDigest(
          bytes, citation.contentDigest, record.keyVersion ?? undefined,
        );
        if (!verified) return { status: 'invalid-citation' };
      } finally {
        bytes.fill(0);
      }
      return {
        status: 'valid',
        provenanceTrust: record.provenanceTrust,
        captureCompleteness: record.captureCompleteness,
        rawSpanAvailable: true,
        modelAssistedOnly: false,
        sensitivity: record.sensitivity,
        sourceKind: record.sourceKind,
        observedAt: record.completedAt ?? record.createdAt,
      };
    },
  };
}

const POST_RETENTION_FULL_BASE = {
  toolResultControl: 'post-retention',
  toolResultVisibility: 'full',
  cumulativeReporting: 'available',
} as const;

/** Locked provider capability defaults from the design's capability table (Task 12). */
export const PROVIDER_CAPABILITY_MATRIX: Record<string, ProviderContextCapabilities> = {
  'codex-app-server': {
    ...POST_RETENTION_FULL_BASE,
    transcriptControl: 'native-compaction',
    occupancyReporting: 'current',
    interruptProof: 'observed',
    compactionProof: 'observed',
    sameThreadContinuation: true,
  },
  'codex-exec': {
    ...POST_RETENTION_FULL_BASE,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  },
  'claude-resident': {
    ...POST_RETENTION_FULL_BASE,
    transcriptControl: 'none',
    occupancyReporting: 'current',
    interruptProof: 'acknowledged-only',
    compactionProof: 'none',
    sameThreadContinuation: true,
  },
  'claude-nonresident': {
    ...POST_RETENTION_FULL_BASE,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  },
  'gemini-stateless': {
    ...POST_RETENTION_FULL_BASE,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  },
  'copilot-acp': {
    ...POST_RETENTION_FULL_BASE,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  },
};

export interface CapturedIncidentCall extends ExpandedIncidentCall {
  evidenceId: string;
  byteCount: number;
  roundTripEqual: boolean;
}

export interface IncidentWorkingSetMeasurement {
  ungovernedTokens: number;
  governedTokens: number;
  reductionPercent: number;
  governedCumulativeInputTokens: number;
  baselineCumulativeInputTokens: number;
  cumulativeReductionPercent: number;
}

export interface IncidentReplayResult {
  conversationId: string;
  totalCalls: number;
  externalizableCount: number;
  totalResultCharacters: number;
  captured: CapturedIncidentCall[];
  cardsBuilt: number;
  workingSet: IncidentWorkingSetMeasurement;
  sampleCitation: { evidenceId: string; startByte: number; endByte: number; contentDigest: string };
  accuracyGateVerdict: 'pass' | 'warn' | 'block';
}

export interface IncidentReplayOptions {
  conversationId?: string;
  provider?: string;
}

/**
 * Replays the frozen 44-call workload through capture -> cards -> working-set
 * planning -> retrieval -> accuracy gate, and measures governed vs ungoverned
 * cumulative provider input for the SAME workload. Idempotent: replaying the
 * identical workload against the same services returns `duplicate` captures
 * with the original evidence IDs rather than creating new records.
 */
export async function runIncidentReplay(
  services: IncidentReplayServices,
  manifest: IncidentManifest,
  options: IncidentReplayOptions = {},
): Promise<IncidentReplayResult> {
  const conversationId = options.conversationId ?? 'incident-replay-conversation';
  const provider = options.provider ?? 'codex';
  const calls = expandIncidentManifest(manifest);
  const captured: CapturedIncidentCall[] = [];
  const dialogueCandidates: WorkingSetCandidate[] = [];
  const cardCandidates: WorkingSetCandidate[] = [];
  let cardsBuilt = 0;
  let firstExternalizableEvidenceId: string | null = null;

  for (const call of calls) {
    const content = new TextEncoder().encode(call.result);
    const capture = await services.captureService.capture({
      captureKey: `incident:${call.category}:${call.index}`,
      conversationId,
      provider,
      turnRef: `turn-${call.index}`,
      toolCallRef: `call-${call.index}`,
      toolName: call.toolName,
      sourceKind: sourceKindFor(call.category),
      mimeType: 'text/plain',
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      content,
      observedBoundary: 'after-provider-retention',
    });
    const record = requireCapturedRecord(capture, call.index);
    const roundTrip = await services.blobStore.read(
      // Bounded by definition: blobRef/keyedContentId are set once complete.
      (await services.ledger.getEvidence(conversationId, record.id))!.blobRef!,
      record.keyedContentId,
    );
    const roundTripEqual = Buffer.compare(Buffer.from(roundTrip), Buffer.from(content)) === 0;
    roundTrip.fill(0);
    captured.push({ ...call, evidenceId: record.id, byteCount: record.byteCount, roundTripEqual });

    if (call.externalizable) {
      firstExternalizableEvidenceId ??= record.id;
      if (capture.status === 'captured') {
        const built = await services.cardService.build({ conversationId, evidenceId: record.id });
        cardsBuilt += 1;
        cardCandidates.push({
          id: `card-${call.index}`,
          content: built.card.summary,
          createdAt: call.index,
          // The underlying raw evidence capture is 'complete' regardless of
          // extractor confidence; extraction quality is a separate concept
          // tracked by the card's own `status`, not this field.
          captureCompleteness: 'complete',
          relevanceScore: 10,
        });
      } else {
        cardsBuilt += 1;
        cardCandidates.push({
          id: `card-${call.index}`,
          content: `Result already captured as evidence ${record.id}.`,
          createdAt: call.index,
          captureCompleteness: 'complete',
        });
      }
    } else {
      dialogueCandidates.push({
        id: `dialogue-${call.index}`,
        content: call.result,
        createdAt: call.index,
        captureCompleteness: 'complete',
      });
    }
  }

  const workingSet = measureGovernedReduction(services, manifest, calls, dialogueCandidates, cardCandidates);

  const sampleRecord = await services.ledger.getEvidence(conversationId, firstExternalizableEvidenceId!);
  const sampleEndByte = Math.min(64, sampleRecord!.byteCount);
  const sampleRead = await services.retrievalService.read({
    requester: { id: 'incident-replay', path: 'local', localSensitiveAuthorized: true, localRestrictedAuthorized: true },
    conversationId,
    evidenceId: firstExternalizableEvidenceId!,
    startByte: 0,
    endByte: sampleEndByte,
    tokenLimit: 512,
  });
  const assistantText =
    `The captured tool result begins as cited. ${formatCitation(sampleRead.citation)}`;
  const gateResult = await services.accuracyGate.evaluate({
    conversationId,
    assistantText,
    researchRequested: true,
    externalFactsUsed: false,
    completionClaim: false,
    highStakes: false,
    executionReceiptCurrent: true,
    unresolvedContradictionCount: 0,
    contradictionsPresented: false,
    disclosedIncompleteEvidenceIds: [],
  });

  return {
    conversationId,
    totalCalls: calls.length,
    externalizableCount: calls.filter((call) => call.externalizable).length,
    totalResultCharacters: calls.reduce((sum, call) => sum + call.result.length, 0),
    captured,
    cardsBuilt,
    workingSet,
    sampleCitation: sampleRead.citation,
    accuracyGateVerdict: gateResult.verdict,
  };
}

function measureGovernedReduction(
  services: IncidentReplayServices,
  manifest: IncidentManifest,
  calls: ExpandedIncidentCall[],
  dialogueCandidates: WorkingSetCandidate[],
  cardCandidates: WorkingSetCandidate[],
): IncidentWorkingSetMeasurement {
  const requiredInstructions = ['Follow AIO system and task instructions.'];
  const latestUserIntent = 'Summarize the incident replay workload and cite exact evidence.';
  const ungovernedText = [
    ...requiredInstructions,
    latestUserIntent,
    ...calls.map((call) => call.result),
  ].join('\n');
  const ungovernedTokens = services.estimator.estimate(ungovernedText).tokens;

  const plan = services.workingSetPlanner.plan({
    capacityTokens: manifest.incident.contextWindowTokens,
    requiredInstructions,
    latestUserIntent,
    recentDialogue: dialogueCandidates,
    activeTaskState: [],
    evidenceCards: cardCandidates,
    exactExcerpts: [],
  });
  if (plan.status === 'paused') {
    throw new Error('INCIDENT_REPLAY_WORKING_SET_PAUSED');
  }
  const rendered = services.workingSetRenderer.render(plan);
  const governedTokens = rendered.totalTokens;
  const reductionPercent = 1 - governedTokens / ungovernedTokens;
  const baselineCumulativeInputTokens = manifest.controlledUngovernedBaseline.cumulativeInputTokens;
  const governedCumulativeInputTokens = Math.round(
    baselineCumulativeInputTokens * (governedTokens / ungovernedTokens),
  );
  const cumulativeReductionPercent =
    1 - governedCumulativeInputTokens / baselineCumulativeInputTokens;

  return {
    ungovernedTokens,
    governedTokens,
    reductionPercent,
    governedCumulativeInputTokens,
    baselineCumulativeInputTokens,
    cumulativeReductionPercent,
  };
}

function requireCapturedRecord(result: EvidenceCaptureResult, callIndex: number): EvidenceRecord {
  if ('record' in result) return result.record;
  throw new Error(`INCIDENT_REPLAY_CAPTURE_FAILED:${callIndex}:${result.errorCode}`);
}

export function formatCitation(citation: {
  evidenceId: string;
  startByte: number;
  endByte: number;
  contentDigest: string;
}): string {
  return `[evidence:${citation.evidenceId}@${citation.startByte}-${citation.endByte}#${citation.contentDigest}]`;
}
