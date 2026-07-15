import { computed, Injectable, OnDestroy, signal } from '@angular/core';
import type {
  ContextEvidenceCardResponse,
  ContextEvidenceCompareRequest,
  ContextEvidenceCompareResponse,
  ContextEvidenceGetCardRequest,
  ContextEvidenceGetMetricsRequest,
  ContextEvidenceListRequest,
  ContextEvidenceReadRequest,
  ContextEvidenceRendererMetrics,
  ContextEvidenceScope,
  ContextEvidenceSearchMatch,
  ContextEvidenceSearchRequest,
  ContextEvidenceStateChanged,
  ContextEvidenceVerifyRequest,
  ContextEvidenceVerifyResponse,
  EvidenceRecord,
  EvidenceRetrievalResponse,
} from '@contracts/types/context-evidence';
import type { IpcResponse } from '../../../../preload/domains/types';

interface ContextEvidenceApi {
  contextEvidenceList(request: ContextEvidenceListRequest): Promise<IpcResponse<EvidenceRecord[]>>;
  contextEvidenceGetCard(
    request: ContextEvidenceGetCardRequest,
  ): Promise<IpcResponse<ContextEvidenceCardResponse>>;
  contextEvidenceSearch(
    request: ContextEvidenceSearchRequest,
  ): Promise<IpcResponse<ContextEvidenceSearchMatch[]>>;
  contextEvidenceRead(
    request: ContextEvidenceReadRequest,
  ): Promise<IpcResponse<EvidenceRetrievalResponse>>;
  contextEvidenceCompare(
    request: ContextEvidenceCompareRequest,
  ): Promise<IpcResponse<ContextEvidenceCompareResponse>>;
  contextEvidenceVerify(
    request: ContextEvidenceVerifyRequest,
  ): Promise<IpcResponse<ContextEvidenceVerifyResponse>>;
  contextEvidenceGetMetrics(
    request: ContextEvidenceGetMetricsRequest,
  ): Promise<IpcResponse<ContextEvidenceRendererMetrics>>;
  onContextEvidenceStateChanged(
    callback: (update: ContextEvidenceStateChanged) => void,
  ): () => void;
}

@Injectable({ providedIn: 'root' })
export class ContextEvidenceStore implements OnDestroy {
  private readonly scopeState = signal<ContextEvidenceScope | null>(null);
  private readonly recordsState = signal<EvidenceRecord[]>([]);
  private readonly selectedCardState = signal<ContextEvidenceCardResponse | null>(null);
  private readonly searchResultsState = signal<ContextEvidenceSearchMatch[]>([]);
  private readonly readResultState = signal<EvidenceRetrievalResponse | null>(null);
  private readonly compareResultState = signal<ContextEvidenceCompareResponse | null>(null);
  private readonly verifyResultState = signal<ContextEvidenceVerifyResponse | null>(null);
  private readonly metricsState = signal<ContextEvidenceRendererMetrics | null>(null);
  private readonly pendingRequests = signal(0);
  private readonly errorState = signal<string | null>(null);

  readonly scope = this.scopeState.asReadonly();
  readonly records = this.recordsState.asReadonly();
  readonly selectedCard = this.selectedCardState.asReadonly();
  readonly searchResults = this.searchResultsState.asReadonly();
  readonly readResult = this.readResultState.asReadonly();
  readonly compareResult = this.compareResultState.asReadonly();
  readonly verifyResult = this.verifyResultState.asReadonly();
  readonly metrics = this.metricsState.asReadonly();
  readonly loading = computed(() => this.pendingRequests() > 0);
  readonly error = this.errorState.asReadonly();

  readonly occupancy = computed(() => this.metricsState()?.occupancy ?? null);
  readonly cumulativeTokens = computed(() => this.metricsState()?.cumulativeTokens ?? null);
  readonly workingSet = computed(() => this.metricsState()?.workingSet ?? null);
  readonly evidenceRecordCount = computed(() => this.metricsState()?.evidenceRecordCount ?? 0);
  readonly evidenceCardCount = computed(() => this.metricsState()?.evidenceCardCount ?? 0);
  readonly exactExcerptCount = computed(() => this.metricsState()?.exactExcerptCount ?? 0);
  readonly externallyStoredBytes = computed(() => this.metricsState()?.externallyStoredBytes ?? 0);
  readonly modelRequestCount = computed(() => this.metricsState()?.modelRequestCount ?? 0);
  readonly toolCallCount = computed(() => this.metricsState()?.toolCallCount ?? 0);
  readonly toolResultBytes = computed(() => this.metricsState()?.toolResultBytes ?? 0);
  readonly enforcementMode = computed(() => this.metricsState()?.enforcementMode ?? 'off');
  readonly lastAction = computed(() => this.metricsState()?.lastAction ?? null);
  readonly recoveryCount = computed(() => this.metricsState()?.recoveryCount ?? 0);

