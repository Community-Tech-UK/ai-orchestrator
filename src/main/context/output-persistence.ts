/**
 * Output Persistence Manager
 *
 * Intercepts large CLI tool outputs before they are inserted into the context
 * window. In shadow/enforce mode, outputs exceeding configurable per-tool
 * thresholds are captured as encrypted evidence and optionally replaced with
 * a bounded authenticated preview. Explicit off mode leaves output inline.
 *
 * Default thresholds:
 *   grep / search tools  → 20 K chars
 *   web_fetch            → 100 K chars
 *   all other tools      → 50 K chars
 *
 * Historical plaintext cache creation and age-based deletion are intentionally
 * absent. Legacy files are handled only by LegacyOutputCacheReconciler.
 */

import type {
  EvidenceCaptureCompleteness,
  EvidenceCaptureMode,
  EvidenceSourceKind,
} from '@contracts/types/context-evidence';
import { getLogger } from '../logging/logger';
import type { ContextEvidenceMode } from '../../shared/types/settings.types';
import type { EvidenceObservationBoundary } from '../context-evidence/evidence-capture-service';
import type { ContextEvidenceCoordinator } from '../context-evidence/context-evidence-coordinator';
import { getContextEvidenceMode } from '../context-evidence/context-evidence-settings';
import { getSettingsManager } from '../core/config/settings-manager';

const logger = getLogger('OutputPersistenceManager');

const PREVIEW_HEAD_CHARS = 2000;
const PREVIEW_TAIL_CHARS = 1000;

const DEFAULT_THRESHOLDS: Record<string, number> = {
  grep: 20_000,
  search: 20_000,
  web_fetch: 100_000,
  default: 50_000,
};

export interface OutputPersistenceConfig {
  thresholds?: Record<string, number>;
  delegateInspectionHint?: boolean;
}

export interface OutputPersistenceOptions {
  delegateInspectionHint?: boolean;
  captureContext?: OutputPersistenceCaptureContext;
}

export interface OutputPersistenceCaptureContext {
  provider: string;
  /** Canonical AIO conversation-ledger thread ID. Undefined means unresolved ownership. */
  conversationId?: string;
  providerThreadRef?: string;
  turnRef: string;
  logicalCallId: string;
  sourceKind: EvidenceSourceKind;
  captureMode: EvidenceCaptureMode;
  captureCompleteness: EvidenceCaptureCompleteness;
  truncationReason?: string;
  observedBoundary: EvidenceObservationBoundary;
}

export interface OutputPersistenceMigrationError {
  code: string;
  provider: string;
  toolName: string;
}

type EvidenceFacadeCoordinator = Pick<ContextEvidenceCoordinator, 'capture' | 'read'>;

export interface OutputPersistenceDependencies {
  getMode(provider: string): ContextEvidenceMode;
  getCoordinator(): EvidenceFacadeCoordinator;
  recordMigrationError(error: OutputPersistenceMigrationError): void;
}

export class OutputPersistenceManager {
  private static instance: OutputPersistenceManager | null = null;

  private thresholds: Record<string, number> = { ...DEFAULT_THRESHOLDS };

  constructor(private readonly dependencies: OutputPersistenceDependencies = defaultDependencies()) {}

  static getInstance(): OutputPersistenceManager {
    if (!OutputPersistenceManager.instance) {
      OutputPersistenceManager.instance = new OutputPersistenceManager();
    }
    return OutputPersistenceManager.instance;
  }

  static _resetForTesting(): void {
    OutputPersistenceManager.instance = null;
  }

  /** Override default thresholds or add new per-tool thresholds. */
  configure(config: OutputPersistenceConfig): void {
    if (config.thresholds) {
      this.thresholds = { ...this.thresholds, ...config.thresholds };
    }
  }

  /**
   * If `output` exceeds the threshold for `toolName`, persist the full content
   * to disk and return a truncated preview with a retrieval marker.
   * Otherwise returns `output` unchanged.
   */
  async maybeExternalize(
    toolName: string,
    output: string,
    options: OutputPersistenceOptions = {},
  ): Promise<string> {
    const threshold = this.thresholds[toolName] ?? this.thresholds['default'];

    if (output.length <= threshold) {
      return output;
    }

    const captureContext = options.captureContext;
    if (!captureContext) {
      this.recordMigrationError('OUTPUT_PERSISTENCE_CAPTURE_CONTEXT_MISSING', 'unknown', toolName);
      return output;
    }
    const mode = this.dependencies.getMode(captureContext.provider);
    if (mode !== 'off') {
      return this.maybeExternalizeToEvidence(toolName, output, captureContext, mode);
    }

    return output;
  }

