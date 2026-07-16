import type {
  EvidenceCaptureResult,
  EvidenceSourceKind,
} from '@contracts/types/context-evidence';
import type {
  EvidenceCaptureService,
  EvidenceCaptureServiceInput,
} from './evidence-capture-service';
import {
  EvidenceCardBuildResult,
  EvidenceCardService,
} from './cards/evidence-card-service';
import {
  EvidenceCompareInput,
  calculateEvidenceRangeTokenBudget,
  EvidenceGetCardInput,
  EvidenceListInput,
  EvidenceReadInput,
  EvidenceRetrievalService,
  EvidenceSearchInput,
  EvidenceVerifyInput,
} from './evidence-retrieval-service';
import { ConservativeEvidenceAccessPolicy } from './evidence-access-policy';
import { getContextEvidenceRuntime } from './evidence-maintenance-service';
import { getConversationLedgerService } from '../conversation-ledger';
import {
  WorkingSetPlanner,
  type WorkingSetPlan,
  type WorkingSetPlanInput,
} from './working-set-planner';
import {
  WorkingSetRenderer,
  type RenderedWorkingSet,
} from './working-set-renderer';

export interface ContextEvidenceCaptureService {
  capture(input: EvidenceCaptureServiceInput): Promise<EvidenceCaptureResult>;
}

export interface ContextEvidenceCardService {
  build(input: {
    conversationId: string;
    evidenceId: string;
  }): Promise<EvidenceCardBuildResult>;
}

export interface ContextEvidenceRetrievalService {
  list(input: EvidenceListInput): ReturnType<EvidenceRetrievalService['list']>;
  getCard(input: EvidenceGetCardInput): ReturnType<EvidenceRetrievalService['getCard']>;
  search(input: EvidenceSearchInput): ReturnType<EvidenceRetrievalService['search']>;
  read(input: EvidenceReadInput): ReturnType<EvidenceRetrievalService['read']>;
  compare(input: EvidenceCompareInput): ReturnType<EvidenceRetrievalService['compare']>;
  verify(input: EvidenceVerifyInput): ReturnType<EvidenceRetrievalService['verify']>;
}

export interface ContextEvidenceCoordinatorOptions {
  captureService: ContextEvidenceCaptureService;
  cardService: ContextEvidenceCardService;
  retrievalService: ContextEvidenceRetrievalService;
  workingSetPlanner?: Pick<WorkingSetPlanner, 'plan'>;
  workingSetRenderer?: Pick<WorkingSetRenderer, 'render'>;
  estimateTokens?: (text: string) => number;
  onEvent?: (event: ContextEvidenceCoordinatorEvent) => void;
}

export interface ContextEvidenceCoordinatorEvent {
  kind: 'card-ready' | 'capture-failed' | 'metrics-updated';
  conversationId: string;
  queueId?: string;
  evidenceId?: string;
  failureCode?: string;
  metrics?: ContextEvidenceCaptureMetrics;
}

export interface ContextEvidenceCaptureMetrics {
  attempted: number;
  captured: number;
  duplicates: number;
  conflicts: number;
  failed: number;
  capturedBytes: number;
}

export interface AioMcpEvidenceCaptureInput {
  queueId: string;
  conversationId: string;
  captureKey: string;
  turnRef?: string;
  toolCallRef?: string;
  toolName: string;
  result: unknown;
  providerWindowTokens?: number;
}

export interface AioMcpEvidenceCaptureResult {
  providerResult: unknown;
  capture: EvidenceCaptureResult;
  card?: EvidenceCardBuildResult;
}

export interface RuntimeToolResultEvidenceCaptureInput {
  queueId: string;
  conversationId: string;
  captureKey: string;
  provider: string;
  providerThreadRef?: string;
  turnRef?: string;
  toolCallRef?: string;
  toolName: string;
  sourceKind: EvidenceSourceKind;
  mimeType: string;
  content: Uint8Array;
}

export interface ContextEvidenceWorkingSet {
  plan: WorkingSetPlan;
  rendered: RenderedWorkingSet | null;
}

/** Sole orchestration entrypoint for durable capture, card derivation, and retrieval. */
export class ContextEvidenceCoordinator {
  private readonly queueTails = new Map<string, Promise<void>>();
  private readonly captureMetrics = new Map<string, ContextEvidenceCaptureMetrics>();
  private readonly eventSubscribers = new Set<(event: ContextEvidenceCoordinatorEvent) => void>();

  constructor(private readonly options: ContextEvidenceCoordinatorOptions) {}

  subscribe(listener: (event: ContextEvidenceCoordinatorEvent) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => this.eventSubscribers.delete(listener);
  }

