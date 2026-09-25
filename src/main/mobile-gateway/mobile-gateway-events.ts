import type { LoopState } from "../../shared/types/loop.types";
import type { ProviderRuntimeEventEnvelope } from "@contracts/types/provider-runtime-events";
import type {
  MobilePauseDto,
  MobileServerEvent,
} from "../../shared/types/mobile-gateway.types";
import { toOutputMessageFromProviderEnvelope } from "../providers/provider-output-event";
import {
  serializeMessage,
  WAITING_STATUSES,
  WORKING_STATUSES,
} from "./mobile-gateway-serializers";
import type { GatewayInstanceSource } from "./mobile-gateway-instance-routes";
import type { MobileGatewayPromptStore } from "./mobile-gateway-prompt-store";
import type { MobileGatewayStreamCursor } from "./mobile-gateway-stream-cursor";

/** Minimal EventEmitter surface the gateway subscribes to and detaches from. */
export interface EmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(
    event: string,
    listener: (...args: unknown[]) => void,
  ): unknown;
}

export interface GatewayPauseSource extends EmitterLike {
  toPayload(): MobilePauseDto;
  addReason(reason: "user", meta?: Record<string, unknown>): void;
  removeReason(reason: "user"): void;
}

export interface GatewayLoopSource extends EmitterLike {
  getActiveLoops(): Pick<LoopState, "chatId" | "status" | "endedAt">[];
}

export interface MobileGatewayEventDeps {
  getInstanceSource(): GatewayInstanceSource;
  getPauseSource(): GatewayPauseSource;
  getLoopSource(): GatewayLoopSource | null;
  getPauseState(): MobilePauseDto;
  promptStore: MobileGatewayPromptStore;
  streamCursor: MobileGatewayStreamCursor;
  hasClients(): boolean;
  broadcast(event: MobileServerEvent): void;
  scheduleSnapshotBroadcast(): void;
  isInstanceBeingViewed(instanceId: string): boolean;
  clearInstanceQueue(instanceId: string): void;
  clearSendInFlight(instanceId: string): void;
  drainQueue(instanceId: string): void;
  drainAllQueues(): void;
  sendCompletionPush(instanceId: string): void;
  sendLiveActivityPush(
    instanceId: string,
    status: string,
    event?: "update" | "end",
  ): void;
  clearLiveActivityTokens(instanceId: string): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/** Owns gateway listener lifecycle, state edges, and completion tracking. */
export class MobileGatewayEvents {
  private readonly lastStatusByInstance = new Map<string, string>();
  private readonly unreadCompletions = new Set<string>();
  private orchestration: EmitterLike | null = null;
  private attachedPause: GatewayPauseSource | null = null;
  private attachedLoop: GatewayLoopSource | null = null;

  private readonly onInstanceCreated = () =>
    this.deps.scheduleSnapshotBroadcast();
  private readonly onInstanceRemoved = (instanceId: unknown) =>
    this.handleInstanceRemoved(String(instanceId));
  private readonly onStateUpdate = (update: unknown) =>
    this.handleStateUpdate(update);
  private readonly onBatchUpdate = (updates: unknown) =>
    this.handleBatchUpdate(updates);
  private readonly onProviderEvent = (envelope: unknown) =>
    this.handleProviderEvent(envelope as ProviderRuntimeEventEnvelope);
  private readonly onInputRequired = (payload: unknown) =>
    this.deps.promptStore.handleInputRequired(payload);
  private readonly onInputRequiredResolved = (payload: unknown) =>
    this.deps.promptStore.handleInputRequiredResolved(payload);
  private readonly onUserAction = (request: unknown) =>
    this.deps.promptStore.handleUserAction(request);
  private readonly onPauseChange = () => {
    this.deps.broadcast({
      type: "pause-state",
      data: this.deps.getPauseState(),
    });
    if (!this.deps.getPauseState().isPaused) this.deps.drainAllQueues();
  };
  private readonly onLoopStateChanged = () =>
    this.deps.scheduleSnapshotBroadcast();

  constructor(private readonly deps: MobileGatewayEventDeps) {}

  attach(): void {
    const instanceManager = this.deps.getInstanceSource();
    this.lastStatusByInstance.clear();
    for (const instance of instanceManager.getAllInstances()) {
      this.lastStatusByInstance.set(instance.id, instance.status);
    }
    instanceManager.on("instance:created", this.onInstanceCreated);
    instanceManager.on("instance:removed", this.onInstanceRemoved);
    instanceManager.on("instance:state-update", this.onStateUpdate);
    instanceManager.on("instance:batch-update", this.onBatchUpdate);
    instanceManager.on("provider:normalized-event", this.onProviderEvent);
    instanceManager.on("instance:input-required", this.onInputRequired);
    instanceManager.on(
      "instance:input-required-resolved",
      this.onInputRequiredResolved,
    );

    try {
      this.orchestration = instanceManager.getOrchestrationHandler();
      this.orchestration.on("user-action-request", this.onUserAction);
    } catch (error) {
      this.deps.warn(
        "Could not attach orchestration listener",
        this.errorData(error),
      );
    }

    try {
      this.attachedPause = this.deps.getPauseSource();
      this.attachedPause.on("change", this.onPauseChange);
    } catch (error) {
      this.deps.warn("Could not attach pause listener", this.errorData(error));
    }

    try {
      this.attachedLoop = this.deps.getLoopSource();
      this.attachedLoop?.on("loop:state-changed", this.onLoopStateChanged);
    } catch (error) {
      this.deps.warn("Could not attach loop listener", this.errorData(error));
    }
  }

