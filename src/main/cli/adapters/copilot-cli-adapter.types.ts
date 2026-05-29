/**
 * Copilot CLI Adapter — shared type definitions.
 * Extracted from copilot-cli-adapter.ts to keep the main file under the
 * size ceiling. Do not add logic here; this file is types + leaf constants only.
 */

import type { OutputMessage, ContextUsage, InstanceStatus } from '../../../shared/types/instance.types';

export const COPILOT_AUTO_MODEL_ID = 'auto';

/**
 * Copilot CLI specific configuration
 */
export interface CopilotCliConfig {
  /** Model to use (e.g. 'claude-sonnet-4-6', 'gpt-5.5', 'gemini-2.5-pro'). */
  model?: string;
  /** Working directory for the CLI process. */
  workingDir?: string;
  /** System prompt / additional instructions.
   *  The Copilot CLI does not expose a dedicated system-prompt flag in non-interactive
   *  mode, so when set we prepend it to the user prompt. */
  systemPrompt?: string;
  /** YOLO mode — grant all permissions without prompting. Required for non-interactive
   *  use; the CLI `-p` mode also requires `--allow-all-tools` which we always set.
   *  `yoloMode` additionally passes `--yolo` which enables all path+URL permissions. */
  yoloMode?: boolean;
  /** Timeout in milliseconds for a single message call. */
  timeout?: number;
}

/**
 * Events emitted by CopilotCliAdapter (preserved from CopilotSdkAdapter for
 * source-level compatibility with existing event wiring in CopilotCliProvider).
 */
export interface CopilotCliAdapterEvents {
  output: (message: OutputMessage) => void;
  status: (status: InstanceStatus) => void;
  context: (usage: ContextUsage) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawned: (pid: number) => void;
}

/**
 * Simplified model info for orchestrator use.
 * Identical shape to the former SDK adapter's CopilotModelInfo so downstream
 * callers (settings UI, model picker, parity tests) don't need changes.
 */
export interface CopilotModelInfo {
  id: string;
  name: string;
  supportsVision: boolean;
  contextWindow: number;
  enabled: boolean;
}