  capture(input: EvidenceCaptureServiceInput): Promise<{
    capture: EvidenceCaptureResult;
    card?: EvidenceCardBuildResult;
  }> {
    return this.captureAndBuild(input);
  }

  captureAioMcpResult(input: AioMcpEvidenceCaptureInput): Promise<AioMcpEvidenceCaptureResult> {
    const content = encodeProviderResult(input.result);
    return this.enqueue(input.queueId, async () => {
      const result = await this.captureAndBuild({
        captureKey: input.captureKey,
        conversationId: input.conversationId,
        provider: 'orchestrator',
        ...(input.turnRef ? { turnRef: input.turnRef } : {}),
        ...(input.toolCallRef ? { toolCallRef: input.toolCallRef } : {}),
        toolName: input.toolName,
        sourceKind: 'mcp',
        mimeType: 'application/json',
        sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated',
        captureMode: 'pre-retention',
        captureCompleteness: 'complete',
        content,
        observedBoundary: 'before-provider-retention',
      });
      return {
        providerResult: 'errorCode' in result.capture
          ? input.result
          : projectProviderResult(
              input.result,
              content,
              result.capture.record.id,
              input.providerWindowTokens,
              this.options.estimateTokens ?? estimateTokensConservatively,
            ),
        ...result,
      };
    }).finally(() => content.fill(0));
  }

  captureRuntimeToolResult(input: RuntimeToolResultEvidenceCaptureInput): Promise<{
    capture: EvidenceCaptureResult;
    card?: EvidenceCardBuildResult;
  }> {
    const content = Uint8Array.from(input.content);
    return this.enqueue(input.queueId, async () => {
      const result = await this.captureAndBuild({
        captureKey: input.captureKey,
        conversationId: input.conversationId,
        provider: input.provider,
        ...(input.providerThreadRef ? { providerThreadRef: input.providerThreadRef } : {}),
        ...(input.turnRef ? { turnRef: input.turnRef } : {}),
        ...(input.toolCallRef ? { toolCallRef: input.toolCallRef } : {}),
        toolName: input.toolName,
        sourceKind: input.sourceKind,
        mimeType: input.mimeType,
        sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated',
        captureMode: 'post-retention',
        captureCompleteness: 'complete',
        content,
        observedBoundary: 'after-provider-retention',
      });
      this.recordCaptureMetric(input, result.capture, content.byteLength);
      return result;
    }).finally(() => content.fill(0));
  }

  async drain(queueId: string): Promise<void> {
    await this.queueTails.get(queueId);
  }

  list(input: EvidenceListInput): ReturnType<ContextEvidenceRetrievalService['list']> {
    return this.options.retrievalService.list(input);
  }

  getCard(input: EvidenceGetCardInput): ReturnType<ContextEvidenceRetrievalService['getCard']> {
    return this.options.retrievalService.getCard(input);
  }

  search(input: EvidenceSearchInput): ReturnType<ContextEvidenceRetrievalService['search']> {
    return this.options.retrievalService.search(input);
  }

  read(input: EvidenceReadInput): ReturnType<ContextEvidenceRetrievalService['read']> {
    return this.options.retrievalService.read(input);
  }

  compare(input: EvidenceCompareInput): ReturnType<ContextEvidenceRetrievalService['compare']> {
    return this.options.retrievalService.compare(input);
  }

  verify(input: EvidenceVerifyInput): ReturnType<ContextEvidenceRetrievalService['verify']> {
    return this.options.retrievalService.verify(input);
  }

  assembleWorkingSet(input: WorkingSetPlanInput): ContextEvidenceWorkingSet {
    const plan = (this.options.workingSetPlanner ?? new WorkingSetPlanner()).plan(input);
    return {
      plan,
      rendered: plan.status === 'paused'
        ? null
        : (this.options.workingSetRenderer ?? new WorkingSetRenderer()).render(plan),
    };
  }

  private async captureAndBuild(input: EvidenceCaptureServiceInput): Promise<{
    capture: EvidenceCaptureResult;
    card?: EvidenceCardBuildResult;
  }> {
    const capture = await this.options.captureService.capture(input);
    if ('errorCode' in capture) {
      this.emitEvent({
        kind: 'capture-failed',
        conversationId: input.conversationId,
        failureCode: capture.errorCode,
      });
      return { capture };
    }
    const card = await this.options.cardService.build({
      conversationId: input.conversationId,
      evidenceId: capture.record.id,
    });
    this.emitEvent({
      kind: 'card-ready',
      conversationId: input.conversationId,
      evidenceId: capture.record.id,
    });
    return { capture, card };
  }

