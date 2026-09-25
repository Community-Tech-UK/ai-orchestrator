import * as os from "os";
import { WebSocket } from "ws";
import type { Instance } from "../../shared/types/instance.types";
import type { LoopState } from "../../shared/types/loop.types";
import type {
  MobileInstanceDto,
  MobilePauseDto,
  MobilePromptDto,
  MobileQueuedMessageDto,
  MobileServerEvent,
  MobileSnapshot,
} from "../../shared/types/mobile-gateway.types";
import { isActiveLoopRuntimeState } from "../orchestration/loop-runtime-status";
import { buildProjects, serializeInstance } from "./mobile-gateway-serializers";

const SNAPSHOT_COALESCE_MS = 100;

export interface MobileGatewaySnapshotDeps {
  readonly clients: Set<WebSocket>;
  isRunning(): boolean;
  getInstances(): Instance[];
  getPrompts(): MobilePromptDto[];
  getPauseState(): MobilePauseDto;
  getActiveLoops(): Pick<LoopState, "chatId" | "status" | "endedAt">[];
  hasUnreadCompletion(instanceId: string): boolean;
  getQueuedMessages(instanceId: string): MobileQueuedMessageDto[] | undefined;
  debug?(message: string, data: Record<string, unknown>): void;
  now?(): number;
}

/** Builds snapshots and owns their coalesced WebSocket broadcast timer. */
export class MobileGatewaySnapshotService {
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly snapshotBroadcasts: number[] = [];

  constructor(private readonly deps: MobileGatewaySnapshotDeps) {}

  stop(): void {
    if (!this.snapshotTimer) return;
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  buildSnapshot(): MobileSnapshot {
    const promptCounts = new Map<string, number>();
    const prompts = this.deps.getPrompts();
    for (const prompt of prompts) {
      promptCounts.set(
        prompt.instanceId,
        (promptCounts.get(prompt.instanceId) ?? 0) + 1,
      );
    }

    const activeLoopChatIds = this.activeLoopChatIds();
    const instances = this.deps
      .getInstances()
      .filter((instance) => instance.status !== "terminated")
      .map((instance) => this.serializeInstance(instance, activeLoopChatIds))
      .map((dto) => this.withTransientState(dto, promptCounts));

    return {
      hostName: os.hostname(),
      serverTime: Date.now(),
      instances,
      projects: buildProjects(instances),
      prompts,
      pause: this.deps.getPauseState(),
    };
  }

  serializeInstance(
    instance: Instance,
    activeLoopChatIds = this.activeLoopChatIds(),
  ): MobileInstanceDto {
    return serializeInstance(instance, {
      isLooping: activeLoopChatIds.has(instance.id),
    });
  }

  scheduleBroadcast(): void {
    if (this.snapshotTimer || !this.deps.isRunning()) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.broadcast({ type: "snapshot", data: this.buildSnapshot() });
    }, SNAPSHOT_COALESCE_MS);
  }

  broadcast(event: MobileServerEvent): void {
    if (this.deps.clients.size === 0) return;
    const raw = JSON.stringify(event);
    if (event.type === "snapshot") this.recordSnapshotMeasurement(raw);
    for (const client of this.deps.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
  }

  private recordSnapshotMeasurement(raw: string): void {
    const now = this.deps.now?.() ?? Date.now();
    this.snapshotBroadcasts.push(now);
    while (this.snapshotBroadcasts[0] !== undefined && this.snapshotBroadcasts[0] <= now - 1000) {
      this.snapshotBroadcasts.shift();
    }
    this.deps.debug?.("Mobile snapshot broadcast", {
      bytes: Buffer.byteLength(raw, "utf8"),
      broadcastsPerSecond: this.snapshotBroadcasts.length,
      instanceCount: JSON.parse(raw).data.instances.length,
    });
  }

  private withTransientState(
    dto: MobileInstanceDto,
    promptCounts: Map<string, number>,
  ): MobileInstanceDto {
    const pending = promptCounts.get(dto.id);
    const unread = this.deps.hasUnreadCompletion(dto.id);
    const queued = this.deps.getQueuedMessages(dto.id);
    if (pending === undefined && !unread && !queued) return dto;
    return {
      ...dto,
      ...(pending !== undefined ? { pendingApprovalCount: pending } : {}),
      ...(queued ? { queuedMessages: queued } : {}),
      hasUnreadCompletion: unread,
    };
  }

  private activeLoopChatIds(): Set<string> {
    const ids = new Set<string>();
    for (const loop of this.deps.getActiveLoops()) {
      if (loop.chatId && isActiveLoopRuntimeState(loop)) ids.add(loop.chatId);
    }
    return ids;
  }
}
