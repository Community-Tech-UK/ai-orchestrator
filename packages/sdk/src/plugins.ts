/**
 * Minimal message shape exposed to plugin authors.
 */
export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  attachments?: {
    name: string;
    type: string;
    size: number;
    data: string;
  }[];
}

export type PluginRecord = Record<string, unknown>;

export type PluginSlot =
  | 'provider'
  | 'channel'
  | 'mcp'
  | 'skill'
  | 'hook'
  | 'tracker'
  | 'notifier'
  | 'telemetry_exporter';

export type PluginLoadPhase =
  | 'manifest_load'
  | 'manifest_validation'
  | 'instantiation'
  | 'detect'
  | 'slot_registration'
  | 'ready';

export type PluginPhaseStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface PluginPhaseResult {
  phase: PluginLoadPhase;
  status: PluginPhaseStatus;
  timestamp: number;
  message?: string;
}

export interface PluginLoadReport {
  slot: PluginSlot;
  detected: boolean;
  ready: boolean;
  phases: PluginPhaseResult[];
  error?: string;
}

export interface PluginTrackerEvent {
  event: string;
  timestamp: number;
  instanceId?: string;
  data?: PluginRecord;
}

export interface PluginNotification {
  event: string;
  message: string;
  timestamp: number;
  title?: string;
  priority?: string;
  instanceId?: string;
  channels?: string[];
  data?: PluginRecord;
}

export interface PluginTelemetryRecord {
  event: string;
  timestamp: number;
  attributes?: PluginRecord;
  data?: PluginRecord;
}

export interface PluginHookPayloads {
  'instance.created': PluginRecord & {
    id: string;
    instanceId: string;
    workingDirectory: string;
    provider?: string;
  };
  'instance.removed': {
    instanceId: string;
  };
  'instance.output': {
    instanceId: string;
    message: OutputMessage;
  };
  'verification.started': PluginRecord & {
    id: string;
    verificationId: string;
    instanceId: string;
  };
  'verification.completed': PluginRecord & {
    id: string;
    verificationId: string;
    instanceId: string;
    fromCache?: boolean;
  };
  'verification.error': {
    request: PluginRecord & {
      id?: string;
      instanceId?: string;
    };
    error: unknown;
    verificationId: string;
    instanceId: string;
  };
  'instance.stateChanged': {
    instanceId: string;
    previousState: string;
    newState: string;
    timestamp: number;
  };
  'orchestration.debate.round': {
    debateId: string;
    round: number;
    totalRounds: number;
    participantId: string;
    response: string;
  };
  'orchestration.consensus.vote': {
    consensusId: string;
    voterId: string;
    vote: string;
    confidence: number;
  };
  'tool.execute.before': {
    instanceId: string;
    toolName: string;
    args: Record<string, unknown>;
    skip?: boolean;
  };
  'tool.execute.after': {
    instanceId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    durationMs: number;
  };
  'session.created': {
    instanceId: string;
    sessionId: string;
  };
  'session.resumed': {
    instanceId: string;
    sessionId: string;
  };
  'session.compacting': {
    instanceId: string;
    messageCount: number;
    tokenCount: number;
  };
  'permission.ask': {
    instanceId: string;
    toolName: string;
    command?: string;
    decision?: 'allow' | 'deny' | undefined;
  };
  'config.loaded': {
    config: Record<string, unknown>;
  };
}

export type PluginHookEvent = keyof PluginHookPayloads;

export type OrchestratorHooks = {
  [K in PluginHookEvent]?: (
    payload: PluginHookPayloads[K],
  ) => void | Promise<void>;
};

// ── Typed hook callbacks ──────────────────────────────────────────────────────
// Inspired by copilot-sdk typed hook pattern. These hooks return structured
// results so the runtime can distinguish 'deny' vs 'ask' vs 'allow-with-modification'
// without re-prompting. Use TypedHookCallbacks when you need the response value;
// use OrchestratorHooks for fire-and-forget side-effects.

/** Category of the resource being accessed. */
export type PermissionRequestKind =
  | 'shell'
  | 'write'
  | 'read'
  | 'mcp'
  | 'custom-tool'
  | 'url'
  | 'memory'
  | 'hook';