  private readonly api: ContextEvidenceApi | null;
  private readonly unsubscribe: (() => void) | null;
  private destroyed = false;

  constructor() {
    const exposed = (window as unknown as { electronAPI?: Partial<ContextEvidenceApi> }).electronAPI;
    this.api = (exposed as ContextEvidenceApi | undefined) ?? null;
    this.unsubscribe = this.api?.onContextEvidenceStateChanged
      ? this.api.onContextEvidenceStateChanged((update) => this.applyUpdate(update))
      : null;
  }

  setScope(scope: ContextEvidenceScope | null): void {
    if (sameScope(this.scopeState(), scope)) return;
    this.scopeState.set(scope);
    this.clearConversationState();
  }

  async refresh(): Promise<void> {
    const scope = this.scopeState();
    if (!this.api || !scope) return;
    await this.run(async () => {
      const records = await this.api!.contextEvidenceList({ ...scope, limit: 100 });
      if (!sameScope(this.scopeState(), scope)) return;
      if (!this.accept(records)) return;
      this.recordsState.set(records.data ?? []);
      const metrics = await this.api!.contextEvidenceGetMetrics(scope);
      if (sameScope(this.scopeState(), scope) && this.accept(metrics) && metrics.data) {
        this.metricsState.set(metrics.data);
      }
    });
  }

  async loadCard(cardId: string, tokenLimit: number): Promise<void> {
    await this.withScope((api, scope) => api.contextEvidenceGetCard({
      ...scope, cardId, tokenLimit,
    }), (data) => this.selectedCardState.set(data));
  }

  async search(query: string, tokenLimit: number): Promise<void> {
    await this.withScope((api, scope) => api.contextEvidenceSearch({
      ...scope, query, tokenLimit,
    }), (data) => this.searchResultsState.set(data));
  }

  async read(
    evidenceId: string,
    startByte: number,
    endByte: number,
    tokenLimit: number,
  ): Promise<void> {
    await this.withScope((api, scope) => api.contextEvidenceRead({
      ...scope, evidenceId, startByte, endByte, tokenLimit,
    }), (data) => this.readResultState.set(data));
  }

  async compare(
    left: ContextEvidenceCompareRequest['left'],
    right: ContextEvidenceCompareRequest['right'],
  ): Promise<void> {
    await this.withScope((api, scope) => api.contextEvidenceCompare({
      ...scope, left, right,
    }), (data) => this.compareResultState.set(data));
  }

  async verify(
    evidenceId: string,
    startByte: number,
    endByte: number,
    contentDigest: string,
  ): Promise<void> {
    await this.withScope((api, scope) => api.contextEvidenceVerify({
      ...scope, evidenceId, startByte, endByte, contentDigest,
    }), (data) => this.verifyResultState.set(data));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.();
  }

  ngOnDestroy(): void {
    this.destroy();
  }

  private async withScope<T>(
    request: (api: ContextEvidenceApi, scope: ContextEvidenceScope) => Promise<IpcResponse<T>>,
    apply: (data: T) => void,
  ): Promise<void> {
    const scope = this.scopeState();
    if (!this.api || !scope) return;
    await this.run(async () => {
      const response = await request(this.api!, scope);
      if (sameScope(this.scopeState(), scope)
        && this.accept(response) && response.data !== undefined) apply(response.data);
    });
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    this.pendingRequests.update((count) => count + 1);
    this.errorState.set(null);
    try {
      await operation();
    } catch (error) {
      this.errorState.set(error instanceof Error ? error.message : 'Context evidence is unavailable');
    } finally {
      this.pendingRequests.update((count) => Math.max(0, count - 1));
    }
  }

  private accept<T>(response: IpcResponse<T>): boolean {
    if (response.success) return true;
    this.errorState.set(response.error?.message ?? 'Context evidence is unavailable');
    return false;
  }

  private applyUpdate(update: ContextEvidenceStateChanged): void {
    if (this.scopeState()?.conversationId === update.conversationId) {
      this.metricsState.set(update.metrics);
    }
  }

  private clearConversationState(): void {
    this.recordsState.set([]);
    this.selectedCardState.set(null);
    this.searchResultsState.set([]);
    this.readResultState.set(null);
    this.compareResultState.set(null);
    this.verifyResultState.set(null);
    this.metricsState.set(null);
    this.errorState.set(null);
  }
}

function sameScope(
  left: ContextEvidenceScope | null,
  right: ContextEvidenceScope | null,
): boolean {
  if (!left || !right) return left === right;
  if (left.conversationId !== right.conversationId || left.owner.kind !== right.owner.kind) {
    return false;
  }
  return left.owner.kind === 'chat' && right.owner.kind === 'chat'
    ? left.owner.chatId === right.owner.chatId
    : left.owner.kind === 'instance' && right.owner.kind === 'instance'
      && left.owner.instanceId === right.owner.instanceId;
}
