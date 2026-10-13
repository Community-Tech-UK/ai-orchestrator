import { Injectable, inject, signal } from '@angular/core';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore, type OutputMessage } from '../../core/state/instance.store';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import {
  inferConversationHistoryProvider,
  type ConversationData,
} from '../../../../shared/types/history.types';
import type { Instance } from '../../../../shared/types/instance.types';
import type { InstanceProvider } from '../../core/state/instance/instance.types';
import { isModelSwitchAllowedStatus } from '../../../../shared/types/instance-status-policy';
import { normalizeModelAliasForProvider } from '../../../../shared/types/provider-model-utils';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../../../../shared/types/provider-account.types';
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
  private readonly accounts = inject(ProviderAccountIpcService);
  private readonly selections = signal(new Map<string, PendingSelection>());
  private readonly accountChoices = signal(new Map<string, string>());
  private readonly accountChoiceProviders = new Map<string, string | undefined>();
  private readonly errors = signal(new Map<string, string>());
  private readonly restoring = signal(new Set<string>());
  private readonly restored = new Map<string, { instanceId: string; provider: string }>();
  private readonly restores = new Map<string, Promise<string | null>>();
  private readonly preparations = new Map<string, Promise<string | null>>();
  private readonly preparedChoices = new Map<string, { selection: PendingSelection | null; account: string | null }>();
  private readonly originalAccounts = new Map<string, { provider: string; profileId: string }>();
  private readonly accountHandoffs = new Set<string>();
  private readonly accountRequests = new Map<string, {
    provider: string;
    profileId: string;
    operation: ReturnType<ProviderAccountIpcService['switchSession']>;
  }>();
  /** Account id passed to the restore that produced `restored`, or '' when none was. */
  private readonly restoredAccountKey = new Map<string, string>();
  /** A validated model switch can reach the preview handoff before the normal
   * instance update event. Keep its result so the live picker has the same truth. */
  private readonly confirmedByInstance = new Map<string, {
    selection: PendingSelection;
    before: { provider: string; currentModel?: string } | null;
    after: { provider: string; currentModel?: string };
  }>();

  selection(entryId: string): PendingSelection | null {
    return this.selections().get(entryId) ?? null;
  }

  confirmedSelectionForInstance(
    instanceId: string,
    provider: InstanceProvider,
    currentModel: string | undefined,
  ): PendingSelection | null {
    const confirmed = this.confirmedByInstance.get(instanceId);
    if (!confirmed) return null;
    const matches = (runtime: { provider: string; currentModel?: string } | null): boolean =>
      runtime !== null && provider === runtime.provider
      && normalizeModelAliasForProvider(provider, currentModel)
        === normalizeModelAliasForProvider(provider, runtime.currentModel);
    // A later model change from the header (or another window) supersedes the
    // handoff. The original runtime is allowed only while its event is stale.
    if (matches(confirmed.before) || matches(confirmed.after)) return confirmed.selection;
    this.confirmedByInstance.delete(instanceId);
    return null;
  }

  clearConfirmedSelection(instanceId: string): void {
    this.confirmedByInstance.delete(instanceId);
  }

  select(entryId: string, selection: PendingSelection): void {
    this.selections.update(current => new Map(current).set(entryId, selection));
    this.setError(entryId, null);
  }

  /** Account the continuation should start on. Null keeps the archived account. */
  accountChoice(entryId: string): string | null {
    return this.accountChoices().get(entryId) ?? null;
  }

  chooseAccount(entryId: string, profileId: string): void {
    this.accountChoiceProviders.set(entryId, this.selection(entryId)?.provider
      ?? this.restored.get(entryId)?.provider);
    this.accountChoices.update(current => new Map(current).set(entryId, profileId));
    this.setError(entryId, null);
  }

  clearAccountChoice(entryId: string): void {
    this.accountChoiceProviders.delete(entryId);
    this.accountChoices.update(current => {
      const next = new Map(current);
      next.delete(entryId);
      return next;
    });
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
    const id = this.restored.get(entryId)?.instanceId;
    const instance = id ? this.instances.getInstance(id) : null;
    return id && instance && !['terminated', 'failed', 'cancelled', 'superseded'].includes(instance.status) ? id : null;
  }

  complete(entryId: string): void {
    const pendingSelection = this.selection(entryId);
    const prepared = this.preparedChoices.get(entryId);
    // Keep model/account picks made after preparation for the next continuation.
    if ((pendingSelection && pendingSelection !== prepared?.selection)
      || this.accountChoice(entryId) !== (prepared?.account ?? null)) return;
    this.selections.update(current => {
      const next = new Map(current);
      next.delete(entryId);
      return next;
    });
    this.accountChoices.update(current => {
      const next = new Map(current);
      next.delete(entryId);
      return next;
    });
    this.preparedChoices.delete(entryId);
    this.accountChoiceProviders.delete(entryId);
    this.originalAccounts.delete(entryId);
    this.accountHandoffs.delete(entryId);
    const instanceId = this.restored.get(entryId)?.instanceId;
    if (instanceId) this.accountRequests.delete(instanceId);
    this.restoredAccountKey.delete(entryId);
    this.setError(entryId, null);
  }

  /** Warm the archived runtime without sending. Account choices can pin its initial spawn; model choices await preparation. */
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
    const accountProfileId = this.accountForRestore(conversation);
    try {
      const result = accountProfileId
        ? await this.history.restoreEntry(entryId, conversation.entry.workingDirectory, accountProfileId)
        : await this.history.restoreEntry(entryId, conversation.entry.workingDirectory);
      if (!result.success || !result.instanceId) {
        throw new Error(result.error || 'Could not restore this session. Please try again.');
      }
      if (result.restoredMessages?.length) {
        this.instances.setInstanceMessages(result.instanceId, result.restoredMessages as OutputMessage[]);
      }
      if (result.restoreMode) this.instances.setInstanceRestoreMode(result.instanceId, result.restoreMode);
      const previousId = this.restored.get(entryId)?.instanceId;
      if (previousId && previousId !== result.instanceId) this.accountRequests.delete(previousId);
      this.restored.set(entryId, { instanceId: result.instanceId,
        provider: inferConversationHistoryProvider(conversation.entry) });
      this.restoredAccountKey.set(entryId, accountProfileId ?? '');
      this.originalAccounts.delete(entryId);
      this.accountHandoffs.delete(entryId);
      return result.instanceId;
    } catch (error) {
      this.setError(entryId, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async prepareEntry(conversation: ConversationData): Promise<string | null> {
    const entryId = conversation.entry.id;
    this.setError(entryId, null);
    try {
      const deadline = Date.now() + 30_000;
      const instanceId = await this.beforeDeadline(this.restore(conversation), deadline);
      if (!instanceId) return null;
      // A timed-out request can still mutate the backend. Serialize retries
      // and model changes behind its actual completion, including queued applies.
      const previousRequest = this.accountRequests.get(instanceId);
      if (previousRequest) await this.beforeDeadline(previousRequest.operation, deadline);
      const liveProvider = () => this.instances.getInstance(instanceId)?.provider ?? inferConversationHistoryProvider(conversation.entry);
      let confirmed: PendingSelection | null = null;
      let confirmedReady = false;
      for (;;) {
        if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
        this.captureOriginalAccount(conversation, instanceId);
        const selection = this.selection(entryId);
        const accountBeforeModel = this.accountChoice(entryId);
        if (selection && confirmed !== selection) {
          confirmedReady = await this.applySelection(instanceId, selection, deadline,
            () => this.selection(entryId) !== selection ? 'selection'
              : this.accountChoice(entryId) !== accountBeforeModel ? 'account' : null);
          confirmed = confirmedReady ? selection : null;
        }
        if (this.selection(entryId) !== selection) continue;
        const account = this.accountChoice(entryId);
        const choiceProvider = this.accountChoiceProviders.get(entryId)
          ?? inferConversationHistoryProvider(conversation.entry);
        const selectedProvider = selection?.provider ?? liveProvider();
        const applicableAccount = choiceProvider === selectedProvider ? account : null;
        const pendingProvider = this.instances.getInstance(instanceId)?.desiredRuntime?.provider;
        if (applicableAccount && selection?.provider !== 'local-model' && (!this.originalAccounts.has(entryId)
          || (!selection && pendingProvider && pendingProvider !== selectedProvider))) {
          await this.waitForAccountHandoff(instanceId, deadline);
          this.captureOriginalAccount(conversation, instanceId);
        }
        // Re-read drafts and the live provider after readiness before routing an account.
        if (this.selection(entryId) !== selection || this.accountChoice(entryId) !== account) continue;
        if (!selection && liveProvider() !== selectedProvider) continue;
        const original = this.originalAccounts.get(entryId);
        const hasAccountOverride = this.accountHandoffs.has(entryId) || !!this.restoredAccountKey.get(entryId);
        // Model IPC can confirm a provider swap before the store event arrives.
        const resetAccount = !applicableAccount && hasAccountOverride
          && selectedProvider === original?.provider
          ? original?.profileId : undefined;
        const wanted = selection?.provider === 'local-model' ? undefined : applicableAccount ?? resetAccount;
        if (wanted) {
          const live = this.instances.getInstance(instanceId);
          // Account-only recovery can precede model confirmation only for the
          // same live runtime with no future write. A queued provider/model
          // swap must settle and be re-confirmed before routing its account.
          if (selection && confirmed !== selection && (live?.desiredRuntime || live?.provider !== selectedProvider
            || (selection.model && normalizeModelAliasForProvider(selection.provider, live?.currentModel)
              !== normalizeModelAliasForProvider(selection.provider, selection.model)))) {
            await this.waitForAccountHandoff(instanceId, deadline, false,
              () => this.selection(entryId) !== selection || this.accountChoice(entryId) !== account);
            continue;
          }
          // The backend can stamp a changed account before its startup fails.
          // Keep the original-account reset available even when readiness fails.
          this.accountHandoffs.add(entryId);
          await this.switchToAccount(instanceId, selectedProvider, wanted, deadline);
        } else {
          const pendingRuntime = this.instances.getInstance(instanceId)?.desiredRuntime;
          // A reconnected preview may reuse a runtime being changed by another
          // renderer, or one still starting without a queued change. Neither
          // permits releasing loop work before successful readiness.
          await this.waitForAccountHandoff(instanceId, deadline, confirmedReady,
            () => this.selection(entryId) !== selection || this.accountChoice(entryId) !== account);
          if (this.selection(entryId) !== selection || this.accountChoice(entryId) !== account
            || (!selection && liveProvider() !== selectedProvider)) continue;
          if (this.instances.getInstance(instanceId)?.status === 'error') {
            throw new Error(pendingRuntime
              ? 'Could not continue this session. The pending runtime change failed; try again when it is ready.'
              : 'Could not continue this session. The restored session did not finish starting; try again when it is ready.');
          }
        }
        // An account-only draft can interrupt an unready model wait. Its
        // handoff may recover startup, but the model still needs confirmation.
        if (selection && confirmed !== selection) continue;
        if (this.selection(entryId) === selection && this.accountChoice(entryId) === account) {
          if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
          this.preparedChoices.set(entryId, { selection, account });
          return instanceId;
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setError(
        entryId,
        detail.startsWith('Could not continue') || detail === MODEL_WAIT_ERROR
          ? detail
          : `Could not apply the selected model. ${detail}`,
      );
      return null;
    }
  }

  /** Remember the original account before any handoff, including a routed warm restore. */
  private captureOriginalAccount(conversation: ConversationData, instanceId: string): void {
    const entryId = conversation.entry.id;
    if (this.originalAccounts.has(entryId)) return;
    const provider = inferConversationHistoryProvider(conversation.entry);
    const instance = this.instances.getInstance(instanceId);
    if (this.restoredAccountKey.get(entryId) || (instance?.provider && instance.provider !== provider)) {
      this.originalAccounts.set(entryId, { provider,
        profileId: conversation.entry.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID });
    } else if (instance && isModelSwitchAllowedStatus(instance.status) && !instance.desiredRuntime) {
      this.originalAccounts.set(entryId, { provider,
        profileId: instance.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID });
    }
  }

  /** Account to pin at spawn. A different provider's account is applied after that swap. */
  private accountForRestore(conversation: ConversationData): string | undefined {
    const choice = this.accountChoice(conversation.entry.id);
    const selection = this.selection(conversation.entry.id);
    if (!choice || selection?.provider === 'local-model'
      || (selection && selection.provider !== inferConversationHistoryProvider(conversation.entry))) return undefined;
    const choiceProvider = this.accountChoiceProviders.get(conversation.entry.id)
      ?? inferConversationHistoryProvider(conversation.entry);
    if (choiceProvider !== inferConversationHistoryProvider(conversation.entry)) return undefined;
    return choice;
  }

  private async switchToAccount(instanceId: string, provider: string, profileId: string, deadline: number): Promise<void> {
    if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
    const current = this.instances.getInstance(instanceId);
    const previous = this.accountRequests.get(instanceId);
    const changedRequest = previous && (previous.provider !== provider || previous.profileId !== profileId);
    if (changedRequest || current?.provider !== provider || (current.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID) !== profileId
      || current.desiredRuntime) {
      const operation = this.accounts.switchSession(instanceId, profileId).catch(error => ({
        success: false,
        error: { code: 'ACCOUNT_SWITCH_FAILED', message: error instanceof Error ? error.message : String(error), timestamp: Date.now() },
      }));
      this.accountRequests.set(instanceId, { provider, profileId, operation });
      const response = await this.beforeDeadline(operation, deadline);
      if (!response.success) {
        const reason = response.error?.message || 'The account could not be switched.';
        throw new Error(`Could not continue on the account you chose. ${reason}`);
      }
    }
    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error('Could not continue on the account you chose. The session is still starting; try again.');
      }
      const instance = this.instances.getInstance(instanceId);
      if (instance && instance.provider === provider && (instance.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID) === profileId
        && !instance.desiredRuntime && isModelSwitchAllowedStatus(instance.status) && instance.status !== 'error') return;
      if (!instance || ['terminated', 'failed', 'cancelled', 'superseded', 'error'].includes(instance.status)) {
        throw new Error('Could not continue on the account you chose. The restored session stopped before the account change finished.');
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
  }

  private async waitForAccountHandoff(
    instanceId: string,
    deadline: number,
    waitForSuccessfulState = false,
    draftChanged?: () => boolean,
  ): Promise<void> {
    for (;;) {
      if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
      const instance = this.instances.getInstance(instanceId);
      // A matching settled model IPC can precede the store update that clears
      // an old error. Wait for that event; the old error cannot release work.
      if (instance && isModelSwitchAllowedStatus(instance.status) && !instance.desiredRuntime
        && (!waitForSuccessfulState || instance.status !== 'error')) return;
      if (!instance || ['terminated', 'failed', 'cancelled', 'superseded'].includes(instance.status)) {
        throw new Error(draftChanged
          ? 'Could not continue this session. The restored session stopped before startup finished.'
          : 'Could not continue on the account you chose. The restored session stopped before the account change finished.');
      }
      if (draftChanged?.()) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
  }

  private async applySelection(
    instanceId: string, selection: PendingSelection, deadline: number, draftChanged: () => 'selection' | 'account' | null,
  ): Promise<boolean> {
    if (historyEntryIdFromPreview(instanceId)) throw new Error('Restore the session before changing its model.');
    const target = selection.modelRuntimeTarget;
    if (selection.provider === 'local-model' && !target) throw new Error('Choose a local model again.');
    for (;;) {
      if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
      const before = this.instances.getInstance(instanceId);
      const response = await this.beforeDeadline(this.ipc.changeModel(
        instanceId,
        target?.kind === 'local-model' ? target.modelId : selection.model ?? undefined,
        selection.reasoning,
        target ?? undefined,
        target || selection.provider === 'local-model' ? undefined : selection.provider,
      ), deadline);
      const changed = draftChanged();
      if (changed === 'selection') {
        const live = this.instances.getInstance(instanceId);
        if (!live || ['terminated', 'failed', 'cancelled', 'superseded'].includes(live.status)) {
          throw new Error('The restored session stopped. Please restore it again.');
        }
        return false;
      }
      if (!response.success) throw new Error(response.error?.message || 'Please try again.');
      const data = response.data as Partial<Instance> | undefined;
      if (!data || data.id !== instanceId) throw new Error('The session did not confirm the model change. Please try again.');
      const matches = target?.kind === 'local-model'
        ? data.runtimeSummary?.kind === 'local-model' && data.runtimeSummary.selectorId === target.selectorId
        : data.provider === (target?.kind === 'cli' ? target.provider ?? selection.provider : selection.provider)
          && (!selection.model || normalizeModelAliasForProvider(selection.provider, data.currentModel)
            === normalizeModelAliasForProvider(selection.provider, selection.model));
      if (!data.desiredRuntime && ['error', 'terminated', 'failed', 'cancelled', 'superseded'].includes(data.status ?? '')) {
        throw new Error('Could not continue this session. The selected model did not finish starting; try again when it is ready.');
      }
      // Only a superseded model may discard its obsolete response. An account
      // change retains this model's response validity before attempting recovery.
      if (changed === 'account') {
        if (!data.desiredRuntime && !matches) {
          throw new Error('The session confirmed a different model. Choose an available model and try again.');
        }
        return false;
      }
      if (!data.desiredRuntime && isModelSwitchAllowedStatus(data.status)) {
        if (!matches) throw new Error('The session confirmed a different model. Choose an available model and try again.');
        if (data.provider) {
          this.confirmedByInstance.set(instanceId, {
            selection,
            before: before ? { provider: before.provider, currentModel: before.currentModel } : null,
            after: { provider: data.provider, currentModel: data.currentModel },
          });
        }
        return true;
      }

      // Replay restores and unchanged-model ACKs can precede initialization.
      // Neither an unready response nor a queued ACK permits sending. Wait for
      // settlement, then re-confirm through IPC (also detects a failed apply).
      for (;;) {
        if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
        await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
        if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
        const instance = this.instances.getInstance(instanceId);
        if (!instance || ['terminated', 'failed', 'cancelled', 'superseded'].includes(instance.status)) {
          throw new Error('The restored session stopped. Please restore it again.');
        }
        // A changed draft owns recovery; abandon this captured wait without
        // treating its model as confirmed or releasing continuation work.
        const nextChange = draftChanged();
        if (nextChange) {
          if (nextChange === 'account' && !data.desiredRuntime && !matches) {
            throw new Error('The session confirmed a different model. Choose an available model and try again.');
          }
          return false;
        }
        if (!instance.desiredRuntime && isModelSwitchAllowedStatus(instance.status)) break;
      }
    }
  }

  private async beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(MODEL_WAIT_ERROR)), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (Date.now() >= deadline) throw new Error(MODEL_WAIT_ERROR);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
