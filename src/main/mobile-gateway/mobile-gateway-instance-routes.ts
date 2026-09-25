import type { IncomingMessage, ServerResponse } from "http";
import type {
  FileAttachment,
  Instance,
  InstanceCreateConfig,
  InterruptOrigin,
} from "../../shared/types/instance.types";
import type {
  MobileInputResponse,
  MobileInstanceDto,
  MobilePauseDto,
  MobileQueuedMessageDto,
} from "../../shared/types/mobile-gateway.types";
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../../shared/types/provider.types";
import type { SubsystemLogger } from "../logging/logger";
import {
  getIdempotencyStore,
  IdempotencyStore,
} from "../transport/idempotency-store";
import { getUnifiedModelCatalog } from "../providers/unified-model-catalog-service";
import type { EmitterLike } from "./mobile-gateway-events";
import { handleMobileInstanceMessages } from "./mobile-gateway-history-handlers";
import { readJsonBody, sendJsonResponse } from "./mobile-gateway-http-utils";
import {
  handleMobileModelRoutes,
  type MobileModelCatalogSource,
  type MobileModelLister,
} from "./mobile-gateway-model-handlers";
import type { MobileGatewayPromptStore } from "./mobile-gateway-prompt-store";
import { resolveMobileSessionPlan } from "./mobile-gateway-session-plan";
import type { MobileGatewayStreamCursor } from "./mobile-gateway-stream-cursor";
import {
  handleMobileQueueRoutes,
  MobileInputQueue,
  shouldQueueInput,
} from "./mobile-input-queue";

const MESSAGE_REPLAY_LIMIT = 300;
const VALID_PROVIDERS = new Set([
  "auto",
  "claude",
  "codex",
  "gemini",
  "antigravity",
  "copilot",
  "cursor",
  "grok",
  "opencode",
]);
const VALID_REASONING_EFFORTS = new Set<string>(REASONING_EFFORTS);

export interface GatewayOrchestrationSource extends EmitterLike {
  respondToUserAction(
    requestId: string,
    approved: boolean,
    selectedOption?: string,
  ): void;
}

