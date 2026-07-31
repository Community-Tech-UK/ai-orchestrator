/**
 * LearningScanService — WS-B8 manual-trigger fail->fix correction scan.
 *
 * Orchestrates: bounded + checkpointed traversal of settled (archived, i.e.
 * terminated — `HistoryManager.archiveInstance` only ever runs on instance
 * termination) sessions -> pure mining (`correction-miner.ts`) -> egress
 * redaction -> cross-session aggregation -> one governed 'rule' proposal
 * capture per recurring (baseCommand, errorClass) pattern.
 *
 * Manual-by-default: nothing here runs on a timer or at startup. It is only
 * ever invoked by an explicit IPC call from the renderer's "Scan for
 * corrections" button. Nothing it produces is auto-promoted — every result is
 * a `pending` governed proposal awaiting a human decision
 * (`GovernedProposalService.approve`/`reject`).
 */

import { getLogger } from '../logging/logger';
import type { OutputMessage } from '../../shared/types/instance.types';
import { getHistoryManager, type HistoryManager } from '../history/history-manager';
import { redactForEgress } from '../security/content-egress-gate';
import { getGovernedProposalService, type GovernedProposalService } from '../memory/governed-proposal-service';
import {
  getLearningScanCheckpointStore,
  LEARNING_SCAN_GLOBAL_SCOPE,
  type LearningScanCheckpoint,
  type LearningScanCheckpointStore,
} from './learning-scan-checkpoint-store';
import { mineCorrections, type CorrectionCandidate, type MinableMessage } from './correction-miner';

const logger = getLogger('LearningScanService');

const DEFAULT_SESSION_LIMIT = 25;
const MAX_SESSION_LIMIT = 200;
const MAX_EVIDENCE_PER_PROPOSAL = 3;

export interface RunScanParams {
  /** Restrict the scan to a single workspace (matches `ConversationHistoryEntry.workingDirectory`). Omit for a global scan. */
  workspaceId?: string;
  /** Max settled sessions to scan this run. Clamped to [1, 200], default 25. */
  sessionLimit?: number;
  /** Override the persisted checkpoint — rescan sessions that ended after this timestamp. */
  sinceTs?: number;
}

export interface ScanResultSummary {
  scopeKey: string;
  sessionsScanned: number;
  sessionsSkipped: number;
  proposalsCreated: number;
  proposalsReinforced: number;
  patternsFound: number;
  startedAt: number;
  completedAt: number;
  error: string | null;
}

type HistoryDep = Pick<HistoryManager, 'getEntries' | 'loadConversation'>;
type ProposalServiceDep = Pick<GovernedProposalService, 'captureRuleProposal'>;
type CheckpointStoreDep = Pick<LearningScanCheckpointStore, 'get' | 'recordRun'>;

function scopeKeyFor(workspaceId?: string): string {
  const trimmed = workspaceId?.trim();
  return trimmed ? trimmed : LEARNING_SCAN_GLOBAL_SCOPE;
}

function clampSessionLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_SESSION_LIMIT;
  return Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(limit)));
}

function toMinableMessage(message: OutputMessage): MinableMessage {
  return {
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    metadata: message.metadata,
  };
}

interface EvidenceItem {
  sessionId: string;
  exampleFail: string;
  exampleFix: string;
}

export interface AggregatedPattern {
  baseCommand: string;
  errorClass: string;
  /** The single highest-confidence candidate found for this pattern this scan. */
  bestCandidate: CorrectionCandidate;
  occurrences: number;
  confidence: number;
  evidence: EvidenceItem[];
}

/**
 * Group this scan's per-session candidates by (baseCommand, errorClass)
 * across ALL scanned sessions, capping evidence per pattern. Exported for
 * direct unit testing (pure — no DB, no redaction, no IO).
 */
