import { Injectable, inject, signal } from '@angular/core';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore, type OutputMessage } from '../../core/state/instance.store';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import type { ConversationData } from '../../../../shared/types/history.types';
import type { Instance } from '../../../../shared/types/instance.types';
import { isModelSwitchAllowedStatus } from '../../../../shared/types/instance-status-policy';
import { normalizeModelAliasForProvider } from '../../../../shared/types/provider-model-utils';
import type { PendingSelection } from '../models/compact-model-picker.types';

const MODEL_WAIT_ERROR = 'The session is still starting or busy. Your message has not been sent; try again when it is ready.';

export function historyEntryIdFromPreview(instanceId: string): string | null {
  const prefix = 'history-preview:';
  return instanceId.startsWith(prefix) ? instanceId.slice(prefix.length) || null : null;
}

/** Renderer-session drafts and restore ownership, keyed by the durable history entry. */
@Injectable({ providedIn: 'root' })
export class HistoryPreviewSessionService {
  private readonly history = inject(HistoryStore);
  private readonly instances = inject(InstanceStore);
  private readonly ipc = inject(InstanceIpcService);
  private readonly selections = signal(new Map<string, PendingSelection>());
  private readonly errors = signal(new Map<string, string>());
  private readonly restoring = signal(new Set<string>());
  private readonly restored = new Map<string, string>();
  private readonly restores = new Map<string, Promise<string | null>>();
  private readonly preparations = new Map<string, Promise<string | null>>();
  private readonly applied = new Map<string, { instanceId: string; selection: PendingSelection }>();

  selection(entryId: string): PendingSelection | null {
    return this.selections().get(entryId) ?? null;
  }

  select(entryId: string, selection: PendingSelection): void {
    this.selections.update(current => new Map(current).set(entryId, selection));
    this.setError(entryId, null);
  }

  error(entryId: string): string | null {
    return this.errors().get(entryId) ?? null;
  }

  setError(entryId: string, message: string | null): void {
    this.errors.update(current => {
      const next = new Map(current);
      if (message) next.set(entryId, message);
      else next.delete(entryId);
      return next;
    });
  }

  isRestoring(entryId: string): boolean {
    return this.restoring().has(entryId);
  }

  restoredInstanceId(entryId: string): string | null {
    const id = this.restored.get(entryId);
    const instance = id ? this.instances.getInstance(id) : null;
    return id && instance && !['terminated', 'failed', 'cancelled', 'superseded'].includes(instance.status) ? id : null;
  }

  complete(entryId: string): void {
    if (this.applied.get(entryId)?.selection !== this.selection(entryId)) return;
    this.selections.update(current => {
      const next = new Map(current);
      next.delete(entryId);
      return next;
    });
    this.applied.delete(entryId);
    this.setError(entryId, null);
  }

  /** Typing may warm the original runtime, but never sends a prompt or applies a draft pick. */
  restore(conversation: ConversationData): Promise<string | null> {
    const entryId = conversation.entry.id;
    const existing = this.restoredInstanceId(entryId);
    if (existing) return Promise.resolve(existing);
    const pending = this.restores.get(entryId);
    if (pending) return pending;
    this.setError(entryId, null);
    this.restoring.update(current => new Set(current).add(entryId));
    const promise = this.restoreEntry(conversation).finally(() => {
      this.restores.delete(entryId);
      this.restoring.update(current => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    });
    this.restores.set(entryId, promise);
    return promise;
  }

  /** All continuation paths must await this before releasing user work. */
  prepare(conversation: ConversationData): Promise<string | null> {
    const entryId = conversation.entry.id;
    const pending = this.preparations.get(entryId);
    if (pending) return pending;
    const promise = this.prepareEntry(conversation).finally(() => this.preparations.delete(entryId));
    this.preparations.set(entryId, promise);
    return promise;
  }

  private async restoreEntry(conversation: ConversationData): Promise<string | null> {
    const entryId = conversation.entry.id;
    try {
      const result = await this.history.restoreEntry(entryId, conversation.entry.workingDirectory);
      if (!result.success || !result.instanceId) {
        throw new Error(result.error || 'Could not restore this session. Please try again.');
      }
      if (result.restoredMessages?.length) {
        this.instances.setInstanceMessages(result.instanceId, result.restoredMessages as OutputMessage[]);
      }
      if (result.restoreMode) this.instances.setInstanceRestoreMode(result.instanceId, result.restoreMode);
      this.restored.set(entryId, result.instanceId);
      return result.instanceId;
    } catch (error) {
      this.setError(entryId, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async prepareEntry(conversation: ConversationData): Promise<string | null> {
    const entryId = conversation.entry.id;
    this.setError(entryId, null);
    const instanceId = await this.restore(conversation);
    if (!instanceId) return null;
    try {
      const deadline = Date.now() + 30_000;
      let confirmed: PendingSelection | null = null;
      // A newer selection made during restore or apply wins before continuation.
      for (;;) {
        const selection = this.selection(entryId);
        if (!selection || confirmed === selection) {
          return instanceId;
        }
        await this.applySelection(instanceId, selection, deadline);
        confirmed = selection;
        this.applied.set(entryId, { instanceId, selection });
      }
    } catch (error) {
      this.setError(entryId, `Could not apply the selected model. ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async applySelection(instanceId: string, selection: PendingSelection, deadline: number): Promise<void> {
    if (historyEntryIdFromPreview(instanceId)) throw new Error('Restore the session before changing its model.');
    const target = selection.modelRuntimeTarget;
    if (selection.provider === 'local-model' && !target) throw new Error('Choose a local model again.');
    for (;;) {
      if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
      const response = await this.beforeDeadline(this.ipc.changeModel(
        instanceId,
        target?.kind === 'local-model' ? target.modelId : selection.model ?? undefined,
        selection.reasoning,
        target ?? undefined,
        target || selection.provider === 'local-model' ? undefined : selection.provider,
      ), deadline);
      if (!response.success) throw new Error(response.error?.message || 'Please try again.');
      const data = response.data as Partial<Instance> | undefined;
      if (!data || data.id !== instanceId) throw new Error('The session did not confirm the model change. Please try again.');
      if (!data.desiredRuntime) {
        const matches = target?.kind === 'local-model'
          ? data.runtimeSummary?.kind === 'local-model' && data.runtimeSummary.selectorId === target.selectorId
          : data.provider === (target?.kind === 'cli' ? target.provider ?? selection.provider : selection.provider)
            && (!selection.model || normalizeModelAliasForProvider(selection.provider, data.currentModel)
              === normalizeModelAliasForProvider(selection.provider, selection.model));
        if (!matches) throw new Error('The session confirmed a different model. Choose an available model and try again.');
        return;
      }

      // Replay restores can return before initialization finishes. A queued ACK
      // is not permission to send on the old model. Wait for settlement, then
      // re-confirm through IPC (also detects a failed deferred application).
      for (;;) {
        if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
        await new Promise(resolve => setTimeout(resolve, 250));
        const instance = this.instances.getInstance(instanceId);
        if (!instance || ['terminated', 'failed', 'cancelled', 'superseded'].includes(instance.status)) {
          throw new Error('The restored session stopped. Please restore it again.');
        }
        if (!instance.desiredRuntime && isModelSwitchAllowedStatus(instance.status)) break;
      }
    }
  }

  private async beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(MODEL_WAIT_ERROR)), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
