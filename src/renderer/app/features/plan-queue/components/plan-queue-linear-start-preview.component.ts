import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DEFAULT_PLAN_QUEUE_ROUTING, type PlanQueueLinearPreview, type PlanQueueLinearPreviewRow, type PlanQueueLinearPreviewText } from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { upgradePlanQueueRouting } from '../../../../../shared/utils/plan-queue-routing-upgrade';
import { pluralise } from '../../../../../shared/utils/plan-queue-item-display';
import { presentError } from '../../../../../shared/present-error';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
import {
  allowedForTicked,
  linearCommentTime,
  linearPriorityWord,
  providersNotAllowed,
  providersOfRun,
  teamsOfTicked,
} from './plan-queue-linear-start-rules';

/** One ticket's text while the page holds it. It is kept here only and never written anywhere. */
type TextState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly text: PlanQueueLinearPreviewText }
  | { readonly kind: 'failed'; readonly message: string };

/** The main process's own words for a refused call; the raw text is kept out of the shared presenter's headline. */
const failureText = (error: unknown): string => presentError(error).rawDetail;

const LIST_CLEARED ='The list was loaded again, so your ticks were cleared.';

/**
 * The Start preview for Linear tickets: the folder's Todo tickets in the order the main process returned them, each
 * with a tick box, its priority, its assignee and why it cannot be ticked. Opening a ticket (and ticking it, which
 * opens it) loads its description and comments, so a ticked ticket has always been shown. Start sends only the
 * session, the preview id and the ticked ids; the main process takes the text from the preview it holds.
 *
 * Everything from Linear that other people wrote (titles, names, descriptions, comments) is shown as plain text by
 * interpolation: no `innerHTML`, no markdown, no image and no link made from the text.
 */
