/**
 * ACP `session/update` variants beyond the original set in cli.types.ts, kept
 * here so that file stays under its size limit; cli.types.ts adds them to
 * `AcpSessionUpdate`.
 */

import type { AcpContentBlock } from './cli.types';

/**
 * `session/update` `usage_update`: the agent's measured context-window
 * occupancy (`used` of `size` tokens) and, optionally, the session's cost so
 * far. Observed from OpenCode 1.18 after each model call.
 */
export interface AcpUsageUpdate {
  sessionUpdate: 'usage_update';
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string };
}

export interface AcpAgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: AcpContentBlock;
  messageId?: string;
}