export interface GatewayInstanceSource extends EmitterLike {
  getAllInstances(): Instance[];
  getInstance(id: string): Instance | undefined;
  sendInput(
    instanceId: string,
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void>;
  interruptInstance(instanceId: string, origin?: InterruptOrigin): boolean;
  terminateInstance(instanceId: string, graceful?: boolean): Promise<void>;
  resumeAfterDeferredPermission(
    instanceId: string,
    approved: boolean,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
  recordInputRequiredPermissionDecision(params: {
    instanceId: string;
    requestId: string;
    action: "allow" | "deny";
    scope: "once" | "session" | "always";
  }): void;
  clearPendingInputRequiredPermission(
    instanceId: string,
    requestId: string,
  ): void;
  renameInstance(instanceId: string, displayName: string): void;
  changeModel(instanceId: string, newModel: string): Promise<Instance>;
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
  getOrchestrationHandler(): GatewayOrchestrationSource;
}

export interface MobileGatewayInstanceRouteDeps {
  getInstanceSource(): GatewayInstanceSource;
  getPauseState(): MobilePauseDto;
  promptStore: MobileGatewayPromptStore;
  streamCursor: MobileGatewayStreamCursor;
  markCompletionViewed(instanceId: string): void;
  scheduleSnapshotBroadcast(): void;
  buildSnapshotInstances(): MobileInstanceDto[];
  serializeInstance(instance: Instance): MobileInstanceDto;
  resolveNodeId(nameOrId: string): string | null;
  getModelCatalog(): MobileModelCatalogSource | undefined;
  getListDynamicModels(): MobileModelLister | undefined;
  logger: SubsystemLogger;
}

/** Routes and queue state for every `/api/instances` command. */
export class MobileGatewayInstanceRoutes {
  private readonly sendInFlight = new Set<string>();
  private readonly inputQueue: MobileInputQueue;

  constructor(private readonly deps: MobileGatewayInstanceRouteDeps) {
    this.inputQueue = new MobileInputQueue({
      getInstance: (instanceId) => this.source().getInstance(instanceId),
      isPaused: (instanceId) =>
        this.deps.getPauseState().isPaused || this.sendInFlight.has(instanceId),
      deliver: (instanceId, message, attachments) =>
        this.dispatchSend(instanceId, message, attachments),
      onChange: () => this.deps.scheduleSnapshotBroadcast(),
      logger: deps.logger,
    });
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    segments: string[],
    method: string,
  ): Promise<boolean> {
    if (
      await handleMobileModelRoutes(
        this.modelDeps(),
        req,
        res,
        segments,
        method,
      )
    )
      return true;
    if (
      segments[1] === "session-plan" &&
      segments.length === 2 &&
      method === "GET"
    ) {
      await this.handleSessionPlan(res, url);
      return true;
    }
    if (segments[1] !== "instances") return false;

    if (segments.length === 2) {
      if (method === "GET") {
        sendJsonResponse(res, 200, this.deps.buildSnapshotInstances());
        return true;
      }
      if (method === "POST") {
        await this.handleCreate(req, res);
        return true;
      }
    }

    if (segments.length === 4) {
      const instanceId = decodeURIComponent(segments[2]);
      const action = segments[3];
      if (action === "messages" && method === "GET") {
        this.handleMessages(res, instanceId, url);
        return true;
      }
      if (action === "input" && method === "POST") {
        await this.handleInput(req, res, instanceId);
        return true;
      }
      if (action === "respond" && method === "POST") {
        await this.handleRespond(req, res, instanceId);
        return true;
      }
      if (action === "interrupt" && method === "POST") {
        await this.handleInterrupt(req, res, instanceId);
        return true;
      }
      if (action === "terminate" && method === "POST") {
        await this.handleTerminate(req, res, instanceId);
        return true;
      }
      if (action === "rename" && method === "POST") {
        await this.handleRename(req, res, instanceId);
        return true;
      }
    }

    return handleMobileQueueRoutes(this.inputQueue, res, segments, method);
  }

  queuedMessages(instanceId: string): MobileQueuedMessageDto[] | undefined {
    return this.inputQueue.toDto(instanceId);
  }

  clearInstance(instanceId: string): void {
    this.inputQueue.clear(instanceId);
  }

  clearSendInFlight(instanceId: string): void {
    this.sendInFlight.delete(instanceId);
  }

  clearAll(): void {
    this.inputQueue.clearAll();
  }

  drain(instanceId: string): void {
    void this.inputQueue.drain(instanceId);
  }

  drainAll(): void {
    for (const instance of this.source().getAllInstances())
      void this.inputQueue.drain(instance.id);
  }

  private source(): GatewayInstanceSource {
    return this.deps.getInstanceSource();
  }

  private modelDeps() {
    return {
      instanceManager: this.source(),
      modelCatalog: this.deps.getModelCatalog() ?? getUnifiedModelCatalog(),
      listDynamicModels: this.deps.getListDynamicModels(),
      serializeInstance: (instance: Instance) =>
        this.deps.serializeInstance(instance),
      logger: this.deps.logger,
    };
  }

  private async handleSessionPlan(
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const provider = url.searchParams.get("provider") ?? undefined;
    const model = url.searchParams.get("model") ?? undefined;
    const requestedEffort = url.searchParams.get("reasoningEffort");
    const reasoningEffort =
      requestedEffort && VALID_REASONING_EFFORTS.has(requestedEffort)
        ? (requestedEffort as ReasoningEffort)
        : undefined;
    const plan = await resolveMobileSessionPlan({
      provider,
      model,
      reasoningEffort,
    });
    sendJsonResponse(res, 200, plan);
  }

  private handleMessages(
    res: ServerResponse,
    instanceId: string,
    url: URL,
  ): void {
    handleMobileInstanceMessages(
      {
        getInstance: (id) => this.source().getInstance(id),
        streamCursor: this.deps.streamCursor,
        markCompletionViewed: (id) => this.deps.markCompletionViewed(id),
        messageReplayLimit: MESSAGE_REPLAY_LIMIT,
        sendJson: (response, code, payload) =>
          sendJsonResponse(response, code, payload),
        logger: this.deps.logger,
      },
      res,
      instanceId,
      url,
    );
  }

  private async handleInput(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as {
      message?: unknown;
      attachments?: unknown;
      idempotencyKey?: unknown;
    };
    const message = typeof body.message === "string" ? body.message : "";
    const attachments = Array.isArray(body.attachments)
      ? (body.attachments as FileAttachment[])
      : undefined;
    if (!message && (!attachments || attachments.length === 0)) {
      sendJsonResponse(res, 400, { error: "message or attachments required" });
      return;
    }
    const instance = this.source().getInstance(instanceId);
    if (!instance) {
      sendJsonResponse(res, 404, { error: "Instance not found" });
      return;
    }
    this.deps.markCompletionViewed(instanceId);

    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
    if (
      idempotencyKey &&
      getIdempotencyStore().isDuplicate(
        IdempotencyStore.compose("input", instanceId, idempotencyKey),
      )
    ) {
      const duplicate: MobileInputResponse = { ok: true, duplicate: true };
      sendJsonResponse(res, 200, duplicate);
      return;
    }

    if (
      shouldQueueInput(instance, this.deps.getPauseState().isPaused) ||
      this.sendInFlight.has(instanceId)
    ) {
      const parked = this.inputQueue.enqueue(instanceId, message, attachments);
      if (!parked) {
        sendJsonResponse(res, 429, {
          error:
            "Too many messages queued for this session — wait for it to catch up.",
        });
        return;
      }
      void this.inputQueue.drain(instanceId);
      const queued: MobileInputResponse = {
        ok: true,
        queued: true,
        queueId: parked.id,
      };
      sendJsonResponse(res, 200, queued);
      return;
    }

    await this.dispatchSend(instanceId, message, attachments);
    const sent: MobileInputResponse = { ok: true };
    sendJsonResponse(res, 200, sent);
  }

  private async dispatchSend(
    instanceId: string,
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    this.sendInFlight.add(instanceId);
    try {
      await this.source().sendInput(instanceId, message, attachments);
    } finally {
      this.sendInFlight.delete(instanceId);
    }
  }

  private async handleRespond(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as {
      requestId?: unknown;
      decisionAction?: unknown;
      decisionScope?: unknown;
      response?: unknown;
      updatedInput?: unknown;
      idempotencyKey?: unknown;
    };
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const decisionAction =
      body.decisionAction === "allow" ||
      body.decisionAction === "deny" ||
      body.decisionAction === "modify"
        ? body.decisionAction
        : null;
    const decisionScope =
      body.decisionScope === "once" ||
      body.decisionScope === "session" ||
      body.decisionScope === "always"
        ? body.decisionScope
        : undefined;

    let updatedInput: Record<string, unknown> | undefined;
    if (body.updatedInput !== undefined) {
      if (
        typeof body.updatedInput !== "object" ||
        body.updatedInput === null ||
        Array.isArray(body.updatedInput) ||
        Object.keys(body.updatedInput as object).length === 0
      ) {
        sendJsonResponse(res, 400, {
          error: "updatedInput must be a non-empty plain object",
        });
        return;
      }
      updatedInput = body.updatedInput as Record<string, unknown>;
    }

    if (!requestId || !decisionAction) {
      sendJsonResponse(res, 400, {
        error: "requestId and decisionAction (allow|deny|modify) required",
      });
      return;
    }
    if (decisionAction === "modify" && !updatedInput) {
      sendJsonResponse(res, 400, {
        error:
          "decisionAction 'modify' requires a non-empty updatedInput object",
      });
      return;
    }

    const respondKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0
        ? body.idempotencyKey
        : requestId;
    if (
      getIdempotencyStore().isDuplicate(
        IdempotencyStore.compose("respond", instanceId, respondKey),
      )
    ) {
      sendJsonResponse(res, 200, { ok: true, duplicate: true });
      return;
    }

    if (decisionAction === "modify") {
      this.deps.logger.warn(
        "Mobile: deferred permission modify decision — CLI support unverified",
        {
          instanceId,
          requestId,
          updatedInputKeys: Object.keys(updatedInput!),
        },
      );
    }

    const prompt = this.deps.promptStore.get(requestId);
    if (!prompt || prompt.instanceId !== instanceId) {
      sendJsonResponse(res, 404, { error: "Prompt not found" });
      return;
    }

    const approved = decisionAction !== "deny";
    if (prompt.kind === "user-action") {
      const response =
        typeof body.response === "string" ? body.response : undefined;
      this.source()
        .getOrchestrationHandler()
        .respondToUserAction(requestId, approved, response);
      this.deps.promptStore.clear(requestId);
      sendJsonResponse(res, 200, { ok: true, responded: true });
      return;
    }

    const resumeUpdatedInput =
      decisionAction === "modify" ? updatedInput : undefined;
    await this.source().resumeAfterDeferredPermission(
      instanceId,
      approved,
      resumeUpdatedInput,
    );
    if (decisionScope) {
      this.source().recordInputRequiredPermissionDecision({
        instanceId,
        requestId,
        action: decisionAction === "modify" ? "allow" : decisionAction,
        scope: decisionScope,
      });
    } else {
      this.source().clearPendingInputRequiredPermission(instanceId, requestId);
    }
    this.deps.promptStore.clear(requestId);
    sendJsonResponse(res, 200, { ok: true, resumed: true });
  }

  private async handleInterrupt(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    if (!this.source().getInstance(instanceId)) {
      sendJsonResponse(res, 404, { error: "Instance not found" });
      return;
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      idempotencyKey?: unknown;
    };
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
    if (
      idempotencyKey &&
      getIdempotencyStore().isDuplicate(
        IdempotencyStore.compose("interrupt", instanceId, idempotencyKey),
      )
    ) {
      sendJsonResponse(res, 200, { ok: true, duplicate: true });
      return;
    }
    const accepted = this.source().interruptInstance(
      instanceId,
      "mobile-gateway",
    );
    sendJsonResponse(res, 200, { ok: true, accepted });
  }

  private async handleTerminate(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      graceful?: unknown;
      idempotencyKey?: unknown;
    };
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
    if (
      idempotencyKey &&
      getIdempotencyStore().isDuplicate(
        IdempotencyStore.compose("terminate", instanceId, idempotencyKey),
      )
    ) {
      sendJsonResponse(res, 200, { ok: true, duplicate: true });
      return;
    }
    await this.source().terminateInstance(instanceId, body.graceful !== false);
    this.deps.promptStore.clearForInstance(instanceId);
    sendJsonResponse(res, 200, { ok: true });
  }

  private async handleRename(
    req: IncomingMessage,
    res: ServerResponse,
    instanceId: string,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as { displayName?: unknown };
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName) {
      sendJsonResponse(res, 400, { error: "displayName required" });
      return;
    }
    if (!this.source().getInstance(instanceId)) {
      sendJsonResponse(res, 404, { error: "Instance not found" });
      return;
    }
    this.source().renameInstance(instanceId, displayName.slice(0, 200));
    sendJsonResponse(res, 200, { ok: true });
  }