/** How the permission decision was reached. */
export type PermissionResultKind =
  | 'approved'
  | 'denied-interactively-by-user'
  | 'denied-by-rules'
  | 'allowed-by-rules'
  | 'pending';

/** Structured result returned by pre-tool typed hooks. */
export interface PreToolUseDecision {
  /** Explicit permission action; omit to leave the decision to the next handler. */
  permissionDecision?: 'allow' | 'deny' | 'ask';
  /** How the decision was reached (for audit + agent learning). */
  resultKind?: PermissionResultKind;
  /** Replacement args to use instead of the original (only honoured when `permissionDecision === 'allow'`). */
  modifiedArgs?: Record<string, unknown>;
  /** Extra context surfaced to the user in the permission UI. */
  additionalContext?: string;
}

export interface PreToolUseHookInput {
  instanceId: string;
  toolName: string;
  args: Record<string, unknown>;
  requestKind: PermissionRequestKind;
}

export interface PostToolUseHookInput {
  instanceId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  errorMessage?: string;
}

export interface PostToolUseDecision {
  /** Suppress this tool result from the agent's context (e.g. secret redaction). */
  suppressResult?: boolean;
  /** Replacement result content if the original must be sanitised. */
  replacementResult?: unknown;
}

export interface UserPromptSubmittedHookInput {
  instanceId: string;
  prompt: string;
  attachmentCount: number;
}

export interface UserPromptDecision {
  /** Reject the prompt before it reaches the provider (e.g. PII filter). */
  deny?: boolean;
  /** Replacement prompt if the original must be rewritten. */
  replacementPrompt?: string;
  /** Injected context appended to the prompt before sending. */
  additionalContext?: string;
}

/**
 * Typed hook callbacks that return structured decisions.
 * The runtime calls these before/after tool execution and before prompt submission.
 * Returning `undefined` (or not registering a hook) defers to the next handler.
 */
export interface TypedHookCallbacks {
  onPreToolUse?: (input: PreToolUseHookInput) => Promise<PreToolUseDecision | undefined>;
  onPostToolUse?: (input: PostToolUseHookInput) => Promise<PostToolUseDecision | undefined>;
  onUserPromptSubmitted?: (input: UserPromptSubmittedHookInput) => Promise<UserPromptDecision | undefined>;
}
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackerPlugin {
  track(event: PluginTrackerEvent): void | Promise<void>;
}

export interface NotifierPlugin {
  notify(notification: PluginNotification): void | Promise<void>;
}

export interface TelemetryExporterPlugin {
  export(record: PluginTelemetryRecord): void | Promise<void>;
}

export interface PluginRuntimeBySlot {
  provider: unknown;
  channel: unknown;
  mcp: unknown;
  skill: unknown;
  hook: OrchestratorHooks;
  tracker: TrackerPlugin;
  notifier: NotifierPlugin;
  telemetry_exporter: TelemetryExporterPlugin;
}

export type PluginRuntimeForSlot<S extends PluginSlot> = PluginRuntimeBySlot[S];

export interface SdkPluginContext {
  appPath: string;
  homeDir: string | null;
}

export interface PluginModuleDefinition<T = unknown> {
  hooks?: OrchestratorHooks;
  /** Typed callbacks with structured return values (preferred over fire-and-forget hooks
   *  for permission-critical operations like pre-tool-use and prompt submission). */
  typedHooks?: TypedHookCallbacks;
  detect?: (
    ctx: SdkPluginContext,
  ) => boolean | Promise<boolean>;
  slot?: PluginSlot;
  create?: (
    ctx: SdkPluginContext,
  ) => T | Promise<T>;
}

export type SdkPluginModule =
  | OrchestratorHooks
  | PluginModuleDefinition
  | ((ctx: SdkPluginContext) => OrchestratorHooks | PluginModuleDefinition | Promise<OrchestratorHooks | PluginModuleDefinition>);

/** Manifest schema for plugin.json — validated on load */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  slot?: PluginSlot;
  hooks?: string[];
  config?: {
    schema: Record<string, unknown>; // JSON Schema for plugin config
  };
}
