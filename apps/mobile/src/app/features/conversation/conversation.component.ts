import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { connectionHeadline, connectionLabel, emptyTranscriptText } from '../../core/connection-status';
import { ApprovalPresentationStore } from '../../core/approval-presentation.store';
import { GatewayClient } from '../../core/gateway-client.service';
import { HapticsService } from '../../core/haptics.service';
import { HostStore } from '../../core/host-store';
import { MobileBrowseStateStore } from '../../core/mobile-browse-state.store';
import type { MobileModelCatalog } from '../../core/models';
import {
  displayStatusColor,
  displayStatusLabel,
  isInterruptRecovery,
  isWorkingOrLooping,
} from '../../core/status';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { MobileSheetComponent } from '../../shared/mobile-sheet.component';
import { ModelSheetComponent } from '../../shared/model-sheet.component';
import { ConversationComposerComponent } from './conversation-composer.component';
import { TranscriptViewComponent } from './transcript-view.component';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Session-level conversation orchestration; transcript and composer own their local UI state. */
@Component({
  standalone: true,
  selector: 'app-conversation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ConversationComposerComponent,
    TranscriptViewComponent,
    ModelSheetComponent,
    MobileHeaderComponent,
    MobileIconComponent,
    MobileSheetComponent,
  ],
  templateUrl: './conversation.component.html',
  styleUrls: ['./conversation.component.scss'],
})
export class ConversationComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly haptics = inject(HapticsService);
  private readonly router = inject(Router);
  private readonly hosts = inject(HostStore);
  private readonly browse = inject(MobileBrowseStateStore);
  protected readonly approvals = inject(ApprovalPresentationStore);
  private readonly origin = this.router.getCurrentNavigation()?.extras.state ?? window.history.state;

  readonly projectKey = input<string>('');
  readonly instanceId = input<string>('');

  protected readonly returnRoute = computed(() => this.browse.returnRoute(this.origin));
  protected readonly hostName = computed(() => this.hosts.activeHost()?.name ?? 'Host');
  protected readonly requests = computed(() => this.approvals.requests().filter(
    (request) => request.instanceId === this.instanceId(),
  ));
  protected readonly menuOpen = signal(false);
  protected readonly modelSheetOpen = signal(false);
  protected readonly detailsOpen = signal(false);
  protected pendingModel: string | undefined;
  protected readonly modelsLoading = signal(false);
  protected readonly changingModel = signal(false);
  protected readonly modelsError = signal<string | null>(null);
  protected readonly modelCatalog = signal<MobileModelCatalog | null>(null);
  protected readonly online = this.gateway.online;
  protected readonly connectionHeadline = computed(() => connectionHeadline(this.gateway.state()));
  protected readonly transcriptState = computed(() => this.gateway.messageStateFor(this.instanceId()));
  protected readonly transcriptKey = computed(() => `${this.hosts.activeHost()?.id ?? ''}:${this.instanceId()}`);
  protected readonly hasEarlier = computed(() => this.gateway.hasEarlierFor(this.instanceId()));
  protected readonly earlierState = computed(() => this.gateway.earlierStateFor(this.instanceId()));
  protected readonly emptyTranscript = computed(() => {
    const state = this.transcriptState();
    if (state.status === 'loading') return 'Loading conversation…';
    if (state.status === 'error') return 'The conversation could not be loaded.';
    if (state.status === 'idle' && this.online()) return 'Waiting to load this conversation…';
    return emptyTranscriptText(this.gateway.state());
  });
  protected readonly instance = computed(() =>
    this.gateway.dataHostId() === this.hosts.activeHost()?.id
      ? this.gateway.snapshot()?.instances.find((instance) => instance.id === this.instanceId())
      : undefined,
  );
  protected readonly activityColor = computed(() => displayStatusColor(this.instance()));
  protected readonly activityLabel = computed(() => displayStatusLabel(this.instance()));
  protected readonly headerSubtitle = computed(() => [
    this.activityLabel(), this.online() ? '' : connectionLabel(this.gateway.state()),
  ].filter(Boolean).join(' · '));
  protected readonly working = computed(() => isWorkingOrLooping(this.instance()));
  protected readonly messages = computed(() => this.gateway.dataHostId() === this.hosts.activeHost()?.id
    ? this.gateway.messagesFor(this.instanceId())
    : []);
  protected readonly stopping = computed(() => isInterruptRecovery(this.instance()?.status ?? ''));
  protected readonly modelsForProvider = computed(() => {
    const provider = this.instance()?.provider;
    return provider ? this.modelCatalog()?.[provider] ?? [] : [];
  });
  protected readonly pairingExpired = computed(() => this.gateway.state() === 'unauthorized');

  private readonly composer = viewChild(ConversationComposerComponent);
  private contextGeneration = 0;
  private destroyed = false;

  constructor() {
    effect(() => this.gateway.setActiveView(this.instanceId() || null));
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.contextGeneration += 1;
      this.gateway.clearActiveView(this.instanceId());
    });

    effect(() => {
      const context = `${this.hosts.activeHost()?.id ?? ''}:${this.instanceId()}`;
      untracked(() => {
        void context;
        this.contextGeneration += 1;
        this.modelCatalog.set(null);
        this.modelSheetOpen.set(false);
        this.menuOpen.set(false);
        this.detailsOpen.set(false);
        this.pendingModel = undefined;
        this.modelsError.set(null);
        this.modelsLoading.set(false);
        this.changingModel.set(false);
      });
    });

    effect(() => {
      const id = this.instanceId();
      if (id && this.gateway.online() && this.gateway.dataHostId() === this.hosts.activeHost()?.id) {
        void this.gateway.loadMessages(id);
      }
    });
  }

  protected async interrupt(): Promise<void> {
    this.menuOpen.set(false);
    await this.composer()?.interrupt(true);
  }

  protected async terminate(): Promise<void> {
    this.menuOpen.set(false);
    if (!confirm('Close this session? The agent stops and unsaved work is lost.')) return;
    this.haptics.heavyTap();
    const current = this.operationScope();
    try {
      await this.gateway.terminate(this.instanceId());
      if (current()) this.back();
    } catch (err) {
      if (!current()) return;
      this.haptics.error();
      this.composer()?.showNotice(`Close failed: ${errorText(err)}`, true);
    }
  }

  protected async rename(): Promise<void> {
    this.menuOpen.set(false);
    const name = prompt('Rename session', this.instance()?.displayName ?? '');
    if (!name?.trim()) return;
    const current = this.operationScope();
    try {
      await this.gateway.rename(this.instanceId(), name.trim());
    } catch (err) {
      if (!current()) return;
      this.haptics.error();
      this.composer()?.showNotice(`Rename failed: ${errorText(err)}`, true);
    }
  }

  protected async openModelSheet(): Promise<void> {
    this.menuOpen.set(false);
    if (!this.instance()) return;
    this.modelSheetOpen.set(true);
    if (this.modelCatalog() || this.modelsLoading()) return;
    this.modelsLoading.set(true);
    this.modelsError.set(null);
    const current = this.operationScope();
    try {
      const catalog = await this.gateway.models();
      if (current()) this.modelCatalog.set(catalog);
    } catch (error) {
      if (current()) this.modelsError.set(errorText(error));
    } finally {
      if (current()) this.modelsLoading.set(false);
    }
  }

  protected async chooseModel(model: string | undefined): Promise<void> {
    if (!model || this.changingModel()) return;
    const current = this.operationScope();
    this.pendingModel = model;
    this.modelsError.set(null);
    this.changingModel.set(true);
    try {
      await this.gateway.changeModel(this.instanceId(), model);
      if (current()) {
        this.pendingModel = undefined;
        this.haptics.success();
        this.modelSheetOpen.set(false);
      }
    } catch (error) {
      if (current()) this.modelsError.set(`Model change not confirmed: ${errorText(error)}`);
    } finally {
      if (current()) this.changingModel.set(false);
    }
  }

  protected retryModel(): void {
    if (this.pendingModel) void this.chooseModel(this.pendingModel);
    else void this.openModelSheet();
  }

  protected retryTranscript(): void { void this.gateway.loadMessages(this.instanceId()); }
  protected loadEarlier(): void { void this.gateway.loadEarlier(this.instanceId()); }
  protected reconnect(): void { this.gateway.reconnect(); }
  protected changeHost(): void { void this.router.navigate(['/hosts']); }
  protected pairAgain(): void { void this.router.navigate(['/add-host']); }
  protected back(): void { void this.router.navigate([this.returnRoute()]); }

  private operationScope(): () => boolean {
    const instanceId = this.instanceId();
    const generation = this.contextGeneration;
    return () => !this.destroyed && instanceId === this.instanceId() && generation === this.contextGeneration;
  }
}
