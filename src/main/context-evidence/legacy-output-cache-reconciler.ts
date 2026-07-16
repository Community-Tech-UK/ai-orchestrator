import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ContextEvidenceCoordinator } from './context-evidence-coordinator';
import type { ConversationLedgerService } from '../conversation-ledger/conversation-ledger-service';

const EXACT_LEGACY_MARKER = /\[Full output saved: ([^\]\r\n]+)\] \((\d+) chars\)/g;
const LEGACY_DISCLOSURE =
  'Legacy cache import: provenance is legacy-unverified; inspectable but not sufficient alone ' +
  'for important or completion claims.';

export interface LegacyOutputCacheMarkerRecord {
  conversationId: string;
  messageId: string;
  content: string;
  provider: string;
  sourceKind: string;
}

interface LegacyOutputCacheLedger {
  listLegacyOutputCacheMarkers(): Promise<LegacyOutputCacheMarkerRecord[]>;
  compareAndSwapLegacyOutputMarker(input: {
    conversationId: string;
    messageId: string;
    evidenceId: string;
    expectedMarker: string;
    evidenceCitation: string;
    replacementText: string;
  }): Promise<boolean>;
}

type LegacyCoordinator = Pick<ContextEvidenceCoordinator, 'capture' | 'read'>;

export interface LegacyOutputCacheReconcilerDependencies {
  userDataPath: string;
  ledger: LegacyOutputCacheLedger;
  coordinator: LegacyCoordinator;
}

export interface LegacyOutputCacheReconciliationFailure {
  messageId: string;
  code: string;
}

export interface LegacyOutputCacheReconciliationReport {
  scanned: number;
  migrated: number;
  deleted: number;
  failures: LegacyOutputCacheReconciliationFailure[];
}

interface ParsedLegacyMarker {
  marker: string;
  filePath: string;
  characterCount: number;
}

/** One-shot, retry-safe migration of historical plaintext output-cache markers. */
export class LegacyOutputCacheReconciler {
  constructor(private readonly dependencies: LegacyOutputCacheReconcilerDependencies) {}

  async reconcile(): Promise<LegacyOutputCacheReconciliationReport> {
    const report: LegacyOutputCacheReconciliationReport = {
      scanned: 0,
      migrated: 0,
      deleted: 0,
      failures: [],
    };
    const records = await this.dependencies.ledger.listLegacyOutputCacheMarkers();
    report.scanned = records.length;
    for (const record of records) {
      try {
        await this.reconcileRecord(record, report);
      } catch (error) {
        report.failures.push({ messageId: record.messageId, code: contentFreeCode(error) });
      }
    }
    return report;
  }

  private async reconcileRecord(
    record: LegacyOutputCacheMarkerRecord,
    report: LegacyOutputCacheReconciliationReport,
  ): Promise<void> {
    if (record.sourceKind !== 'orchestrator') {
      throw codedError('LEGACY_CACHE_OWNER_UNRESOLVED');
    }
    const parsed = parseOneExactLegacyMarker(record.content);
    if (!parsed) throw codedError('LEGACY_CACHE_MARKER_UNKNOWN');
    const filePath = await this.validateCacheFile(parsed.filePath);
    const text = await readFile(filePath, 'utf8');
    if (text.length !== parsed.characterCount || Buffer.byteLength(text, 'utf8') === 0) {
      throw codedError('LEGACY_CACHE_SIZE_MISMATCH');
    }

    const content = new TextEncoder().encode(text);
    try {
      const captured = await this.dependencies.coordinator.capture({
        captureKey: `legacy-output-cache:${sha256(parsed.marker)}`,
        conversationId: record.conversationId,
        provider: record.provider,
        turnRef: `legacy-message:${record.messageId}`,
        toolCallRef: `legacy-output-cache:${sha256(parsed.marker)}`,
        toolName: 'legacy-output-cache-import',
        sourceKind: 'file',
        mimeType: 'text/plain',
        sensitivity: 'normal',
        provenanceTrust: 'legacy-unverified',
        captureMode: 'observed-only',
        captureCompleteness: 'complete',
        content,
        observedBoundary: 'provider-observed-only',
      });
      if ('errorCode' in captured.capture) throw codedError(captured.capture.errorCode);
      const evidence = captured.capture.record;
      const excerptEnd = Math.min(evidence.byteCount, 4_096);
      const read = await this.dependencies.coordinator.read({
        requester: {
          id: 'legacy-output-cache-reconciler',
          path: 'local',
          localSensitiveAuthorized: false,
          localRestrictedAuthorized: false,
        },
        conversationId: record.conversationId,
        evidenceId: evidence.id,
        startByte: 0,
        endByte: excerptEnd,
        tokenLimit: 1_024,
      });
      const citation = formatCitation(read.citation);
      const replacementText = `${citation}\n[${LEGACY_DISCLOSURE}]`;
      const swapped = await this.dependencies.ledger.compareAndSwapLegacyOutputMarker({
        conversationId: record.conversationId,
        messageId: record.messageId,
        evidenceId: evidence.id,
        expectedMarker: parsed.marker,
        evidenceCitation: citation,
        replacementText,
      });
      if (!swapped) throw codedError('LEGACY_CACHE_MARKER_CHANGED');
      report.migrated++;

      const remaining = await this.dependencies.ledger.listLegacyOutputCacheMarkers();
      if (await hasRemainingReference(remaining, parsed.filePath, filePath)) return;
      await unlink(filePath);
      report.deleted++;
    } finally {
      content.fill(0);
    }
  }

