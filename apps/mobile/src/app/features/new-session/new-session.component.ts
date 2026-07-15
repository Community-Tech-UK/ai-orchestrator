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
import { DraftStore } from '../../core/draft-store';
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
  shouldPresentDirectorySheet,
} from './new-session.presentation';

const PROVIDERS = ['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor', 'grok'] as const;
const DRAFT_KEY = 'new-session';

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
  template: `
    <section class="new-session-screen">
      <app-mobile-header title="New session">
        <button
          mobileHeaderLeading
          class="mobile-icon-button"
          type="button"
          (click)="cancel()"
          aria-label="Back to projects"
        >
          <app-mobile-icon name="chevron-left" />
        </button>
        <span mobileHeaderTrailing aria-hidden="true"></span>
      </app-mobile-header>

      <div class="session-spacer" aria-hidden="true"></div>

      <div class="session-context" aria-label="Session context">
        <button class="context-row mobile-pressable" type="button" (click)="openHosts()">
          <app-mobile-icon name="host" />
          <span class="context-row__copy">
            <span>{{ hostName() }}</span>
            <small>{{ online() ? 'Connected host' : 'Host unavailable' }}</small>
          </span>
          <app-mobile-icon class="context-row__chevron" name="chevron-down" />
        </button>

        <button
          class="context-row mobile-pressable"
          type="button"
          (click)="directorySheetOpen.set(true)"
          aria-haspopup="dialog"
        >
          <app-mobile-icon name="folder" />
          <span class="context-row__copy">
            <span>{{ selectedDirLabel() }}</span>
            <small>{{ selectedDir() || 'Choose where this session should run' }}</small>
          </span>
          <app-mobile-icon class="context-row__chevron" name="chevron-down" />
        </button>

        <button
          class="context-row mobile-pressable"
          type="button"
          (click)="settingsSheetOpen.set(true)"
          aria-haspopup="dialog"
        >
          <app-mobile-icon name="provider" />
          <span class="context-row__copy">
            <span>{{ providerDisplay() }}</span>
            <small>Execution target</small>
          </span>
          <app-mobile-icon class="context-row__chevron" name="chevron-down" />
        </button>

        <button
          class="context-row mobile-pressable"
          type="button"
          (click)="openPlanControl()"
          aria-haspopup="dialog"
        >
          <app-mobile-icon name="settings" />
          <span class="context-row__copy">
            <span>{{ planSummary() }}</span>
            <small>Model and reasoning</small>
          </span>
          <app-mobile-icon class="context-row__chevron" name="chevron-down" />
        </button>
      </div>

      <form class="new-session-composer" (submit)="create($event)">
        @if (attachments().length > 0) {
          <div class="composer-attachments" aria-label="Attachments">
            @for (attachment of attachments(); track attachment) {
              <figure class="composer-attachment">
                <img [src]="attachment.data" [alt]="attachment.name" />
                <button
                  type="button"
                  (click)="removeAttachment(attachment)"
                  [attr.aria-label]="'Remove ' + attachment.name"
                >
                  <app-mobile-icon name="close" />
                </button>
              </figure>
            }
          </div>
        }

        <textarea
          #composer
          rows="2"
          [ngModel]="firstPrompt()"
          (ngModelChange)="firstPrompt.set($event)"
          name="prompt"
          placeholder="Ask Harness"
          aria-label="First message"
          (paste)="onPaste($event)"
        ></textarea>

        @if (error()) {
          <p class="composer-error" role="alert">{{ error() }}</p>
        } @else if (!online()) {
          <p class="composer-hint">Reconnect to a host to start a session.</p>
        }

        <div class="composer-toolbar">
          <div class="composer-toolbar__leading">
            @if (canAttach) {
              <button
                class="composer-tool"
                type="button"
                (click)="attachmentSheetOpen.set(true)"
                [disabled]="attachBusy() || busy()"
                aria-label="Add attachment"
              >
                <app-mobile-icon name="plus" />
              </button>
            }
            <button
              class="composer-tool"
              type="button"
              (click)="settingsSheetOpen.set(true)"
              aria-label="Session settings"
            >
              <app-mobile-icon name="settings" />
            </button>
          </div>

          <button
            class="composer-plan mobile-pressable"
            type="button"
            (click)="openPlanControl()"
            [disabled]="planLoading()"
          >
            {{ compactPlanSummary() }}
          </button>

          @if (canDictate) {
            <button
              class="composer-tool"
              type="button"
              [class.composer-tool--listening]="listening()"
              (click)="toggleDictation()"
              [attr.aria-label]="listening() ? 'Stop dictation' : 'Dictate message'"
            >
              <app-mobile-icon name="microphone" />
            </button>
          }

          <button
            class="composer-submit"
            type="submit"
            [disabled]="!canCreate()"
            [attr.aria-label]="busy() ? 'Starting session' : 'Start session'"
          >
            <app-mobile-icon name="arrow-up" />
          </button>
        </div>
      </form>

      @if (directorySheetOpen()) {
        <app-mobile-sheet label="Working directory" (dismiss)="directorySheetOpen.set(false)">
          <header class="sheet-heading">
            <span class="sheet-eyebrow">Run on {{ hostName() }}</span>
            <h2>Working directory</h2>
            <p>Choose a recent folder from the selected host.</p>
          </header>

          @if (loadingDirs()) {
            <p class="sheet-state">Loading recent directories…</p>
          } @else if (dirsError()) {
            <div class="sheet-state">
              <p>{{ dirsError() }}</p>
              <button class="sheet-secondary" type="button" (click)="loadDirectories()">Try again</button>
            </div>
          } @else {
            <div class="sheet-list">
              @if (presetDir() && !directoryIsRecent()) {
                <button class="sheet-row" type="button" (click)="chooseDirectory(presetDir())">
                  <app-mobile-icon name="folder" />
                  <span><strong>{{ presetDirName() }}</strong><small>{{ presetDir() }}</small></span>
                  @if (selectedDir() === presetDir()) { <app-mobile-icon name="check" /> }
                </button>
              }
              @for (directory of dirs(); track directory.path) {
                <button class="sheet-row" type="button" (click)="chooseDirectory(directory.path)">
                  <app-mobile-icon name="folder" />
                  <span><strong>{{ directory.displayName }}</strong><small>{{ directory.path }}</small></span>
                  @if (selectedDir() === directory.path) { <app-mobile-icon name="check" /> }
                </button>
              } @empty {
                @if (!presetDir()) {
                  <p class="sheet-state">No recent directories. Open a folder on the host, then try again.</p>
                }
              }
            </div>
          }
        </app-mobile-sheet>
      }

      @if (settingsSheetOpen()) {
        <app-mobile-sheet label="Session settings" (dismiss)="settingsSheetOpen.set(false)">
          <header class="sheet-heading">
            <span class="sheet-eyebrow">Harness resolves the final setup</span>
            <h2>Session settings</h2>
            <p>Auto uses the host's preferred provider, model, and reasoning level.</p>
          </header>

          <span class="sheet-section-label">Provider</span>
          <div class="sheet-list">
            @for (item of providers; track item) {
              <button class="sheet-row" type="button" (click)="selectProvider(item)">
                <app-mobile-icon name="provider" />
                <span><strong>{{ displayProvider(item) }}</strong><small>{{ item === 'auto' ? 'Use host settings' : 'Run with ' + displayProvider(item) }}</small></span>
                @if (provider() === item) { <app-mobile-icon name="check" /> }
              </button>
            }
          </div>

          <span class="sheet-section-label">Resolved session</span>
          <div class="sheet-summary">
            @if (planLoading()) {
              <p>Resolving session settings…</p>
            } @else if (planError()) {
              <p>{{ planError() }}</p>
              <button class="sheet-secondary" type="button" (click)="retryPlan()">Try again</button>
            } @else if (plan(); as resolvedPlan) {
              <strong>{{ resolvedPlan.providerLabel }}</strong>
              <span>{{ planSummary() }}</span>
            }
          </div>

          @if (provider() !== 'auto') {
            <button class="sheet-row sheet-row--model" type="button" (click)="openModelSheet()">
              <app-mobile-icon name="settings" />
              <span><strong>Model</strong><small>{{ selectedModelLabel() }}</small></span>
              <app-mobile-icon name="chevron-down" />
            </button>
          }
        </app-mobile-sheet>
      }

      @if (attachmentSheetOpen()) {
        <app-mobile-sheet label="Add attachment" (dismiss)="attachmentSheetOpen.set(false)">
          <header class="sheet-heading">
            <h2>Add attachment</h2>
          </header>
          <div class="sheet-list">
            <button class="sheet-row" type="button" (click)="pickImages()" [disabled]="attachBusy()">
              <app-mobile-icon name="attachment" />
              <span><strong>Photo Library</strong><small>Select up to five images</small></span>
            </button>
            <button class="sheet-row" type="button" (click)="pasteImageFromClipboard()" [disabled]="attachBusy()">
              <app-mobile-icon name="clipboard" />
              <span><strong>Paste image</strong><small>Use an image from the clipboard</small></span>
            </button>
          </div>
        </app-mobile-sheet>
      }

      @if (modelSheetOpen()) {
        <app-model-sheet
          [provider]="provider()"
          [models]="modelsForProvider()"
          [selected]="model()"
          [reasoningOptions]="reasoningOptions()"
          [selectedReasoning]="reasoningEffort()"
          [loading]="modelsLoading()"
          [error]="modelsError()"
          (choose)="chooseModel($event)"
          (chooseReasoning)="chooseReasoningEffort($event)"
          (dismiss)="modelSheetOpen.set(false)"
        />
      }
    </section>
  `,
  styleUrls: ['./new-session.component.scss'],
})
export class NewSessionComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly hostStore = inject(HostStore);
  private readonly images = inject(ImageAttachmentService);
  private readonly drafts = inject(DraftStore);
  private readonly haptics = inject(HapticsService);
  private readonly voice = inject(VoiceInputService);
  private readonly router = inject(Router);
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  readonly dir = input('');

  protected readonly providers = PROVIDERS;
  protected readonly online = this.gateway.online;
  protected readonly dirs = signal<MobileRecentDirDto[]>([]);
  protected readonly loadingDirs = signal(true);
  protected readonly dirsError = signal<string | null>(null);
  protected readonly selectedDir = signal('');
  protected readonly directorySheetOpen = signal(false);
  protected readonly settingsSheetOpen = signal(false);
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
  private draftReady = false;

  protected readonly presetDir = computed(() => {
    const passed = this.dir();
    return passed && passed !== '__no_workspace__' ? passed : '';
  });
  protected readonly presetDirName = computed(() => {
    const path = this.presetDir();
    const recent = this.dirs().find((directory) => directory.path === path);
    if (recent) return recent.displayName;
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  });
  protected readonly directoryIsRecent = computed(() =>
    this.dirs().some((directory) => directory.path === this.presetDir()),
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
      busy: this.busy(),
    }),
  );

  constructor() {
    effect(() => {
      const preset = this.presetDir();
      if (preset && !this.selectedDir()) this.selectedDir.set(preset);
    });

    effect(() => {
      if (this.voice.listening()) this.firstPrompt.set(this.voice.text());
    });

    void this.drafts.load(DRAFT_KEY).then((text) => {
      if (text && !this.firstPrompt().trim()) this.firstPrompt.set(text);
      this.draftReady = true;
    });

    effect(() => {
      const text = this.firstPrompt();
      if (this.draftReady) this.drafts.save(DRAFT_KEY, text);
    });

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
        && !this.settingsSheetOpen()
        && !this.attachmentSheetOpen()
        && !this.modelSheetOpen();
      if (composer && ready) {
        queueMicrotask(() => composer.nativeElement.focus({ preventScroll: true }));
      }
    });

    inject(DestroyRef).onDestroy(() => {
      if (this.voice.listening()) void this.voice.stop();
    });
  }

  async ngOnInit(): Promise<void> {
    if (this.presetDir()) {
      this.selectedDir.set(this.presetDir());
      this.loadingDirs.set(false);
      return;
    }
    await this.loadDirectories();
  }

  protected async loadDirectories(): Promise<void> {
    this.loadingDirs.set(true);
    this.dirsError.set(null);
    try {
      const directories = await this.gateway.recentDirs();
      this.dirs.set(directories);
      if (shouldPresentDirectorySheet(this.presetDir(), directories.map((directory) => directory.path))) {
        this.directorySheetOpen.set(true);
      }
    } catch (err) {
      this.dirsError.set(this.errorMessage(err));
    } finally {
      this.loadingDirs.set(false);
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

  protected retryPlan(): void {
    void this.resolvePlan(this.provider(), this.model(), this.reasoningEffort());
  }

  protected async openPlanControl(): Promise<void> {
    if (this.provider() === 'auto') {
      this.settingsSheetOpen.set(true);
      return;
    }
    await this.openModelSheet();
  }

  protected async openModelSheet(): Promise<void> {
    if (this.provider() === 'auto') return;
    this.settingsSheetOpen.set(false);
    this.modelSheetOpen.set(true);
    if (this.modelCatalog() || this.modelsLoading()) return;
    this.modelsLoading.set(true);
    this.modelsError.set(null);
    try {
      this.modelCatalog.set(await this.gateway.models());
    } catch (err) {
      this.modelsError.set(this.errorMessage(err));
    } finally {
      this.modelsLoading.set(false);
    }
  }

  protected chooseModel(model: string | undefined): void {
    this.model.set(model);
    this.modelSheetOpen.set(false);
    this.haptics.tap();
  }

  protected chooseReasoningEffort(reasoningEffort: MobileReasoningEffort | undefined): void {
    this.reasoningEffort.set(reasoningEffort);
    this.modelSheetOpen.set(false);
    this.haptics.tap();
  }

  protected async toggleDictation(): Promise<void> {
    if (this.voice.listening()) {
      await this.voice.stop();
      this.firstPrompt.set(this.voice.text());
      this.haptics.tap();
      return;
    }
    this.haptics.tap();
    const started = await this.voice.start(this.firstPrompt());
    if (!started) this.haptics.error();
  }

  protected async pickImages(): Promise<void> {
    if (this.attachBusy()) return;
    this.attachBusy.set(true);
    try {
      const picked = await this.images.pickImages();
      if (picked.length) this.attachments.update((current) => [...current, ...picked]);
      this.attachmentSheetOpen.set(false);
    } catch {
      /* A cancelled native picker is not an error state. */
    } finally {
      this.attachBusy.set(false);
    }
  }

  protected async pasteImageFromClipboard(): Promise<void> {
    if (this.attachBusy()) return;
    this.attachBusy.set(true);
    try {
      const pasted = await this.images.pasteImageFromClipboard();
      if (pasted) this.attachments.update((current) => [...current, pasted]);
      this.attachmentSheetOpen.set(false);
    } catch {
      /* Clipboard access can be declined by the user. */
    } finally {
      this.attachBusy.set(false);
    }
  }

  protected async onPaste(event: ClipboardEvent): Promise<void> {
    if (this.attachBusy()) return;
    this.attachBusy.set(true);
    try {
      const pasted = await this.images.attachmentsFromPasteEvent(event);
      if (pasted.length) this.attachments.update((current) => [...current, ...pasted]);
    } catch {
      /* Browser clipboard payloads vary by platform. */
    } finally {
      this.attachBusy.set(false);
    }
  }

  protected removeAttachment(attachment: MobileAttachmentDto): void {
    this.attachments.update((current) => current.filter((item) => item !== attachment));
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
      this.drafts.clear(DRAFT_KEY);
      this.haptics.success();
      void this.router.navigate(newSessionSuccessRoute(instance.workingDirectory, instance.id));
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
    try {
      const plan = await this.gateway.sessionPlan(provider, model, reasoningEffort);
      if (request === this.planReq) this.plan.set(plan);
    } catch (err) {
      if (request === this.planReq) {
        this.plan.set(null);
        this.planError.set(this.errorMessage(err));
      }
    } finally {
      if (request === this.planReq) this.planLoading.set(false);
    }
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
