import type {
  MobilePromptDto,
  MobileServerEvent,
} from "../../shared/types/mobile-gateway.types";

export interface MobilePromptStoreDeps {
  broadcast(event: MobileServerEvent): void;
  scheduleSnapshotBroadcast(): void;
  sendPush(prompt: MobilePromptDto): void;
}

/** Owns pending mobile prompts and maps main-process events onto their wire DTOs. */
export class MobileGatewayPromptStore {
  private readonly prompts = new Map<string, MobilePromptDto>();

  constructor(private readonly deps: MobilePromptStoreDeps) {}

  values(): MobilePromptDto[] {
    return [...this.prompts.values()];
  }

  get(requestId: string): MobilePromptDto | undefined {
    return this.prompts.get(requestId);
  }

  clearAll(): void {
    this.prompts.clear();
  }

  handleInputRequired(payload: unknown): void {
    const request = payload as {
      instanceId: string;
      requestId: string;
      prompt?: string;
      timestamp?: number;
      metadata?: Record<string, unknown>;
    };
    if (!request?.instanceId || !request?.requestId) return;

    const metadata = request.metadata ?? {};
    const toolName =
      (typeof metadata["tool_name"] === "string" && metadata["tool_name"]) ||
      (typeof metadata["toolName"] === "string" && metadata["toolName"]) ||
      undefined;
    const toolInput =
      metadata["tool_input"] && typeof metadata["tool_input"] === "object"
        ? (metadata["tool_input"] as Record<string, unknown>)
        : undefined;

    this.add({
      id: request.requestId,
      instanceId: request.instanceId,
      requestId: request.requestId,
      kind: "permission",
      toolName: toolName || undefined,
      toolInput,
      title: toolName ? `${toolName} needs approval` : "Permission required",
      message:
        request.prompt ||
        (toolName ? `Allow ${toolName}?` : "An action needs your approval."),
      createdAt: request.timestamp || Date.now(),
    });
  }

  handleInputRequiredResolved(payload: unknown): void {
    const requestId = (payload as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId === "string") this.clear(requestId);
  }

  handleUserAction(request: unknown): void {
    const action = request as {
      id: string;
      instanceId: string;
      requestType?: unknown;
      title?: string;
      message?: string;
      options?: { id: string; label: string; description?: string }[];
      questions?: unknown;
      createdAt?: number;
    };
    if (!action?.id || !action?.instanceId) return;

    this.add({
      id: action.id,
      instanceId: action.instanceId,
      requestId: action.id,
      kind: "user-action",
      requestType:
        action.requestType === "switch_mode" ||
        action.requestType === "approve_action" ||
        action.requestType === "confirm" ||
        action.requestType === "select_option" ||
        action.requestType === "ask_questions"
          ? action.requestType
          : undefined,
      title: action.title || "Input needed",
      message: action.message || "An AI instance is waiting for your response.",
      options: Array.isArray(action.options)
        ? action.options
            .filter(
              (
                option,
              ): option is {
                id: string;
                label: string;
                description?: string;
              } =>
                Boolean(option) &&
                typeof option.id === "string" &&
                typeof option.label === "string",
            )
            .map((option) => ({
              id: option.id,
              label: option.label,
              description:
                typeof option.description === "string"
                  ? option.description
                  : undefined,
            }))
        : undefined,
      questions: Array.isArray(action.questions)
        ? action.questions.filter(
            (question): question is string => typeof question === "string",
          )
        : undefined,
      createdAt: action.createdAt || Date.now(),
    });
  }

  clear(requestId: string): void {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return;
    this.prompts.delete(requestId);
    this.deps.broadcast({
      type: "permission-cleared",
      data: { requestId, instanceId: prompt.instanceId },
    });
    this.deps.scheduleSnapshotBroadcast();
  }

  clearForInstance(instanceId: string): void {
    for (const [id, prompt] of this.prompts) {
      if (prompt.instanceId !== instanceId) continue;
      this.prompts.delete(id);
      this.deps.broadcast({
        type: "permission-cleared",
        data: { requestId: id, instanceId },
      });
    }
  }

  private add(prompt: MobilePromptDto): void {
    this.prompts.set(prompt.id, prompt);
    this.deps.broadcast({ type: "permission-prompt", data: prompt });
    this.deps.sendPush(prompt);
    this.deps.scheduleSnapshotBroadcast();
  }
}
