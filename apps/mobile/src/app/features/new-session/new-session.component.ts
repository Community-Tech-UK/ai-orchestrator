import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { composerBlockedText, hostAvailabilityText } from '../../core/connection-status';
import { DraftStore, mergeEarlyNewSessionDraft, type NewSessionDraft } from '../../core/draft-store';
import { ConversationDraftRecoveryService, joinDraftText } from '../../core/conversation-draft-recovery.service';
import { GatewayClient } from '../../core/gateway-client.service';
import { HapticsService } from '../../core/haptics.service';
import { HostStore } from '../../core/host-store';
import { ImageAttachmentService } from '../../core/image-attachment.service';
import type {
  MobileAttachmentDto,
  MobileModelCatalog,
  MobileRecentDirDto,
  MobileReasoningEffort,
  MobileSessionPlan,
} from '../../core/models';
import { VoiceInputService } from '../../core/voice-input.service';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { MobileSheetComponent } from '../../shared/mobile-sheet.component';
import { ModelSheetComponent } from '../../shared/model-sheet.component';
import {
  buildCreateInstanceRequest,
  canStartSession,
  defaultReasoningEffortForProvider,
  newSessionSuccessRoute,
  providerDisplayName,
  reasoningOptionsForProvider,
  sessionPlanSummary,
} from './new-session.presentation';

import { trustedNewSessionDirectory } from './new-session.navigation';

const PROVIDERS = ['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor', 'grok'] as const;

