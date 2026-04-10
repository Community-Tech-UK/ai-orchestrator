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

export interface SdkPluginContext {
  appPath: string;
  homeDir: string | null;
}

export type SdkPluginModule =
  | OrchestratorHooks
  | ((ctx: SdkPluginContext) => OrchestratorHooks | Promise<OrchestratorHooks>);