  private async handleCreate(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(req)) as {
      workingDirectory?: unknown;
      provider?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
      initialPrompt?: unknown;
      attachments?: unknown;
      forceNodeId?: unknown;
      nodeName?: unknown;
    };
    const workingDirectory =
      typeof body.workingDirectory === "string"
        ? body.workingDirectory.trim()
        : "";
    if (!workingDirectory) {
      sendJsonResponse(res, 400, { error: "workingDirectory required" });
      return;
    }
    const attachments =
      Array.isArray(body.attachments) && body.attachments.length > 0
        ? (body.attachments as FileAttachment[])
        : undefined;
    const provider =
      typeof body.provider === "string" && VALID_PROVIDERS.has(body.provider)
        ? (body.provider as InstanceCreateConfig["provider"])
        : undefined;
    const reasoningEffort =
      typeof body.reasoningEffort === "string" &&
      VALID_REASONING_EFFORTS.has(body.reasoningEffort)
        ? (body.reasoningEffort as ReasoningEffort)
        : undefined;

    let forceNodeId =
      typeof body.forceNodeId === "string" && body.forceNodeId.trim()
        ? body.forceNodeId.trim()
        : undefined;
    const nodeName =
      typeof body.nodeName === "string" ? body.nodeName.trim() : "";
    if (!forceNodeId && nodeName) {
      const resolved = this.deps.resolveNodeId(nodeName);
      if (!resolved) {
        sendJsonResponse(res, 404, {
          error: `Worker node not found: ${nodeName}`,
        });
        return;
      }
      forceNodeId = resolved;
    }

    const config: InstanceCreateConfig = {
      workingDirectory,
      initialPrompt:
        typeof body.initialPrompt === "string" ? body.initialPrompt : undefined,
      attachments,
      provider,
      modelOverride: typeof body.model === "string" ? body.model : undefined,
      reasoningEffort,
      forceNodeId,
    };
    const instance = await this.source().createInstance(config);
    sendJsonResponse(res, 200, this.deps.serializeInstance(instance));
  }
}
