import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import type { RuntimeChangeCostNote } from '../../../../shared/utils/runtime-change-cost';
import {
  RuntimeChangePreviewIpcService,
  type RuntimeChangePreviewRequest,
} from '../../core/services/ipc/runtime-change-preview-ipc.service';
import type { PendingSelection } from '../models/compact-model-picker.types';
import type { DesiredRuntime } from '../../../../shared/types/instance.types';

/** Wait this long on an option before asking what choosing it would do. */
const POINT_DELAY_MS = 150;

/** Native runtime identity changes even when the visible session keeps its id. */
export interface RuntimePreviewIdentity {
  sessionId?: string;
  providerSessionId?: string;
  restartEpoch?: number;
  adapterGeneration?: number;
}

export function runtimePreviewIdentityOf(instance: RuntimePreviewIdentity | undefined | null): string {
  return JSON.stringify([instance?.sessionId, instance?.providerSessionId, instance?.restartEpoch, instance?.adapterGeneration]);
}

/**
 * The change a model-picker selection asks for, in the form both the preview and the real
 * `changeModel` call take. Kept in one place so the sentence shown before a click describes
 * the request that click will make.
 */
export function changeRequestOf(selection: PendingSelection): {
  model: string | undefined;
  reasoningEffort: PendingSelection['reasoning'] | undefined;
  modelRuntimeTarget: PendingSelection['modelRuntimeTarget'];
  provider: RuntimeChangePreviewRequest['provider'];
} {
  const target = selection.modelRuntimeTarget;
  if (target) {
    return {
      model: target.kind === 'local-model' ? target.modelId : selection.model ?? undefined,
      reasoningEffort: selection.reasoning ?? undefined,
      modelRuntimeTarget: target,
      provider: undefined,
    };
  }
  return {
    model: selection.model ?? undefined,
    reasoningEffort: selection.reasoning ?? undefined,
    modelRuntimeTarget: undefined,
    provider: selection.provider === 'local-model' ? undefined : selection.provider,
  };
}

/**
 * The change a click on the auto-approve toggle would make. Kept in one place so the sentence shown
 * before the click, and the question asked at the click, describe the same request.
 */
export function yoloChangeRequestOf(instance: { currentModel?: string; desiredRuntime?: DesiredRuntime }, enable: boolean): RuntimeChangePreviewRequest {
  const desired = instance.desiredRuntime;
  const provider = desired?.provider;
  const model = desired ? desired.model : instance.currentModel;
  return {
    ...(model ? { model } : {}),
    ...(provider && provider !== 'auto' ? { provider } : {}),
    ...(desired?.reasoningEffort !== undefined ? { reasoningEffort: desired.reasoningEffort } : {}),
    ...(desired?.modelRuntimeTarget ? { modelRuntimeTarget: desired.modelRuntimeTarget } : {}),
    ...(desired?.accountProfileId ? { accountProfileId: desired.accountProfileId } : {}),
    ...(desired?.copilotAccountProfileId ? { copilotAccountProfileId: desired.copilotAccountProfileId } : {}),
    yoloMode: enable,
  };
}

/**
 * What the auto-approve sentence depends on, so it is asked for again only when one of these changes
 * and not on every streamed message: the session, its model, the flip being offered, whether it is idle,
 * and its size to the nearest 10K tokens.
 */
export function yoloCostKeyOf(instance: {
  id: string; provider: string; currentModel?: string; yoloMode: boolean; pendingYoloMode?: boolean;
  status: string; contextUsage?: { used: number };
  desiredRuntime?: DesiredRuntime;
} & RuntimePreviewIdentity | undefined | null): string | null {
  if (!instance) return null;
  return [instance.id, runtimePreviewIdentityOf(instance), instance.provider, instance.currentModel, instance.yoloMode, instance.pendingYoloMode,
    JSON.stringify(instance.desiredRuntime), instance.status === 'idle', Math.round((instance.contextUsage?.used ?? 0) / 10_000)].join('|');
}

function previewRequestOf(selection: PendingSelection): RuntimeChangePreviewRequest {
  const request = changeRequestOf(selection);
  return {
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.modelRuntimeTarget ? { modelRuntimeTarget: request.modelRuntimeTarget } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
  };
}

export interface PendingConfirmation {
  /** The sentence that explains why the change is being held for a yes. */
  text: string;
  /** The session the sentence was computed for; a yes only applies while it is still the bound one. */
  instanceId: string;
  apply: () => void | Promise<void>;
}