  detach(): void {
    const instanceManager = this.deps.getInstanceSource();
    instanceManager.removeListener("instance:created", this.onInstanceCreated);
    instanceManager.removeListener("instance:removed", this.onInstanceRemoved);
    instanceManager.removeListener("instance:state-update", this.onStateUpdate);
    instanceManager.removeListener("instance:batch-update", this.onBatchUpdate);
    instanceManager.removeListener(
      "provider:normalized-event",
      this.onProviderEvent,
    );
    instanceManager.removeListener(
      "instance:input-required",
      this.onInputRequired,
    );
    instanceManager.removeListener(
      "instance:input-required-resolved",
      this.onInputRequiredResolved,
    );
    this.orchestration?.removeListener(
      "user-action-request",
      this.onUserAction,
    );
    this.orchestration = null;
    this.attachedPause?.removeListener("change", this.onPauseChange);
    this.attachedPause = null;
    this.attachedLoop?.removeListener(
      "loop:state-changed",
      this.onLoopStateChanged,
    );
    this.attachedLoop = null;
  }

  hasUnreadCompletion(instanceId: string): boolean {
    return this.unreadCompletions.has(instanceId);
  }

  markCompletionViewed(instanceId: string): void {
    if (this.unreadCompletions.delete(instanceId))
      this.deps.scheduleSnapshotBroadcast();
  }

  private handleInstanceRemoved(instanceId: string): void {
    this.deps.promptStore.clearForInstance(instanceId);
    this.deps.clearInstanceQueue(instanceId);
    this.deps.clearSendInFlight(instanceId);
    this.lastStatusByInstance.delete(instanceId);
    this.unreadCompletions.delete(instanceId);
    this.deps.streamCursor.drop(instanceId);
    this.deps.sendLiveActivityPush(instanceId, "idle", "end");
    this.deps.clearLiveActivityTokens(instanceId);
    this.deps.scheduleSnapshotBroadcast();
  }

  private handleStateUpdate(update: unknown): void {
    const state = update as { instanceId?: string; status?: string };
    if (state.instanceId && state.status)
      this.handleStatus(state.instanceId, state.status);
    this.deps.scheduleSnapshotBroadcast();
  }

  private handleBatchUpdate(updates: unknown): void {
    const batch = updates as {
      updates?: { instanceId?: string; status?: string }[];
    };
    for (const state of batch.updates ?? []) {
      if (state.instanceId && state.status)
        this.handleStatus(state.instanceId, state.status);
    }
    this.deps.scheduleSnapshotBroadcast();
  }

  private handleStatus(instanceId: string, status: string): void {
    if (!WAITING_STATUSES.has(status))
      this.deps.promptStore.clearForInstance(instanceId);
    this.notifyCompletionOnIdle(instanceId, status);
    this.deps.drainQueue(instanceId);
  }

  private notifyCompletionOnIdle(instanceId: string, status: string): void {
    const previous = this.lastStatusByInstance.get(instanceId);
    this.lastStatusByInstance.set(instanceId, status);
    const wasActivityCandidate = previous !== undefined &&
      (WORKING_STATUSES.has(previous) || WAITING_STATUSES.has(previous));
    const isActivityCandidate = WORKING_STATUSES.has(status) || WAITING_STATUSES.has(status);
    if (previous !== status && isActivityCandidate) {
      this.deps.sendLiveActivityPush(instanceId, status);
    } else if (previous !== status && wasActivityCandidate) {
      this.deps.sendLiveActivityPush(instanceId, status, "end");
      this.deps.clearLiveActivityTokens(instanceId);
    }
    if (WORKING_STATUSES.has(status)) {
      this.unreadCompletions.delete(instanceId);
      return;
    }
    if (!previous || !WORKING_STATUSES.has(previous) || status !== "idle")
      return;
    if (!this.deps.isInstanceBeingViewed(instanceId))
      this.unreadCompletions.add(instanceId);
    this.deps.sendCompletionPush(instanceId);
  }

  private handleProviderEvent(envelope: ProviderRuntimeEventEnvelope): void {
    if (!this.deps.hasClients()) return;
    const message = toOutputMessageFromProviderEnvelope(envelope);
    if (!message) return;
    if (serializeMessage(message) === null) return;
    const buffer = this.deps.getInstanceSource().getInstance(envelope.instanceId)?.outputBuffer ?? [];
    const cursor = this.deps.streamCursor.recordLive(envelope.instanceId, buffer, message);
    const dto = serializeMessage(cursor.message, cursor.bufferIndex);
    if (dto === null) return;
    this.deps.broadcast({
      type: "instance-output",
      data: {
        instanceId: envelope.instanceId,
        seq: envelope.seq,
        streamSeq: cursor.streamSeq,
        bufferIndex: cursor.bufferIndex,
        bufferGeneration: cursor.bufferGeneration,
        cursorEpoch: cursor.cursorEpoch,
        ...(envelope.adapterGeneration !== undefined
          ? { adapterGeneration: envelope.adapterGeneration }
          : {}),
        message: dto,
      },
    });
  }

  private errorData(error: unknown): Record<string, unknown> {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
