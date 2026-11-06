import type { SessionKind } from '../../../shared/types/session-kind.types';
import type { CodexTrialArm } from './codex/codex-thread-policy';
import type { TrialKeySource } from '../../../shared/utils/machine-session';
import type { CodexReasoningEffort } from './codex/app-server-types';

type CodexApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Codex CLI and app-server configuration shared by every adapter layer. */
export interface CodexCliConfig {
  /** Explicit metadata only; no environment or config object is serialized. */
  instanceId?: string;
  jobId?: string;
  /** Injectable receipt file for isolated runtimes and tests. */
  usageLogFile?: string;
  /** Worker-owned sink for the validated final numeric projection, instead of a local Electron file. */
  onEphemeralUsage?: (receipt: import('../../../shared/types/codex-ephemeral-usage.types').CodexEphemeralUsage) => void;
  sessionKind?: SessionKind;
  trialKey?: string;
  trialKeySource?: TrialKeySource;
  trialArm?: CodexTrialArm;
  /** Plan-queue role (`planQueueRole`), so the policy can tell a checker from a worker. */
  queueRole?: string;
  /** Set once a thread starts or resumes with the skills catalog switched off. */
  skillCatalogOmitted?: boolean;
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
  /** Harness instance identity for trial outcomes; sessionId is the native Codex resume target. */
  harnessInstanceId?: string;
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