/**
 * Says what a restarting change will cost before it is made: a line while someone points at an
 * option in the picker, and a yes/no before a change that would leave a large conversation behind
 * or re-read it at full price. Provided per component; it holds no state beyond what is on screen.
 *
 * The owner is a reused node whose inputs swap when the session changes (the composer) or that
 * retargets on a session switch (the instance header): every question is bound to the session it
 * was computed for, and {@link invalidate} drops it — and anything still in flight — when that
 * session is replaced, the question is withdrawn, or the owner is destroyed.
 */
@Injectable()
export class RuntimeChangePreviewController {
  private readonly ipc = inject(RuntimeChangePreviewIpcService);
  private pointTimer: ReturnType<typeof setTimeout> | undefined;
  private pointRequest = 0;
  /** Bumped whenever the screen no longer describes the session the question was asked about. */
  private generation = 0;
  private boundSessionKey: string | null = null;

  /** The sentence for the option being pointed at, for the open picker. */
  readonly optionNote = signal<string | null>(null);
  /** A large change waiting for a yes or no. */
  readonly pendingConfirmation = signal<PendingConfirmation | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.invalidate());
  }

  /**
   * The owner says what session it is bound to (its instance id, or a wider key
   * that also changes when the session is replaced). The first bind is not a
   * replacement — nothing has been asked yet — but any later change is, and
   * drops everything this controller holds or has in flight for the old one.
   */
  bind(sessionKey: string): void {
    if (this.boundSessionKey !== null && this.boundSessionKey !== sessionKey) this.invalidate();
    this.boundSessionKey = sessionKey;
  }

  /**
   * The bound session changed, the question was answered with no, or the owner is going away:
   * forget what is on screen and drop any preview still in flight, so a late answer can never
   * act on the wrong chat.
   */
  invalidate(): void {
    ++this.generation;
    ++this.pointRequest;
    clearTimeout(this.pointTimer);
    this.optionNote.set(null);
    this.pendingConfirmation.set(null);
  }

  /** Pointing at an option (or leaving it, with null): after a short pause, ask what choosing it would do. */
  pointAt(instanceId: string, selection: PendingSelection | null): void {
    clearTimeout(this.pointTimer);
    const request = ++this.pointRequest;
    if (!selection) {
      this.optionNote.set(null);
      return;
    }
    this.pointTimer = setTimeout(() => {
      void this.ipc.preview(instanceId, previewRequestOf(selection)).then((note) => {
        if (request === this.pointRequest) this.optionNote.set(note?.text ?? null);
      });
    }, POINT_DELAY_MS);
  }

  /** The picker closed: forget what was being pointed at. */
  clearPointer(): void {
    clearTimeout(this.pointTimer);
    this.pointRequest++;
    this.optionNote.set(null);
  }

  /**
   * Run `apply` now, unless the change is a large one (it would leave a large part of the conversation
   * behind, or re-read it at full price): then hold it for a yes. An unavailable answer never holds
   * anything back. A preview that lands after the session changed (or the owner went away) is
   * dropped instead of held or applied.
   */
  async gate(instanceId: string, request: RuntimeChangePreviewRequest, apply: () => void | Promise<void>): Promise<void> {
    this.invalidate(); // A newer choice withdraws both a held question and any older preview.
    const generation = this.generation;
    const note: RuntimeChangeCostNote | null = await this.ipc.preview(instanceId, request);
    if (generation !== this.generation) return;
    if (note?.large) {
      this.pendingConfirmation.set({ text: note.text, instanceId, apply });
      return;
    }
    await apply();
  }

  /** Gate a model-picker selection. */
  gateSelection(instanceId: string, selection: PendingSelection, apply: () => void | Promise<void>): Promise<void> {
    return this.gate(instanceId, previewRequestOf(selection), apply);
  }

  /** Yes: run the held change, once, for the session it was previewed for. */
  confirm(instanceId: string): void {
    const held = this.pendingConfirmation();
    this.invalidate();
    if (!held || held.instanceId !== instanceId) return;
    void held.apply();
  }

  /** No (or the question no longer applies): drop the held change and anything in flight. */
  cancel(): void {
    this.invalidate();
  }

  /** The sentence for a single request, for places that show it as text. */
  async describe(instanceId: string, request: RuntimeChangePreviewRequest): Promise<string | null> {
    return (await this.ipc.preview(instanceId, request))?.text ?? null;
  }
}