  private enqueue<T>(queueId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queueTails.get(queueId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const tail = pending.then(() => undefined, () => undefined);
    this.queueTails.set(queueId, tail);
    void tail.finally(() => {
      if (this.queueTails.get(queueId) === tail) this.queueTails.delete(queueId);
    });
    return pending;
  }

  private recordCaptureMetric(
    input: Pick<RuntimeToolResultEvidenceCaptureInput, 'queueId' | 'conversationId'>,
    result: EvidenceCaptureResult,
    byteCount: number,
  ): void {
    const metrics = this.captureMetrics.get(input.queueId) ?? {
      attempted: 0,
      captured: 0,
      duplicates: 0,
      conflicts: 0,
      failed: 0,
      capturedBytes: 0,
    };
    metrics.attempted += 1;
    if (result.status === 'captured') {
      metrics.captured += 1;
      metrics.capturedBytes += byteCount;
    } else if (result.status === 'duplicate') {
      metrics.duplicates += 1;
    } else if (result.status === 'conflict') {
      metrics.conflicts += 1;
    } else {
      metrics.failed += 1;
    }
    this.captureMetrics.set(input.queueId, metrics);
    this.emitEvent({
      kind: 'metrics-updated',
      queueId: input.queueId,
      conversationId: input.conversationId,
      metrics: { ...metrics },
    });
  }

  private emitEvent(event: ContextEvidenceCoordinatorEvent): void {
    this.options.onEvent?.(event);
    for (const subscriber of this.eventSubscribers) subscriber(event);
  }
}

function encodeProviderResult(result: unknown): Uint8Array {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    throw new Error('MCP_RESULT_NOT_JSON_SERIALIZABLE');
  }
  return new TextEncoder().encode(serialized);
}

function projectProviderResult(
  original: unknown,
  serialized: Uint8Array,
  evidenceId: string,
  providerWindowTokens: number | undefined,
  estimateTokens: (text: string) => number,
): unknown {
  const budget = calculateEvidenceRangeTokenBudget(providerWindowTokens);
  const serializedText = new TextDecoder().decode(serialized);
  if (estimateTokens(serializedText) <= budget) return original;
  const codePoints = Array.from(serializedText);
  const build = (preview: string) => ({
    evidenceId,
    byteCount: serialized.byteLength,
    captureCompleteness: 'complete',
    truncated: true,
    trustBoundary: 'untrusted-source-material',
    preview,
    disclosure: 'Full MCP result was captured before provider retention. Use evidence_read for exact ranges.',
  });
  let low = 0;
  let high = codePoints.length;
  let accepted = build('');
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = build(codePoints.slice(0, middle).join(''));
    if (estimateTokens(JSON.stringify(candidate)) <= budget) {
      accepted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return accepted;
}

function estimateTokensConservatively(text: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4));
}

let defaultCoordinator: ContextEvidenceCoordinator | null = null;

/** Returns the initialized production coordinator above the fail-closed runtime. */
export function getContextEvidenceCoordinator(): ContextEvidenceCoordinator {
  if (defaultCoordinator) return defaultCoordinator;
  const runtime = getContextEvidenceRuntime();
  const ledger = getConversationLedgerService();
  const policy = new ConservativeEvidenceAccessPolicy();
  const estimateTokens = estimateTokensConservatively;
  defaultCoordinator = new ContextEvidenceCoordinator({
    captureService: runtime.captureService,
    cardService: new EvidenceCardService({
      ledger,
      blobStore: runtime.blobStore,
      policy,
      estimateTokens,
    }),
    retrievalService: new EvidenceRetrievalService({
      ledger,
      blobStore: runtime.blobStore,
      policy,
      estimateTokens,
    }),
    workingSetPlanner: new WorkingSetPlanner(),
    workingSetRenderer: new WorkingSetRenderer(),
    estimateTokens,
  });
  return defaultCoordinator;
}

/** Drain an existing ingress queue without initializing an evidence runtime. */
export async function drainContextEvidenceQueue(queueId: string): Promise<void> {
  await defaultCoordinator?.drain(queueId);
}

export function _resetContextEvidenceCoordinatorForTesting(): void {
  defaultCoordinator = null;
}

// Compile-time compatibility with the concrete services used by the runtime.
const _captureServiceCompatibility: ContextEvidenceCaptureService | undefined =
  undefined as EvidenceCaptureService | undefined;
const _cardServiceCompatibility: ContextEvidenceCardService | undefined =
  undefined as EvidenceCardService | undefined;
void _captureServiceCompatibility;
void _cardServiceCompatibility;
