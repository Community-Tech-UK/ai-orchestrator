import type { CodexReasoningEffort } from './codex/app-server-types';

type CodexApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Codex CLI and app-server configuration shared by every adapter layer. */
export interface CodexCliConfig {
  additionalWritableDirs?: string[];
  approvalMode?: CodexApprovalMode;
  browserGatewayInstanceId?: string;
  contextCostGovernorEnabled?: boolean;
  env?: Record<string, string>;
  ephemeral?: boolean;
  fastMode?: boolean;
  mcpServersConfigToml?: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  outputSchemaPath?: string;
  reasoningEffort?: CodexReasoningEffort;
  resume?: boolean;
  rtkEnabled?: boolean;
  sandboxMode?: CodexSandboxMode;
  sessionId?: string;
  systemPrompt?: string;
  timeout?: number;
  workingDir?: string;
}