  private async maybeExternalizeToEvidence(
    toolName: string,
    output: string,
    context: OutputPersistenceCaptureContext,
    mode: Exclude<ContextEvidenceMode, 'off'>,
  ): Promise<string> {
    if (!context.conversationId?.trim()) {
      this.recordMigrationError('OUTPUT_PERSISTENCE_OWNERSHIP_UNRESOLVED', context.provider, toolName);
      return output;
    }

    const content = new TextEncoder().encode(output);
    try {
      const result = await this.dependencies.getCoordinator().capture({
        captureKey: `output-persistence:${context.conversationId}:${context.turnRef}:${context.logicalCallId}`,
        conversationId: context.conversationId,
        provider: context.provider,
        ...(context.providerThreadRef ? { providerThreadRef: context.providerThreadRef } : {}),
        turnRef: context.turnRef,
        toolCallRef: context.logicalCallId,
        toolName,
        sourceKind: context.sourceKind,
        mimeType: 'text/plain',
        sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated',
        captureMode: context.captureMode,
        captureCompleteness: context.captureCompleteness,
        ...(context.truncationReason ? { truncationReason: context.truncationReason } : {}),
        content,
        observedBoundary: context.observedBoundary,
      });
      if ('errorCode' in result.capture) {
        this.recordMigrationError(result.capture.errorCode, context.provider, toolName);
        return output;
      }
      if (mode === 'shadow') return output;
      return await this.buildAuthenticatedPreview(
        context.conversationId,
        result.capture.record.id,
        output,
        result.capture.record.byteCount,
      );
    } catch (error) {
      this.recordMigrationError(contentFreeErrorCode(error), context.provider, toolName);
      return output;
    } finally {
      content.fill(0);
    }
  }

  private async buildAuthenticatedPreview(
    conversationId: string,
    evidenceId: string,
    output: string,
    byteCount: number,
  ): Promise<string> {
    const codePoints = Array.from(output);
    const headText = codePoints.slice(0, PREVIEW_HEAD_CHARS).join('');
    const tailText = codePoints.slice(-PREVIEW_TAIL_CHARS).join('');
    const headEnd = Math.min(byteCount, Buffer.byteLength(headText, 'utf8'));
    const tailStart = Math.max(headEnd, byteCount - Buffer.byteLength(tailText, 'utf8'));
    const requester = {
      id: 'output-persistence-facade',
      path: 'provider' as const,
      localSensitiveAuthorized: false,
      localRestrictedAuthorized: false,
    };
    const coordinator = this.dependencies.getCoordinator();
    const head = await coordinator.read({
      requester,
      conversationId,
      evidenceId,
      startByte: 0,
      endByte: headEnd,
      tokenLimit: 1_024,
    });
    const tail = await coordinator.read({
      requester,
      conversationId,
      evidenceId,
      startByte: tailStart,
      endByte: byteCount,
      tokenLimit: 1_024,
    });
    return [
      `[BEGIN UNTRUSTED EVIDENCE PREVIEW ${evidenceId}]`,
      head.content,
      formatCitation(head.citation),
      '…',
      tail.content,
      formatCitation(tail.citation),
      'Full authenticated output is available through bounded evidence_read retrieval.',
      `[END UNTRUSTED EVIDENCE PREVIEW ${evidenceId}]`,
    ].join('\n');
  }

  private recordMigrationError(code: string, provider: string, toolName: string): void {
    this.dependencies.recordMigrationError({ code, provider, toolName });
  }

}

export function getOutputPersistenceManager(): OutputPersistenceManager {
  return OutputPersistenceManager.getInstance();
}

function defaultDependencies(): OutputPersistenceDependencies {
  return {
    getMode: (provider) => getContextEvidenceMode(
      getSettingsManager().getAll().contextEvidenceModeByProvider,
      provider,
    ),
    getCoordinator: () => {
      // Keep the evidence runtime lazy so explicit-off and headless compatibility
      // paths do not initialize encrypted storage.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getContextEvidenceCoordinator } = require(
        '../context-evidence/context-evidence-coordinator'
      ) as typeof import('../context-evidence/context-evidence-coordinator');
      return getContextEvidenceCoordinator();
    },
    recordMigrationError: (error) => {
      logger.warn('Large-output evidence migration could not externalize safely', { ...error });
    },
  };
}

function formatCitation(citation: {
  evidenceId: string;
  startByte: number;
  endByte: number;
  contentDigest: string;
}): string {
  return `[evidence:${citation.evidenceId}@${citation.startByte}-${citation.endByte}#${citation.contentDigest}]`;
}

function contentFreeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : 'OUTPUT_PERSISTENCE_EVIDENCE_FAILED';
}
