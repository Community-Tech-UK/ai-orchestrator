import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { GatewayClient } from './gateway-client.service';
import { HapticsService } from './haptics.service';
import { HostStore } from './host-store';
import type { MobilePromptDto } from './models';

export type ApprovalScope = 'once' | 'session' | 'always';
export interface ApprovalDecision {
  action: 'allow' | 'deny';
  scope: ApprovalScope;
  response?: string;
}
export interface ApprovalDraft {
  scope: ApprovalScope;
  answers: Readonly<Record<number, string>>;
}
/** Captured by the rendered sheet, before any host/request change can occur. */
export interface ApprovalView {
  readonly hostId: string;
  readonly requestIdentity: string;
  readonly prompt: MobilePromptDto;
}
interface Presentation {
  selected: string | null;
  dismissed: boolean;
}
interface DecisionState {
  pending: boolean;
  error: string | null;
  accepted: boolean;
}
const EMPTY_DRAFT: ApprovalDraft = { scope: 'once', answers: {} };

/** Keeps unresolved approval work outside the transient sheet and host snapshots. */
@Injectable({ providedIn: 'root' })
export class ApprovalPresentationStore {
  private readonly gateway = inject(GatewayClient);
  private readonly hosts = inject(HostStore);
  private readonly haptics = inject(HapticsService);
  private readonly presentations = signal<Record<string, Presentation>>({});
  private readonly drafts = signal<Record<string, ApprovalDraft>>({});
  private readonly decisions = signal<Record<string, DecisionState>>({});
  private readonly hostId = computed(() => this.hosts.activeHost()?.id ?? null);
  private hostGeneration = 0;
  private observedHostId: string | null = null;

  readonly requests = computed(() => {
    const hostId = this.hostId();
    if (!hostId || this.gateway.dataHostId() !== hostId) return [];
    return this.gateway.prompts().filter((prompt) => !this.decisions()[this.key(hostId, prompt)]?.accepted);
  });
  readonly activePrompt = computed(() => {
    const hostId = this.hostId();
    if (!hostId) return null;
    const presentation = this.presentations()[hostId];
    if (presentation?.dismissed) return null;
    return this.requests().find((prompt) => this.identity(prompt) === presentation?.selected)
      ?? this.requests()[0] ?? null;
  });
  readonly view = computed<ApprovalView | null>(() => {
    const hostId = this.hostId();
    const prompt = this.activePrompt();
    return hostId && prompt ? { hostId, requestIdentity: this.identity(prompt), prompt } : null;
  });
  readonly draft = computed(() => {
    const key = this.activeKey();
    return key ? this.drafts()[key] ?? EMPTY_DRAFT : EMPTY_DRAFT;
  });
  readonly pending = computed(() => {
    const key = this.activeKey();
    return key ? this.decisions()[key]?.pending ?? false : false;
  });
  readonly error = computed(() => {
    const key = this.activeKey();
    return key ? this.decisions()[key]?.error ?? null : null;
  });

  constructor() {
    effect(() => {
      const hostId = this.hostId();
      if (hostId !== this.observedHostId) {
        this.observedHostId = hostId;
        this.hostGeneration += 1;
      }
      const requests = this.requests();
      if (!hostId || !requests.length) return;
      untracked(() => {
        const current = this.presentations()[hostId];
        if (!requests.some((prompt) => this.identity(prompt) === current?.selected)) {
          this.presentations.update((all) => ({ ...all, [hostId]: {
            selected: this.identity(requests[0]), dismissed: current?.dismissed ?? false,
          } }));
        }
      });
    });
  }

  open(promptId?: string, renderedView?: ApprovalView | null): void {
    // Calls from Projects/conversation intentionally have no sheet context.
    if (renderedView !== undefined && !this.isCurrentView(renderedView)) return;
    const hostId = this.hostId();
    if (!hostId) return;
    const current = this.presentations()[hostId];
    const prompt = promptId
      ? this.requests().find((request) => request.id === promptId)
      : this.requests().find((request) => this.identity(request) === current?.selected) ?? this.requests()[0];
    if (!prompt) return;
    this.presentations.update((all) => ({ ...all, [hostId]: { selected: this.identity(prompt), dismissed: false } }));
  }

  dismiss(renderedView = this.view()): void {
    if (!this.isCurrentView(renderedView)) return;
    const hostId = this.hostId();
    const prompt = this.activePrompt();
    if (!hostId || !prompt) return;
    this.presentations.update((all) => ({ ...all, [hostId]: { selected: this.identity(prompt), dismissed: true } }));
  }

  setScope(scope: ApprovalScope, renderedView = this.view()): void {
    if (!this.isCurrentView(renderedView)) return;
    this.updateDraft({ ...this.draft(), scope });
  }

  updateAnswer(index: number, value: string, renderedView = this.view()): void {
    if (!this.isCurrentView(renderedView)) return;
    this.updateDraft({ ...this.draft(), answers: { ...this.draft().answers, [index]: value } });
  }

  /** A decision belongs to the host and request captured before the first await. */
  async decide(decision: ApprovalDecision, renderedView = this.view()): Promise<void> {
    if (!this.isCurrentView(renderedView)) return;
    const hostId = this.hostId();
    const prompt = this.activePrompt();
    if (!hostId || !prompt) return;
    const key = this.key(hostId, prompt);
    if (this.decisions()[key]?.pending) return;
    this.open(prompt.id);
    const generation = this.hostGeneration;
    this.setDecision(key, { pending: true, error: null, accepted: false });
    try {
      await this.gateway.respond(prompt.instanceId, {
        requestId: prompt.requestId,
        decisionAction: decision.action,
        decisionScope: decision.scope,
        response: decision.response,
      });
      if (this.hostId() !== hostId || this.hostGeneration !== generation) return;
      this.setDecision(key, { pending: false, error: null, accepted: true });
      this.drafts.update((all) => {
        const next = { ...all };
        delete next[key];
        return next;
      });
      this.haptics.success();
    } catch (error) {
      if (this.hostId() !== hostId || this.hostGeneration !== generation) return;
      this.setDecision(key, {
        pending: false, accepted: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.decisions()[key]?.pending) {
        this.setDecision(key, { pending: false, error: null, accepted: false });
      }
    }
  }

  requestTitle(prompt: MobilePromptDto): string {
    const instance = this.gateway.snapshot()?.instances.find((item) => item.id === prompt.instanceId);
    return instance?.displayName || prompt.title;
  }

  isCurrentView(renderedView: ApprovalView | null): boolean {
    const current = this.view();
    return !!renderedView && !!current
      && renderedView.hostId === current.hostId
      && renderedView.requestIdentity === current.requestIdentity;
  }

  private identity(prompt: MobilePromptDto): string {
    return JSON.stringify([prompt.instanceId, prompt.requestId, prompt.id]);
  }

  private key(hostId: string, prompt: MobilePromptDto): string {
    return JSON.stringify([hostId, this.identity(prompt)]);
  }

  private activeKey(): string | null {
    const hostId = this.hostId();
    const prompt = this.activePrompt();
    return hostId && prompt ? this.key(hostId, prompt) : null;
  }

  private updateDraft(draft: ApprovalDraft): void {
    const key = this.activeKey();
    if (!key || this.pending()) return;
    // Pin immediately, including before the first reactive effect has run.
    this.open(this.activePrompt()?.id);
    this.drafts.update((all) => ({ ...all, [key]: draft }));
  }

  private setDecision(key: string, state: DecisionState): void {
    this.decisions.update((all) => ({ ...all, [key]: state }));
  }
}
