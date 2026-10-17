import type { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import { InputRequiredResolvedSchema, RemoteInputRequiredSchema, ProviderSessionSchema, NativeHistoryReplaySchema, boundedRemoteCommands, inputNotPending } from '../main/remote-node/instance-interaction-schemas';
import { encodeJsonChunks } from '../shared/utils/json-chunks';

/** One tracker per adapter incarnation; neither request IDs nor answers survive replacement. */
export class WorkerInstanceInteraction {
  private readonly pending = new Map<string, { nativeKey: string; answering: boolean }>();
  private active = true;
  register(value: unknown): unknown {
    const request = RemoteInputRequiredSchema.safeParse(value);
    if (!this.active || !request.success || this.pending.size >= 64 || [...this.pending.values()].some(entry => entry.nativeKey === request.data.id)) return undefined;
    const acp = request.data.metadata?.['transport'] === 'acp' || String(request.data.metadata?.['type'] ?? '').startsWith('acp_');
    const key = acp ? `remote_input:${randomUUID()}` : request.data.id;
    this.pending.set(key, { nativeKey: request.data.id, answering: false });
    return { ...value as Record<string, unknown>, id: key };
  }
  resolve(value: unknown): unknown {
    const resolution = InputRequiredResolvedSchema.safeParse(value);
    if (!this.active || !resolution.success) return undefined;
    const key = [...this.pending].find(([, entry]) => entry.nativeKey === resolution.data.id)?.[0];
    if (!key || !this.pending.delete(key)) return undefined;
    return { ...resolution.data, id: key };
  }
  clear(): string[] { this.active = false; const keys = [...this.pending.keys()]; this.pending.clear(); return keys; }
  async answer(key: string, send: (nativeKey: string) => Promise<void>, resolved: (value: { id: string; reason: 'decided' }) => void): Promise<void> {
    const entry = this.pending.get(key);
    if (!this.active || !entry || entry.answering) throw inputNotPending();
    entry.answering = true;
    try {
      await send(entry.nativeKey);
      if (this.active && this.pending.get(key) === entry && this.pending.delete(key)) resolved({ id: key, reason: 'decided' });
    } catch (error) {
      if (this.active && this.pending.get(key) === entry) entry.answering = false;
      throw error;
    }
  }
}

export function wireWorkerInteraction(adapter: EventEmitter & { getAvailableCommands?: () => unknown; getSessionId?: () => unknown; hasActiveTurn?: () => boolean; hasActiveToolCalls?: () => boolean }, current: () => boolean,
  permission: (payload: unknown) => void, emitState: (name: string, payload: unknown) => void, interactionId?: string) {
  const state = (name: string, payload: unknown): void => { if (interactionId) emitState(name, { interactionId, payload }); };
  const interaction = new WorkerInstanceInteraction();
  let disposed = false;
  const owns = (): boolean => !disposed && current();
  const onInput = (value: unknown): void => { if (owns()) { const request = interaction.register(value); if (request) {
    const record = request as Record<string, unknown>;
    permission(interactionId ? { ...record, metadata: { ...record['metadata'] as Record<string, unknown> | undefined, remoteInteractionId: interactionId } } : request);
  } } };
  const onResolved = (value: unknown): void => { if (owns()) { const resolved = interaction.resolve(value); if (resolved) state('input_required_resolved', resolved); } };
  const onCommands = (value: unknown): void => { if (owns()) state('available_commands', boundedRemoteCommands(value)); };
  const onHistory = (value: unknown): void => {
    if (!owns()) return;
    const history = NativeHistoryReplaySchema.parse(value);
    if (history.sessionId !== adapter.getSessionId?.()) throw new Error('Native history replay session identity changed.');
    state('provider_session', { sessionId: history.sessionId });
    for (const chunk of encodeJsonChunks(history, randomUUID(), { maxCharacters: 40 * 1024 * 1024 })) state('history_replay', chunk);
  };
  let lastLease = ''; let lastLeaseAt = 0; let queuedLease = false;
  const lease = (renew = true): void => {
    if (!owns()) return;
    const active = adapter.hasActiveTurn?.() === true; const activeToolCalls = active && adapter.hasActiveToolCalls?.() === true;
    const signature = `${active}:${activeToolCalls}`;
    // Continuous activity can postpone the watchdog indefinitely; renew active proof at most every 5s.
    if (renew || lastLease !== signature || active && Date.now() - lastLeaseAt >= 5_000) {
      lastLease = signature; lastLeaseAt = Date.now(); state('provider_turn', { active, activeToolCalls });
    }
  };
  const onLease = (): void => { if (!queuedLease) { queuedLease = true; queueMicrotask(() => { queuedLease = false; lease(false); }); } };
  adapter.on('input_required', onInput); adapter.on('input_required_resolved', onResolved); adapter.on('available_commands', onCommands);
  adapter.on('history_replay', onHistory);
  for (const event of ['status', 'heartbeat', 'output', 'complete']) adapter.on(event, onLease);
  return { interaction, lease, resolved: (value: { id: string; reason: 'decided' }) => state('input_required_resolved', value), catalog: () => {
    if (!owns()) return;
    if (adapter.getAvailableCommands) onCommands(adapter.getAvailableCommands());
    const session = ProviderSessionSchema.safeParse({ sessionId: adapter.getSessionId?.() });
    if (session.success) state('provider_session', session.data);
    lease();
  },
    cleanup: () => { disposed = true; for (const id of interaction.clear()) state('input_required_resolved', { id, reason: 'cancelled' }); adapter.off('input_required', onInput); adapter.off('input_required_resolved', onResolved); adapter.off('available_commands', onCommands); adapter.off('history_replay', onHistory); for (const event of ['status', 'heartbeat', 'output', 'complete']) adapter.off(event, onLease); } };
}
