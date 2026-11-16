/**
 * Parent-side memory of which deferred orchestrator tools each session has
 * revealed, so a restarted forwarder lists them again before its first
 * `tools/list` (see tool-reveal-restore.ts). Without it a restart hid tools the
 * model had already found, and OpenCode refused the model's next call to them
 * as an unknown tool (16 Nov 2026).
 */

import { z } from 'zod';

export const TOOL_REVEAL_RPC_METHODS = {
  get: 'orchestrator_tools.tool_reveal_get',
  record: 'orchestrator_tools.tool_reveal_record',
} as const;

const MAX_TRACKED_INSTANCES = 500;
const MAX_NAMES = 200;

const GetPayloadSchema = z.object({}).strict();
const RecordPayloadSchema = z.object({
  names: z.array(z.string().min(1).max(128)).max(MAX_NAMES),
}).strict();

export function isToolRevealRpcMethod(method: string): boolean {
  return method === TOOL_REVEAL_RPC_METHODS.get || method === TOOL_REVEAL_RPC_METHODS.record;
}

export class OrchestratorToolRevealStore {
  private readonly revealedByInstance = new Map<string, Set<string>>();

  record(instanceId: string, names: readonly string[]): void {
    const revealed = this.revealedByInstance.get(instanceId) ?? new Set<string>();
    for (const name of names) {
      if (revealed.size >= MAX_NAMES) break;
      revealed.add(name);
    }
    // Re-insert so the least recently active session is the one evicted.
    this.revealedByInstance.delete(instanceId);
    this.revealedByInstance.set(instanceId, revealed);
    while (this.revealedByInstance.size > MAX_TRACKED_INSTANCES) {
      const oldest = this.revealedByInstance.keys().next().value;
      if (oldest === undefined) return;
      this.revealedByInstance.delete(oldest);
    }
  }

  get(instanceId: string): string[] {
    return [...(this.revealedByInstance.get(instanceId) ?? [])];
  }
}

export function dispatchToolRevealRpc(
  store: OrchestratorToolRevealStore,
  method: string,
  instanceId: string,
  payload: Record<string, unknown>,
): unknown {
  if (method === TOOL_REVEAL_RPC_METHODS.get) {
    GetPayloadSchema.parse(payload);
    return { revealedNames: store.get(instanceId) };
  }
  const { names } = RecordPayloadSchema.parse(payload);
  store.record(instanceId, names);
  return { ok: true };
}