  private async validateCacheFile(candidate: string): Promise<string> {
    const expectedRoot = path.resolve(this.dependencies.userDataPath, 'output-cache');
    const rootStat = await lstat(expectedRoot).catch(() => {
      throw codedError('LEGACY_CACHE_ROOT_UNAVAILABLE');
    });
    if (rootStat.isSymbolicLink()) throw codedError('LEGACY_CACHE_ROOT_SYMLINK_REJECTED');
    if (!rootStat.isDirectory()) throw codedError('LEGACY_CACHE_ROOT_UNAVAILABLE');
    const root = await realpath(expectedRoot).catch(() => {
      throw codedError('LEGACY_CACHE_ROOT_UNAVAILABLE');
    });
    const resolved = path.resolve(candidate);
    if (!path.isAbsolute(candidate) || !isContained(expectedRoot, resolved)) {
      throw codedError('LEGACY_CACHE_PATH_OUTSIDE_ROOT');
    }
    const stat = await lstat(resolved).catch(() => {
      throw codedError('LEGACY_CACHE_FILE_UNAVAILABLE');
    });
    if (stat.isSymbolicLink()) throw codedError('LEGACY_CACHE_SYMLINK_REJECTED');
    if (!stat.isFile()) throw codedError('LEGACY_CACHE_NOT_FILE');
    const canonical = await realpath(resolved);
    if (!isContained(root, canonical)) throw codedError('LEGACY_CACHE_PATH_OUTSIDE_ROOT');
    return canonical;
  }
}

function parseOneExactLegacyMarker(content: string): ParsedLegacyMarker | null {
  const matches = [...content.matchAll(EXACT_LEGACY_MARKER)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const characterCount = Number(match[2]);
  if (!Number.isSafeInteger(characterCount) || characterCount < 0) return null;
  return { marker: match[0], filePath: match[1]!, characterCount };
}

function isContained(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`);
}

async function hasRemainingReference(
  records: LegacyOutputCacheMarkerRecord[],
  originalPath: string,
  canonicalPath: string,
): Promise<boolean> {
  for (const record of records) {
    if (record.content.includes(originalPath) || record.content.includes(canonicalPath)) return true;
    const parsed = parseOneExactLegacyMarker(record.content);
    if (!parsed) continue;
    const candidateCanonical = await realpath(parsed.filePath).catch(() => null);
    if (candidateCanonical === canonicalPath) return true;
  }
  return false;
}

function formatCitation(citation: {
  evidenceId: string;
  startByte: number;
  endByte: number;
  contentDigest: string;
}): string {
  return `[evidence:${citation.evidenceId}@${citation.startByte}-${citation.endByte}#${citation.contentDigest}]`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function contentFreeCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : 'LEGACY_CACHE_RECONCILIATION_FAILED';
}

export type LegacyOutputCacheLedgerService = Pick<
  ConversationLedgerService,
  'listLegacyOutputCacheMarkers' | 'compareAndSwapLegacyOutputMarker'
>;
