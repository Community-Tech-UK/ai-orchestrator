import { computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { RuntimeChangePreviewIpcService } from '../../core/services/ipc/runtime-change-preview-ipc.service';
import type { Instance } from '../../core/state/instance/instance.types';
import { yoloChangeRequestOf, yoloCostKeyOf } from './runtime-change-preview.controller';
import { shouldClearInputRequiredForStatus } from '../../core/services/ipc/input-required-lifecycle';
import type { UserActionRequest } from './user-action-request.types';

/** Permission-card previews never carry tool input, secret values or permission decisions. */
export class UserActionYoloCost {
  private readonly ipc = inject(RuntimeChangePreviewIpcService);
  private readonly destroyed = inject(DestroyRef);
  private generation = 0;
  private readonly runtimeKey;
  readonly note = signal<string | null>(null);
  readonly checking = signal(false);
  readonly confirmation = signal<{ request: UserActionRequest; text: string; apply: () => Promise<void> } | null>(null);

  constructor(
    private readonly selectedId: () => string | null,
    private readonly requests: () => UserActionRequest[],
    private readonly instance: (id: string) => Instance | undefined,
  ) {
    this.runtimeKey = computed(() => {
      const id = this.selectedId();
      const runtime = id ? this.instance(id) : undefined;
      return JSON.stringify([id, runtime?.sessionId, runtime?.providerSessionId, runtime?.restartEpoch,
        runtime?.adapterGeneration, runtime?.status, runtime?.accountProfileId, runtime?.copilotAccountProfileId,
        runtime?.reasoningEffort, runtime?.desiredRuntime, yoloCostKeyOf(runtime)]);
    });
    effect(onCleanup => {
      const key = this.runtimeKey();
      const request = this.requests().find(item => untracked(() => this.current(item, key)));
      let active = true;
      this.note.set(null);
      this.cancel();
      onCleanup(() => { active = false; this.cancel(); });
      if (request) {
        const change = untracked(() => yoloChangeRequestOf(this.instance(request.instanceId) ?? {}, true));
        void this.ipc.preview(request.instanceId, change)
          .then(note => { if (active && this.current(request, key)) this.note.set(note?.text ?? null); });
      }
    });
    this.destroyed.onDestroy(() => this.cancel());
  }

  private current(request: UserActionRequest, key: string): boolean {
    const runtime = this.instance(request.instanceId);
    return !this.destroyed.destroyed && key === this.runtimeKey() && this.selectedId() === request.instanceId
      && this.requests().includes(request) && request.requestType === 'input_required'
      && ['deferred_permission', 'codex_mcp_approval'].includes(request.permissionMetadata?.type ?? '')
      && !runtime?.yoloMode && runtime?.pendingYoloMode !== true && !shouldClearInputRequiredForStatus(runtime?.status);
  }

  async gate(request: UserActionRequest, apply: () => Promise<void>): Promise<void> {
    const key = this.runtimeKey();
    if (this.checking() || this.confirmation() || !this.current(request, key)) return;
    const generation = ++this.generation;
    this.checking.set(true);
    const note = await this.ipc.preview(request.instanceId, yoloChangeRequestOf(this.instance(request.instanceId) ?? {}, true));
    if (generation !== this.generation) return;
    this.checking.set(false);
    if (!this.current(request, key)) return;
    const guardedApply = async (): Promise<void> => { if (this.current(request, key)) await apply(); };
    if (note?.large) this.confirmation.set({ request, text: note.text, apply: guardedApply });
    else await guardedApply();
  }

  confirm(): void {
    const held = this.confirmation();
    this.cancel();
    if (held) void held.apply();
  }

  cancel(): void {
    this.generation++;
    this.checking.set(false);
    this.confirmation.set(null);
  }
}