@Component({
  selector: 'app-plan-queue-linear-start-preview',
  standalone: true,
  imports: [AioTooltipDirective],
  templateUrl: './plan-queue-linear-start-preview.component.html',
  styleUrl: './plan-queue-linear-start-preview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueLinearStartPreviewComponent {
  private readonly ipc = inject(PlanQueueIpcService);
  private readonly settingsStore = inject(SettingsStore);
  /** Bumped by every load, so a slow older answer cannot replace a newer list. */
  private loadVersion = 0;

  readonly parentInstanceId = input.required<string>();
  /** The starting session's folder: the one whose linked Linear projects are listed. */
  readonly folder = input.required<string>();
  /** The starting session's provider, used when the run names no worker provider of its own. */
  readonly startingProvider = input<string | null>(null);
  readonly openLinearSetup = output<void>();

  protected readonly pluralise = pluralise;
  protected readonly priorityWord = linearPriorityWord;
  protected readonly commentTime = linearCommentTime;

  protected readonly loading = signal(false);
  protected readonly preview = signal<PlanQueueLinearPreview | null>(null);
  /** Harness's words for why there is no list, set when the load failed. */
  protected readonly unavailable = signal<string | null>(null);
  protected readonly ticked = signal<ReadonlySet<string>>(new Set());
  protected readonly opened = signal<ReadonlySet<string>>(new Set());
  protected readonly texts = signal<ReadonlyMap<string, TextState>>(new Map());
  protected readonly note = signal<string | null>(null);
  protected readonly starting = signal(false);
  protected readonly startError = signal<string | null>(null);
  protected readonly startResult = signal<string | null>(null);

  /** One sentence per linked project whose team is not ready; set only when none is, so there is no list. */
  protected readonly teamProblems = computed<string[]>(() => {
    const projects = this.preview()?.projects ?? [];
    if (projects.length === 0 || projects.some((project) => project.ready)) return [];
    return projects.map((project) => `${project.teamKey}: ${project.reasons.join(' ') || 'This team is not ready.'}`);
  });
  protected readonly rows = computed(() => (this.teamProblems().length > 0 ? [] : this.preview()?.rows ?? []));
  protected readonly tickedRows = computed(() => this.rows().filter((row) => this.ticked().has(row.id)));
  protected readonly allowed = computed(() => {
    const preview = this.preview();
    return preview ? allowedForTicked(preview, this.tickedRows()) : [];
  });
  protected readonly allowedText = computed(() => this.allowed().map((provider) => provider.label).join(', ') || 'none');
  /** The run's providers that the ticked tickets' teams do not allow, named; empty when all are allowed. */
  protected readonly notAllowed = computed(() => {
    const preview = this.preview();
    if (!preview || this.tickedRows().length === 0) return [];
    const routing = upgradePlanQueueRouting(this.settingsStore.settings().planQueueRouting ?? DEFAULT_PLAN_QUEUE_ROUTING);
    return providersNotAllowed(providersOfRun(routing, this.startingProvider()), this.allowed());
  });
  /** The sentence naming the run's providers the ticked tickets' teams do not allow, or null when all are allowed. */
  protected readonly providerNote = computed<string | null>(() => {
    const refused = this.notAllowed();
    const preview = this.preview();
    if (refused.length === 0 || !preview) return null;
    const teams = teamsOfTicked(preview, this.tickedRows()).map((team) => team.teamKey).join(', ');
    return `${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} not allowed to see tickets from ${teams}. Allow ${refused.length === 1 ? 'it' : 'them'} under Linear in Setup, or change the run's providers.`;
  });
  /**
   * Why Start cannot be pressed now, in fixed words, or null when it can. Each test sits in an `if` condition and the
   * sentences are plain strings, so the hint check (`npm run check:ui-hints`) can read every reason Start may give.
   */
  protected readonly startBlock = computed<string | null>(() => {
    if (this.starting()) return 'Starting the run…';
    if (this.tickedRows().length === 0) return 'Tick at least one ticket.';
    if (this.tickedRows().some((row) => this.texts().get(row.id)?.kind === 'failed')) return 'A ticked ticket could not be read. Open it to try again, or untick it.';
    if (this.tickedRows().some((row) => this.texts().get(row.id)?.kind !== 'loaded')) return 'Waiting for the ticked tickets to load.';
    if (this.providerNote() !== null) return 'A provider in this run is not allowed to see these tickets.';
    return null;
  });

  constructor() {
    effect(() => {
      this.folder();
      untracked(() => void this.load());
    });
  }

  /** Loads the list again. A new list clears the ticks, and says so when there were some. */
  protected async load(): Promise<void> {
    const version = ++this.loadVersion;
    const hadTicks = this.ticked().size > 0;
    this.loading.set(true);
    this.startError.set(null);
    this.startResult.set(null);
    try {
      const response = await this.ipc.linearPreviewLoad(this.folder());
      if (version !== this.loadVersion) return;
      if (!response.success || !response.data) {
        this.clearList();
        this.unavailable.set(failureText(response.error) || 'Linear tickets could not be loaded.');
        return;
      }
      const preview = response.data;
      this.unavailable.set(null);
      this.preview.set(preview);
      this.opened.set(new Set());
      this.texts.set(new Map());
      const preTicked = preview.rows.filter((row) => row.ticked && row.canTick);
      this.ticked.set(new Set(preTicked.map((row) => row.id)));
      this.note.set(hadTicks ? LIST_CLEARED : null);
      // Ticked tickets are opened for James one after another, so none is ticked without being shown.
      for (const row of preTicked) {
        if (version !== this.loadVersion) return;
        await this.showText(row, preview.previewId);
      }
    } finally {
      if (version === this.loadVersion) this.loading.set(false);
    }
  }

  private clearList(): void {
    this.preview.set(null);
    this.ticked.set(new Set());
    this.opened.set(new Set());
    this.texts.set(new Map());
    this.note.set(null);
  }

  protected isTicked(row: PlanQueueLinearPreviewRow): boolean {
    return this.ticked().has(row.id);
  }

  protected isOpen(row: PlanQueueLinearPreviewRow): boolean {
    return this.opened().has(row.id);
  }

  protected textOf(row: PlanQueueLinearPreviewRow): TextState | undefined {
    return this.texts().get(row.id);
  }

  /** A box that cannot be ticked stays unticked, whichever way the change arrives (mouse, keyboard or script). */
  protected onTick(row: PlanQueueLinearPreviewRow, event: Event): void {
    const box = event.target as HTMLInputElement;
    if (!row.canTick) {
      box.checked = false;
      return;
    }
    this.startResult.set(null);
    this.ticked.update((current) => {
      const next = new Set(current);
      if (box.checked) next.add(row.id); else next.delete(row.id);
      return next;
    });
    if (box.checked) void this.showText(row);
  }

  protected onToggleOpen(row: PlanQueueLinearPreviewRow): void {
    if (this.isOpen(row)) {
      this.opened.update((current) => { const next = new Set(current); next.delete(row.id); return next; });
      return;
    }
    void this.showText(row);
  }

  /** Opens a ticket and loads its text if it has not been loaded; a failed read is tried again. */
  private async showText(row: PlanQueueLinearPreviewRow, previewId = this.preview()?.previewId): Promise<void> {
    if (!previewId) return;
    this.opened.update((current) => new Set(current).add(row.id));
    const state = this.texts().get(row.id);
    if (state?.kind === 'loaded' || state?.kind === 'loading') return;
    this.setText(row.id, { kind: 'loading' });
    const response = await this.ipc.linearPreviewText(previewId, row.id);
    if (this.preview()?.previewId !== previewId) return;
    this.setText(row.id, response.success && response.data
      ? { kind: 'loaded', text: response.data }
      : { kind: 'failed', message: failureText(response.error) || 'This ticket could not be read.' });
  }

  private setText(id: string, state: TextState): void {
    this.texts.update((current) => new Map(current).set(id, state));
  }

  protected async onStart(): Promise<void> {
    const preview = this.preview();
    if (!preview || this.startBlock() !== null) return;
    this.starting.set(true);
    this.startError.set(null);
    const linearIds = this.tickedRows().map((row) => row.id);
    try {
      const response = await this.ipc.linearStart({ parentInstanceId: this.parentInstanceId(), previewId: preview.previewId, linearIds });
      if (!response.success || !response.data) {
        // The main process's own words, and the ticks stay.
        this.startError.set(failureText(response.error) || 'The run could not be started.');
        return;
      }
      const left = response.data.excluded;
      const started = linearIds.length - left.length;
      this.startResult.set(`Started a run with ${pluralise(started, 'ticket')}.${left.length > 0 ? ` Already in a run: ${left.join(', ')}.` : ''}`);
      // The main process drops the preview once a run is written from it, so the list is out of date.
      this.clearList();
    } finally {
      this.starting.set(false);
    }
  }
}
