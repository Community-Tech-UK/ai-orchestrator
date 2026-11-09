import * as os from "os";
import { WebSocket } from "ws";
import type { Instance } from "../../shared/types/instance.types";
import type { LoopState } from "../../shared/types/loop.types";
import {
  MOBILE_OWNER_PROFILE_ID,
  type MobileInstanceDto,
  type MobilePauseDto,
  type MobilePromptDto,
  type MobileQueuedMessageDto,
  type MobileServerEvent,
  type MobileSnapshot,
} from "../../shared/types/mobile-gateway.types";
import { isActiveLoopRuntimeState } from "../orchestration/loop-runtime-status";
import { buildProjects, serializeInstance } from "./mobile-gateway-serializers";
import { isHiddenFromMobile } from "./mobile-gateway-session-visibility";

const SNAPSHOT_COALESCE_MS = 100;

/** Any live event except a snapshot, which is always built per person. */
export type MobileBroadcastEvent = Exclude<MobileServerEvent, { type: "snapshot" }>;

export interface MobileGatewaySnapshotDeps {
  readonly clients: Set<WebSocket>;
  isRunning(): boolean;
  getInstances(): Instance[];
  getPrompts(): MobilePromptDto[];
  getPauseState(): MobilePauseDto;
  getActiveLoops(): Pick<LoopState, "chatId" | "status" | "endedAt">[];
  hasUnreadCompletion(instanceId: string): boolean;
  getQueuedMessages(instanceId: string): MobileQueuedMessageDto[] | undefined;
  /** The person a connected phone belongs to; undefined sends that phone nothing. */
  profileOfClient(client: WebSocket): string | undefined;
  /** The person a session belongs to, including one that has just been removed. */
  profileOfInstance(instanceId: string): string;
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

  /** Everything one person may see: their own sessions and the prompts on them. */
  buildSnapshot(profileId: string): MobileSnapshot {
    const promptCounts = new Map<string, number>();
    const prompts = this.deps
      .getPrompts()
      .filter((prompt) => this.promptProfile(prompt) === profileId);
    for (const prompt of prompts) {
      promptCounts.set(
        prompt.instanceId,
        (promptCounts.get(prompt.instanceId) ?? 0) + 1,
      );
    }

    const activeLoopChatIds = this.activeLoopChatIds();
    const instances = this.deps
      .getInstances()
      // A session with a question waiting is always listed, so its prompt can be answered in context.
      .filter((instance) => instance.status !== "terminated"
        && this.deps.profileOfInstance(instance.id) === profileId
        && (!isHiddenFromMobile(instance) || promptCounts.has(instance.id)))
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
      this.broadcastSnapshots();
    }, SNAPSHOT_COALESCE_MS);
  }

  /** Send each connected phone the snapshot for its own person. */
  broadcastSnapshots(): void {
    this.send((profileId) => ({ type: "snapshot", data: this.buildSnapshot(profileId) }));
  }

  /** Send an event to every connected phone whose person may see it. */
  broadcast(event: MobileBroadcastEvent): void {
    this.send((profileId) => this.eventForProfile(event, profileId));
  }

  private send(forProfile: (profileId: string) => MobileServerEvent | null): void {
    if (this.deps.clients.size === 0) return;
    const rawByProfile = new Map<string, string | null>();
    for (const client of this.deps.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const profileId = this.deps.profileOfClient(client);
      if (profileId === undefined) continue;
      let raw = rawByProfile.get(profileId);
      if (raw === undefined) {
        const event = forProfile(profileId);
        raw = event ? JSON.stringify(event) : null;
        if (event?.type === "snapshot" && raw) this.recordSnapshotMeasurement(raw);
        rawByProfile.set(profileId, raw);
      }
      if (raw !== null) client.send(raw);
    }
  }

  /**
   * What one person receives for an event: session events only for their own
   * sessions, the pause state for everyone (it stops their work too), and all
   * other Harness-wide state for the owner alone. Every event type must be
   * listed here, so a new one cannot reach a member by default.
   */
  private eventForProfile(
    event: MobileBroadcastEvent,
    profileId: string,
  ): MobileServerEvent | null {
    const isOwner = profileId === MOBILE_OWNER_PROFILE_ID;
    switch (event.type) {
      case "instance-output":
      case "instance-created":
        return this.deps.profileOfInstance(
          event.type === "instance-output" ? event.data.instanceId : event.data.id,
        ) === profileId ? event : null;
      case "instance-removed":
        return this.deps.profileOfInstance(event.data.instanceId) === profileId ? event : null;
      case "instance-state": {
        const data = event.data.filter((dto) => this.deps.profileOfInstance(dto.id) === profileId);
        return data.length > 0 ? { type: "instance-state", data } : null;
      }
      case "permission-prompt":
        return this.promptProfile(event.data) === profileId ? event : null;
      case "permission-cleared":
        return event.data.instanceId === undefined
          ? (isOwner ? event : null)
          : this.deps.profileOfInstance(event.data.instanceId) === profileId ? event : null;
      case "pause-state":
        return event;
      case "pong":
      case "quota-state":
      case "loop-state":
      case "plan-queue-state":
        return isOwner ? event : null;
      default: {
        const unhandled: never = event;
        void unhandled;
        return null;
      }
    }
  }

  /** Browser approvals act on the owner's browser, so only the owner sees them. */
  private promptProfile(prompt: MobilePromptDto): string {
    return prompt.kind === "browser"
      ? MOBILE_OWNER_PROFILE_ID
      : this.deps.profileOfInstance(prompt.instanceId);
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