export function aggregateCandidates(
  perSession: readonly { sessionId: string; candidates: readonly CorrectionCandidate[] }[],
): AggregatedPattern[] {
  const groups = new Map<string, AggregatedPattern>();

  for (const { sessionId, candidates } of perSession) {
    for (const candidate of candidates) {
      const key = `${candidate.baseCommand}::${candidate.errorClass}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          baseCommand: candidate.baseCommand,
          errorClass: candidate.errorClass,
          bestCandidate: candidate,
          occurrences: 0,
          confidence: candidate.confidence,
          evidence: [],
        };
        groups.set(key, group);
      }
      group.occurrences += 1;
      if (candidate.confidence > group.confidence) {
        group.confidence = candidate.confidence;
        group.bestCandidate = candidate;
      }
      if (group.evidence.length < MAX_EVIDENCE_PER_PROPOSAL) {
        group.evidence.push({ sessionId, exampleFail: candidate.failCommand, exampleFix: candidate.fixCommand });
      }
    }
  }

  return [...groups.values()];
}

export class LearningScanService {
  private static instance: LearningScanService | null = null;

  constructor(
    private readonly history: HistoryDep = getHistoryManager(),
    private readonly proposals: ProposalServiceDep = getGovernedProposalService(),
    private readonly checkpoints: CheckpointStoreDep = getLearningScanCheckpointStore(),
  ) {}

  static getInstance(): LearningScanService {
    if (!LearningScanService.instance) {
      LearningScanService.instance = new LearningScanService();
    }
    return LearningScanService.instance;
  }

  static _resetForTesting(): void {
    LearningScanService.instance = null;
  }

  /** Last checkpoint/summary for a scope, or `null` when never scanned / DB unavailable. */
  getStatus(workspaceId?: string): LearningScanCheckpoint | null {
    return this.checkpoints.get(scopeKeyFor(workspaceId));
  }

  /**
   * Manual-trigger, bounded, checkpointed scan of settled sessions ended
   * after the scope's last checkpoint, oldest-first, up to `sessionLimit`.
   * Never auto-promotes — only raises/reinforces `pending` governed 'rule'
   * proposals via {@link GovernedProposalService.captureRuleProposal}.
   */
  async runScan(params: RunScanParams = {}): Promise<ScanResultSummary> {
    const scopeKey = scopeKeyFor(params.workspaceId);
    const startedAt = Date.now();
    const checkpoint = this.checkpoints.get(scopeKey);
    const sinceTs = params.sinceTs ?? checkpoint?.lastScannedEndedAt ?? 0;
    const sessionLimit = clampSessionLimit(params.sessionLimit);

    let sessionsScanned = 0;
    let sessionsSkipped = 0;
    let proposalsCreated = 0;
    let proposalsReinforced = 0;
    let maxEndedAt = sinceTs;
    let lastEntryId: string | null = checkpoint?.lastScannedEntryId ?? null;
    let errorMessage: string | null = null;

    try {
      const entries = this.history
        .getEntries({ workingDirectory: params.workspaceId })
        .filter((entry) => entry.endedAt > sinceTs)
        .sort((a, b) => a.endedAt - b.endedAt)
        .slice(0, sessionLimit);

      const perSession: { sessionId: string; candidates: CorrectionCandidate[] }[] = [];

      for (const entry of entries) {
        try {
          const data = await this.history.loadConversation(entry.id);
          if (data) {
            const candidates = mineCorrections(data.messages.map(toMinableMessage));
            if (candidates.length > 0) {
              perSession.push({ sessionId: entry.id, candidates });
            }
          } else {
            sessionsSkipped += 1;
          }
        } catch (err) {
          sessionsSkipped += 1;
          logger.warn('Skipping session (load/mine failed)', {
            entryId: entry.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        sessionsScanned += 1;
        if (entry.endedAt > maxEndedAt) {
          maxEndedAt = entry.endedAt;
          lastEntryId = entry.id;
        }
      }

      const aggregated = aggregateCandidates(perSession);
      for (const pattern of aggregated) {
        const redactedPattern = redactForEgress(pattern.bestCandidate.failCommand, { kind: 'memory' }).content;
        const redactedCorrection = redactForEgress(pattern.bestCandidate.fixCommand, { kind: 'memory' }).content;
        const redactedEvidence = pattern.evidence.map((item) => ({
          sessionId: item.sessionId,
          exampleFail: redactForEgress(item.exampleFail, { kind: 'memory' }).content,
          exampleFix: redactForEgress(item.exampleFix, { kind: 'memory' }).content,
        }));

        const result = this.proposals.captureRuleProposal({
          baseCommand: pattern.baseCommand,
          errorClass: pattern.errorClass,
          pattern: redactedPattern,
          correction: redactedCorrection,
          occurrences: pattern.occurrences,
          confidence: pattern.confidence,
          evidence: redactedEvidence,
          sourceSessionId: redactedEvidence[0]?.sessionId ?? null,
        });
        if (result) {
          if (result.reinforced) proposalsReinforced += 1;
          else proposalsCreated += 1;
        }
      }

      this.checkpoints.recordRun({
        scopeKey,
        lastScannedEndedAt: maxEndedAt,
        lastScannedEntryId: lastEntryId,
        lastScanStartedAt: startedAt,
        lastScanCompletedAt: Date.now(),
        sessionsScannedLastRun: sessionsScanned,
        proposalsCreatedLastRun: proposalsCreated,
        proposalsReinforcedLastRun: proposalsReinforced,
        lastError: null,
      });

      return {
        scopeKey,
        sessionsScanned,
        sessionsSkipped,
        proposalsCreated,
        proposalsReinforced,
        patternsFound: aggregated.length,
        startedAt,
        completedAt: Date.now(),
        error: null,
      };
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Learning scan failed', err instanceof Error ? err : undefined, { scopeKey });
      this.checkpoints.recordRun({
        scopeKey,
        lastScannedEndedAt: maxEndedAt,
        lastScannedEntryId: lastEntryId,
        lastScanStartedAt: startedAt,
        lastScanCompletedAt: Date.now(),
        sessionsScannedLastRun: sessionsScanned,
        proposalsCreatedLastRun: proposalsCreated,
        proposalsReinforcedLastRun: proposalsReinforced,
        lastError: errorMessage,
      });
      return {
        scopeKey,
        sessionsScanned,
        sessionsSkipped,
        proposalsCreated,
        proposalsReinforced,
        patternsFound: 0,
        startedAt,
        completedAt: Date.now(),
        error: errorMessage,
      };
    }
  }
}

export function getLearningScanService(): LearningScanService {
  return LearningScanService.getInstance();
}