@Component({
  standalone: true,
  selector: 'app-new-session',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MobileHeaderComponent,
    MobileIconComponent,
    MobileSheetComponent,
    ModelSheetComponent,
  ],
  templateUrl: './new-session.component.html',
  styleUrls: ['./new-session.component.scss'],
})
export class NewSessionComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly hostStore = inject(HostStore);
  private readonly images = inject(ImageAttachmentService);
  private readonly drafts = inject(DraftStore);
  private readonly draftRecovery = inject(ConversationDraftRecoveryService);
  private initialDraft: NewSessionDraft | undefined;
  private composerAutofocused = false;
  private detachDraftRecovery: (() => void) | undefined;
  private readonly haptics = inject(HapticsService);
  private readonly voice = inject(VoiceInputService);
  private readonly router = inject(Router);
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  readonly dir = input('');

  protected readonly providers = PROVIDERS;
  protected readonly online = this.gateway.online;
  /** Both distinguish an expired pairing from an ordinary network drop. */
  protected readonly hostAvailability = computed(() => hostAvailabilityText(this.gateway.state()));
  protected readonly composerBlocked = computed(() => composerBlockedText(this.gateway.state()));
  protected readonly dirs = signal<MobileRecentDirDto[]>([]);
  protected readonly loadingDirs = signal(true);
  protected readonly dirsError = signal<string | null>(null);
  protected readonly selectedDir = signal('');
  protected readonly directorySheetOpen = signal(false);
  protected readonly directoryReturnFocus = signal<HTMLElement | null>(null);
  protected readonly settingsSheetOpen = signal(false);
  protected readonly settingsReturnFocus = signal<HTMLElement | null>(null);
  protected readonly attachmentSheetOpen = signal(false);
  protected readonly attachments = signal<MobileAttachmentDto[]>([]);
  protected readonly attachBusy = signal(false);
  protected readonly canAttach = this.images.available;
  protected readonly canDictate = this.voice.available;
  protected readonly listening = this.voice.listening;
  protected readonly provider = signal<(typeof PROVIDERS)[number]>('auto');
  protected readonly model = signal<string | undefined>(undefined);
  protected readonly reasoningEffort = signal<MobileReasoningEffort | undefined>(undefined);
  protected readonly plan = signal<MobileSessionPlan | null>(null);
  protected readonly planLoading = signal(false);
  protected readonly planError = signal<string | null>(null);
  protected readonly modelSheetOpen = signal(false);
  protected readonly modelsLoading = signal(false);
  protected readonly modelsError = signal<string | null>(null);
  protected readonly modelCatalog = signal<MobileModelCatalog | null>(null);
  protected readonly firstPrompt = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private planReq = 0;
  private readonly draftHostId = this.hostStore.activeHost()?.id ?? '';
  private readonly draftOwner = this.drafts.claimNewSession(this.draftHostId);
  private readonly navigationState: unknown = this.router.getCurrentNavigation()?.extras.state ?? history.state;
  protected readonly legacyDraft = signal('');
  private readonly draftReady = signal(false);
  private readonly destroyed = inject(DestroyRef);
  private submitted = false;
  private directoriesRequest = 0;
  protected readonly inputError = signal<string | null>(null);
  protected readonly voiceBusy = signal(false);
  private voiceRequest = 0;

  protected readonly presetDir = computed(() => {
    const passed = this.dir();
    return trustedNewSessionDirectory(this.navigationState, this.draftHostId, passed);
  });
  protected readonly directoryIsRecent = computed(() =>
    this.dirs().some((directory) => directory.path === this.selectedDir()),
  );
  protected readonly selectedDirLabel = computed(() => {
    const path = this.selectedDir();
    if (!path) return 'Choose working directory';
    return this.dirs().find((directory) => directory.path === path)?.displayName
      ?? path.split(/[\\/]/).filter(Boolean).at(-1)
      ?? path;
  });
  protected readonly hostName = computed(
    () => this.gateway.snapshot()?.hostName ?? this.hostStore.activeHost()?.name ?? 'Choose a host',
  );
  protected readonly providerDisplay = computed(() => providerDisplayName(this.provider()));
  protected readonly planSummary = computed(() =>
    this.planError() ? 'Resolution unavailable' : sessionPlanSummary(this.plan()),
  );
  protected readonly compactPlanSummary = computed(() => {
    const plan = this.plan();
    if (!plan) return this.planLoading() ? 'Resolving…' : this.providerDisplay();
    return [plan.modelLabel || plan.providerLabel, plan.reasoningEffortLabel]
      .filter((value): value is string => Boolean(value))
      .join(' · ');
  });
  protected readonly modelsForProvider = computed(() => this.modelCatalog()?.[this.provider()] ?? []);
  protected readonly reasoningOptions = computed(() => reasoningOptionsForProvider(this.provider()));
  protected readonly selectedModelLabel = computed(() => {
    const id = this.model();
    if (!id) return 'Default';
    return this.modelsForProvider().find((item) => item.id === id)?.name ?? id;
  });
  protected readonly canCreate = computed(() =>
    canStartSession({
      online: this.online(),
      directory: this.selectedDir(),
      busy: this.busy() || this.attachBusy() || this.voiceBusy() || this.listening() || !this.draftReady() || this.submitted || !this.isCurrentHost(),
    }),
  );

  constructor() {
    effect(() => {
      const preset = this.presetDir();
      if (preset && !this.selectedDir()) this.selectedDir.set(preset);
    });

    effect(() => {
      if (!this.isCurrentHost()) {
        this.voiceRequest++;
        void this.voice.stop();
        this.voiceBusy.set(false);
        return;
      }
      if (this.voice.listening()) this.firstPrompt.set(this.voice.text());
    });

    effect(() => this.persistDraft());

    effect(() => {
      const provider = this.provider();
      const model = this.model();
      const reasoningEffort = this.reasoningEffort();
      void this.resolvePlan(provider, model, reasoningEffort);
    });

    effect(() => {
      const composer = this.composer();
      const ready = Boolean(this.selectedDir())
        && !this.directorySheetOpen()
        && !this.directoryReturnFocus()
        && !this.settingsSheetOpen()
        && !this.attachmentSheetOpen()
        && !this.modelSheetOpen();
      if (composer && ready && !this.composerAutofocused) {
        this.composerAutofocused = true;
        queueMicrotask(() => { if (!this.destroyed.destroyed) composer.nativeElement.focus({ preventScroll: true }); });
      }
    });

    inject(DestroyRef).onDestroy(() => {
      this.detachDraftRecovery?.();
      this.voiceRequest++;
      void this.voice.stop();
      this.persistDraftOnExit();
    });
  }

  async ngOnInit(): Promise<void> {
    const preset = this.presetDir();
    if (preset) this.selectedDir.set(preset);
    this.loadingDirs.set(false);
    const key = `new-session:${this.draftHostId}`;
    const initialAttachments = this.draftHostId ? this.drafts.attachments(key) : [];
    this.attachments.set(initialAttachments);
    this.initialDraft = this.currentDraft();
    const ready = this.restoreDraft(this.initialDraft, preset, initialAttachments);
    if (this.draftHostId) {
      this.detachDraftRecovery = this.draftRecovery.attach(key, async (text, attachments) => {
        await ready;
        if (!this.isCurrentHost() || this.submitted) return false;
        this.firstPrompt.update((current) => joinDraftText(current, text));
        this.attachments.update((current) => [...current, ...attachments]);
        this.persistDraft();
        return true;
      });
    }
    await ready;
    if (this.isCurrentHost() && !this.selectedDir()) await this.openDirectorySheet();
  }

  private async restoreDraft(initial: NewSessionDraft, preset: string, initialAttachments: MobileAttachmentDto[]): Promise<void> {
    const [draft, legacy] = await Promise.all([this.drafts.loadNewSession(this.draftHostId), this.drafts.load('new-session')]);
    if (!this.isCurrentHost() || this.submitted) return;
    if (draft) {
      this.firstPrompt.update((text) => joinDraftText(text, draft.text));
      if (!preset && this.selectedDir() === initial.directory) this.selectedDir.set(draft.directory);
      if (this.provider() === initial.provider && this.model() === initial.model && this.reasoningEffort() === initial.reasoningEffort
        && PROVIDERS.includes(draft.provider as (typeof PROVIDERS)[number])) {
        this.provider.set(draft.provider as (typeof PROVIDERS)[number]);
        this.model.set(draft.model);
        this.reasoningEffort.set(draft.reasoningEffort);
      }
    }
    // Recovery can reach storage between the first image read and this async load.
    // Only add newly recovered items, preserving any removals the user already made.
    const lateAttachments = this.draftHostId ? this.drafts.attachments(`new-session:${this.draftHostId}`)
      .filter((item) => !initialAttachments.includes(item)) : [];
    this.attachments.update((current) => [...new Set([...current, ...lateAttachments])]);
    this.legacyDraft.set(legacy);
    this.draftReady.set(true);
    this.persistDraft();
  }

  protected async openDirectorySheet(event?: Event): Promise<void> {
    if (this.busy()) return;
    this.directoryReturnFocus.set(event?.currentTarget instanceof HTMLElement ? event.currentTarget : null);
    this.directorySheetOpen.set(true);
    await this.loadDirectories();
  }

  protected async loadDirectories(): Promise<void> {
    const request = ++this.directoriesRequest;
    this.loadingDirs.set(true);
    this.dirsError.set(null);
    try {
      const directories = await this.gateway.recentDirs();
      if (request === this.directoriesRequest && this.isCurrentHost()) this.dirs.set(directories);
    } catch (err) {
      if (request === this.directoriesRequest) this.dirsError.set(this.errorMessage(err));
    } finally {
      if (request === this.directoriesRequest) this.loadingDirs.set(false);
    }
  }

  protected chooseDirectory(path: string): void {
    this.selectedDir.set(path);
    this.directorySheetOpen.set(false);
    this.haptics.tap();
  }

  protected displayProvider(provider: string): string {
    return providerDisplayName(provider);
  }

  protected selectProvider(provider: (typeof PROVIDERS)[number]): void {
    if (this.provider() !== provider) {
      this.provider.set(provider);
      this.model.set(undefined);
      this.reasoningEffort.set(defaultReasoningEffortForProvider(provider));
    }
    this.haptics.tap();
  }

  protected openSettings(event: Event): void {
    this.settingsReturnFocus.set(event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
    this.settingsSheetOpen.set(true);
  }

  protected completeSettings(): void {
    this.settingsSheetOpen.set(false);
    this.haptics.tap();
  }

  protected retryPlan(): void {
    void this.resolvePlan(this.provider(), this.model(), this.reasoningEffort());
  }

  protected async openModelSheet(): Promise<void> {
    if (this.provider() === 'auto') return;
    this.settingsSheetOpen.set(false);
    this.modelSheetOpen.set(true);
    if (this.modelCatalog() || this.modelsLoading()) return;
    this.modelsLoading.set(true);
    this.modelsError.set(null);
    try {
      const catalog = await this.gateway.models();
      if (this.isCurrentHost()) this.modelCatalog.set(catalog);
    } catch (err) {
      this.modelsError.set(this.errorMessage(err));
    } finally {
      this.modelsLoading.set(false);
    }
  }

  protected chooseModel(model: string | undefined): void {
    this.model.set(model);
    this.haptics.tap();
  }

  protected chooseReasoningEffort(reasoningEffort: MobileReasoningEffort | undefined): void {
    this.reasoningEffort.set(reasoningEffort);
    this.haptics.tap();
  }

  protected async toggleDictation(): Promise<void> {
    if (this.busy() || this.voiceBusy() || !this.isCurrentHost()) return;
    const request = ++this.voiceRequest;
    const current = () => request === this.voiceRequest && this.isCurrentHost();
    this.voiceBusy.set(true);
    this.inputError.set(null);
    try {
      if (this.voice.listening()) {
        const text = this.voice.text();
        this.firstPrompt.set(text);
        await this.voice.stop();
      } else if (!await this.voice.start(this.firstPrompt()) && current()) {
        this.inputError.set('Dictation could not start. Check microphone and speech permissions, then try again.');
        this.haptics.error();
      }
    } catch (err) {
      if (current()) this.inputError.set(`Dictation failed: ${this.errorMessage(err)}`);
    } finally {
      if (current()) this.voiceBusy.set(false);
    }
  }

  protected async pickImages(): Promise<void> {
    if (this.attachBusy() || this.busy()) return;
    this.attachBusy.set(true);
    this.inputError.set(null);
    try {
      const picked = await this.images.pickImages();
      if (picked.length && this.draftHostId) await this.draftRecovery.recover(`new-session:${this.draftHostId}`, '', picked);
      if (!this.isCurrentHost()) return;
      this.attachmentSheetOpen.set(false);
    } catch (err) {
      if (!this.isCurrentHost()) return;
      if (!/cancel(?:led|ed)?/i.test(this.errorMessage(err))) this.inputError.set(this.errorMessage(err));
      this.attachmentSheetOpen.set(false);
    } finally {
      if (this.isCurrentHost()) this.attachBusy.set(false);
    }
  }

  protected async pasteImageFromClipboard(): Promise<void> {
    if (this.attachBusy() || this.busy()) return;
    this.attachBusy.set(true);
    this.inputError.set(null);
    try {
      const pasted = await this.images.pasteImageFromClipboard();
      if (pasted && this.draftHostId) await this.draftRecovery.recover(`new-session:${this.draftHostId}`, '', [pasted]);
      if (!this.isCurrentHost()) return;
      if (!pasted) this.inputError.set('No image was added. Copy an image and allow clipboard access, then try again.');
      this.attachmentSheetOpen.set(false);
    } catch (err) {
      if (!this.isCurrentHost()) return;
      this.inputError.set(this.errorMessage(err));
      this.attachmentSheetOpen.set(false);
    } finally {
      if (this.isCurrentHost()) this.attachBusy.set(false);
    }
  }

  protected async onPaste(event: ClipboardEvent): Promise<void> {
    if (this.attachBusy() || this.busy()) return;
    this.attachBusy.set(true);
    this.inputError.set(null);
    try {
      const pasted = await this.images.attachmentsFromPasteEvent(event);
      if (pasted.length && this.draftHostId) await this.draftRecovery.recover(`new-session:${this.draftHostId}`, '', pasted);
      if (!this.isCurrentHost()) return;
      if (!pasted.length && event.defaultPrevented) this.inputError.set('The pasted image could not be added. Try another image.');
    } catch (err) {
      if (!this.isCurrentHost()) return;
      this.inputError.set(this.errorMessage(err));
    } finally {
      if (this.isCurrentHost()) this.attachBusy.set(false);
    }
  }

  protected removeAttachment(attachment: MobileAttachmentDto): void {
    this.attachments.update((current) => current.filter((item) => item !== attachment));
  }

  protected async recoverLegacyDraft(): Promise<void> {
    const legacy = this.legacyDraft();
    if (!legacy || !this.draftHostId || this.busy() || !this.isCurrentHost()) return;
    this.firstPrompt.set([this.firstPrompt(), legacy].filter(Boolean).join('\n\n'));
    if (await this.drafts.recoverLegacyNewSession(this.draftHostId, this.draftOwner, this.currentDraft(), legacy)) {
      this.legacyDraft.set('');
    }
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canCreate()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const instance = await this.gateway.createInstance(
        buildCreateInstanceRequest({
          directory: this.selectedDir(),
          provider: this.provider(),
          model: this.model(),
          reasoningEffort: this.reasoningEffort(),
          prompt: this.firstPrompt(),
          attachments: this.attachments(),
        }),
      );
      this.submitted = true;
      await this.drafts.completeNewSession(this.draftHostId, this.draftOwner);
      this.haptics.success();
      if (this.isCurrentHost()) void this.router.navigate(newSessionSuccessRoute(instance.workingDirectory, instance.id));
    } catch (err) {
      this.error.set(this.errorMessage(err));
      this.haptics.error();
    } finally {
      this.busy.set(false);
    }
  }

  protected openHosts(): void {
    void this.router.navigate(['/']);
  }

  protected cancel(): void {
    void this.router.navigate(['/projects']);
  }

  private async resolvePlan(
    provider: string,
    model: string | undefined,
    reasoningEffort: MobileReasoningEffort | undefined,
  ): Promise<void> {
    const request = ++this.planReq;
    this.planLoading.set(true);
    this.planError.set(null);
    this.plan.set(null);
    try {
      const plan = await this.gateway.sessionPlan(provider, model, reasoningEffort);
      if (request === this.planReq && this.isCurrentHost()) this.plan.set(plan);
    } catch (err) {
      if (request === this.planReq) {
        this.plan.set(null);
        this.planError.set(this.errorMessage(err));
      }
    } finally {
      if (request === this.planReq) this.planLoading.set(false);
    }
  }

  private isCurrentHost(): boolean {
    return !this.destroyed.destroyed && (this.hostStore.activeHost()?.id ?? '') === this.draftHostId;
  }

  private persistDraftOnExit(): void {
    if (this.draftReady()) { this.persistDraft(); return; }
    const initial = this.initialDraft;
    if (!initial || !this.draftHostId || this.submitted) return;
    const early = this.currentDraft();
    // Memory-only images need no storage read: retain removals before a successor opens.
    this.drafts.saveAttachments(`new-session:${this.draftHostId}`, this.attachments(), this.draftOwner);
    if (JSON.stringify(early) === JSON.stringify(initial)) return;
    void this.draftRecovery.recover(`new-session:${this.draftHostId}`, early.text, [],
      (saved) => mergeEarlyNewSessionDraft(saved, early, initial));
  }

  private persistDraft(): void {
    if (!this.draftReady() || this.submitted) return;
    this.drafts.saveNewSession(this.draftHostId, this.currentDraft(), this.draftOwner);
    if (this.draftHostId) this.drafts.saveAttachments(`new-session:${this.draftHostId}`, this.attachments(), this.draftOwner);
  }

  private currentDraft() {
    return {
      text: this.firstPrompt(), directory: this.selectedDir(), provider: this.provider(),
      model: this.model(), reasoningEffort: this.reasoningEffort(),
    };
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
