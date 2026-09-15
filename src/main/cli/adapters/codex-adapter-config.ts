import type { CodexReasoningEffort } from './codex/app-server-types';

type CodexApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Codex CLI and app-server configuration shared by every adapter layer. */
export interface CodexCliConfig {
  additionalWritableDirs?: string[];
  approvalMode?: CodexApprovalMode;
  /**
   * Account-pool profile home whose `auth.json` the per-instance temp
   * `CODEX_HOME` links instead of `~/.codex/auth.json`.
   */
  authSourceDir?: string;
  /** `-c key=value` overrides added to every app-server and exec invocation. */
  configOverrides?: readonly string[];
  /** Variables removed from the child env after the ambient merge. */
  envRemove?: readonly string[];
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
