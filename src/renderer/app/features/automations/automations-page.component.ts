import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type {
  Automation,
  AutomationAction,
  AutomationSchedule,
} from '../../../../shared/types/automation.types';
import type { FileAttachment } from '../../../../shared/types/instance.types';
import type { AutomationPreflightReport, AutomationTemplate } from '../../../../shared/types/task-preflight.types';
import {
  getPrimaryModelForProvider,
  type ReasoningEffort,
} from '../../../../shared/types/provider.types';
import { NO_WORKSPACE_KEY } from '../../../../shared/utils/workspace-key';
import { AutomationStore, type AutomationDraft } from '../../core/state/automation.store';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import { AutomationWebhooksPanelComponent } from './automation-webhooks-panel.component';
import {
  emptyForm,
  formToLoopAction,
  formToTrigger,
  fromLocalDateInput,
  toLocalDateInput,
  type AutomationFormModel,
} from './automation-form-model';
import { AutomationIpcService } from '../../core/services/ipc/automation-ipc.service';
import type { WebhookRouteConfig } from '../../../../shared/types/webhook.types';
import { describeSchedule } from './schedule-format';

type OverlayMode = 'detail' | 'form' | 'chat' | null;

/** A project (workspace) bucket of automations for the grouped list view. */
interface AutomationGroup {
  key: string;
  title: string;
  subtitle: string;
  automations: Automation[];
}

@Component({
  selector: 'app-automations-page',
  standalone: true,
  imports: [CommonModule, FormsModule, CompactModelPickerComponent, PageHeaderComponent, AutomationWebhooksPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape()' },
  templateUrl: './automations-page.component.html',
  styleUrl: './automations-page.component.css',
})
export class AutomationsPageComponent {
  private readonly instances = inject(InstanceStore);
  private readonly automationIpc = inject(AutomationIpcService);
  store = inject(AutomationStore);

  /** WS5: webhook routes for the trigger picker (loaded when the form opens). */
  webhookRoutes = signal<WebhookRouteConfig[]>([]);

  selectedId = signal<string | null>(null);
  selectedTemplateId = signal('');
  overlay = signal<OverlayMode>(null);
  menuOpen = signal(false);
  preflightAcknowledged = signal(false);
  form = signal<AutomationFormModel>(emptyForm());
  confirmingDeleteId = signal<string | null>(null);

  // Chat-composer state
  chatText = signal('');
  chatWorkingDir = signal('');
  chatBusy = signal(false);
  chatError = signal<string | null>(null);
  chatDraft = signal<AutomationDraft | null>(null);

  /** Working directory of the currently-active instance/project, if any. */
  currentProjectDir = computed(() => this.instances.selectedInstance()?.workingDirectory ?? '');

  /**
   * Automations bucketed by the project (workspace) they target, so each
   * automation appears under the relevant project rather than in one flat list.
   * Within a group, active automations sort before paused ones; groups sort by
   * title with the "No workspace" bucket last.
   */
  groups = computed<AutomationGroup[]>(() => {
    const buckets = new Map<string, Automation[]>();
    for (const automation of this.store.automations()) {
      const key = automation.workspaceId || NO_WORKSPACE_KEY;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(automation);
      } else {
        buckets.set(key, [automation]);
      }
    }

    const result: AutomationGroup[] = [];
    for (const [key, automations] of buckets) {
      automations.sort((a, b) => {
        const activeDelta = Number(this.isActive(b)) - Number(this.isActive(a));
        return activeDelta !== 0 ? activeDelta : a.name.localeCompare(b.name);
      });
      const dir = automations[0]?.action.workingDirectory ?? '';
      result.push({
        key,
        title: this.projectTitle(dir),
        subtitle: this.projectSubtitle(dir),
        automations,
      });
    }

    result.sort((a, b) => {
      const aNoWs = a.key === NO_WORKSPACE_KEY ? 1 : 0;
      const bNoWs = b.key === NO_WORKSPACE_KEY ? 1 : 0;
      return aNoWs !== bNoWs ? aNoWs - bNoWs : a.title.localeCompare(b.title);
    });
    return result;
  });

  isActive(automation: Automation): boolean {
    return automation.enabled && automation.active;
  }

  selected = computed(() =>
    this.store.automations().find((automation) => automation.id === this.selectedId()) ?? null
  );
  selectedRuns = computed(() =>
    this.store.runs().filter((run) => run.automationId === this.selectedId()).slice(0, 20)
  );

  constructor() {
    void this.store.loadTemplates();
  }

  closeOverlay(): void {
    this.overlay.set(null);
    this.preflightAcknowledged.set(false);
    this.store.clearPreflight();
  }

  onEscape(): void {
    if (this.menuOpen()) {
      this.menuOpen.set(false);
      return;
    }
    if (this.confirmingDeleteId()) {
      this.confirmingDeleteId.set(null);
      return;
    }
    if (this.overlay() !== null) {
      this.closeOverlay();
    }
  }

  // --- Chat composer ---------------------------------------------------------

  startChat(): void {
    this.chatText.set('');
    this.chatError.set(null);
    this.chatDraft.set(null);
    this.chatBusy.set(false);
    this.chatWorkingDir.set(this.defaultWorkingDirectory());
    this.overlay.set('chat');
  }

  canGenerate(): boolean {
    return Boolean(this.chatText().trim()) && !this.chatBusy();
  }

  async generateDraft(): Promise<void> {
    if (!this.canGenerate()) return;
    this.chatBusy.set(true);
    this.chatError.set(null);
    try {
      const outcome = await this.store.draftFromText(this.chatText(), {
        workingDirectory: this.chatWorkingDir().trim() || undefined,
      });
      if (outcome.ok) {
        this.chatDraft.set(outcome.draft);
      } else {
        this.chatDraft.set(null);
        this.chatError.set(outcome.error);
      }
    } finally {
      this.chatBusy.set(false);
    }
  }

  /** Move the parsed draft into the standard form, then auto-run preflight. */
  useDraft(): void {
    const draft = this.chatDraft();
    if (!draft) return;
    this.selectedId.set(null);
    this.selectedTemplateId.set('');
    this.preflightAcknowledged.set(false);
    this.store.clearPreflight();
    this.form.set(this.draftToForm(draft));
    this.overlay.set('form');
    if (this.canRunPreflight()) {
      void this.runPreflightForForm();
    }
  }

  draftScheduleLabel(draft: AutomationDraft): string {
    if (draft.scheduleType === 'oneTime' && draft.runAtIso) {
      const ts = Date.parse(draft.runAtIso);
      if (!Number.isNaN(ts)) {
        return describeSchedule({ type: 'oneTime', runAt: ts, timezone: draft.timezone });
      }
      return 'Once';
    }
    if (draft.cronExpression) {
      return describeSchedule({ type: 'cron', expression: draft.cronExpression, timezone: draft.timezone || 'UTC' });
    }
    return 'Schedule';
  }

  // --- List ------------------------------------------------------------------

  scheduleLabel(automation: Automation): string {
    return describeSchedule(automation.schedule);
  }

  byline(automation: Automation): string {
    if (automation.description?.trim()) {
      return automation.description.trim();
    }
    const wd = automation.action.workingDirectory;
    if (wd) {
      return wd.split('/').filter(Boolean).pop() ?? wd;
    }
    return '';
  }

  /** Short project name for a group header (last path segment). */
  projectTitle(workingDirectory: string): string {
    const normalized = workingDirectory.trim();
    if (!normalized) {
      return 'No workspace';
    }
    const parts = normalized.split(/[/\\]/).filter(Boolean);
    return parts.at(-1) ?? normalized;
  }

  /** Full project path for a group header, with the home dir collapsed to ~. */
  projectSubtitle(workingDirectory: string): string {
    const normalized = workingDirectory.trim();
    if (!normalized) {
      return 'Automations without a working directory';
    }
    return normalized
      .replace(/^\/Users\/[^/]+/, '~')
      .replace(/^\/home\/[^/]+/, '~');
  }

  select(automation: Automation): void {
    this.selectedId.set(automation.id);
    this.overlay.set('detail');
    if ((automation.unreadRunCount ?? 0) > 0) {
      void this.store.markSeen(automation.id);
    }
  }

  /** Per-automation in-flight state for the inline "run now" play button. */
  private readonly runningIds = signal<ReadonlySet<string>>(new Set());
  private readonly togglingIds = signal<ReadonlySet<string>>(new Set());
  private readonly deletingIds = signal<ReadonlySet<string>>(new Set());

  isRunning(automation: Automation): boolean {
    return this.runningIds().has(automation.id);
  }

  isToggling(automation: Automation): boolean {
    return this.togglingIds().has(automation.id);
  }

  isDeleting(automation: Automation): boolean {
    return this.deletingIds().has(automation.id);
  }

  isConfirmingDelete(automation: Automation): boolean {
    return this.confirmingDeleteId() === automation.id;
  }

  /** Pause or resume a scheduled automation without opening the edit form. */
  async togglePaused(automation: Automation): Promise<void> {
    if (this.togglingIds().has(automation.id)) return;
    this.confirmingDeleteId.set(null);
    this.togglingIds.update((ids) => new Set(ids).add(automation.id));
    try {
      const updates: { enabled: boolean; active?: boolean } = this.isActive(automation)
        ? { enabled: false }
        : { enabled: true };
      if (!automation.active) {
        updates.active = true;
      }
      await this.store.update(automation.id, updates);
    } finally {
      this.togglingIds.update((ids) => {
        const next = new Set(ids);
        next.delete(automation.id);
        return next;
      });
    }
  }

  requestDelete(automation: Automation): void {
    this.confirmingDeleteId.set(automation.id);
  }

  cancelDelete(): void {
    this.confirmingDeleteId.set(null);
  }

  async confirmDelete(automation: Automation): Promise<void> {
    if (this.deletingIds().has(automation.id)) return;
    this.deletingIds.update((ids) => new Set(ids).add(automation.id));
    try {
      await this.store.delete(automation.id);
      if (this.selectedId() === automation.id) {
        this.selectedId.set(null);
        this.closeOverlay();
      }
      this.confirmingDeleteId.set(null);
    } finally {
      this.deletingIds.update((ids) => {
        const next = new Set(ids);
        next.delete(automation.id);
        return next;
      });
    }
  }

  /** Trigger an immediate manual run of the automation from the list row. */
  async runNow(automation: Automation): Promise<void> {
    if (this.runningIds().has(automation.id)) return;
    this.confirmingDeleteId.set(null);
    this.runningIds.update((ids) => new Set(ids).add(automation.id));
    try {
      await this.store.runNow(automation.id);
    } finally {
      this.runningIds.update((ids) => {
        const next = new Set(ids);
        next.delete(automation.id);
        return next;
      });
    }
  }

  // --- Create / edit ---------------------------------------------------------

  startCreate(): void {
    this.selectedId.set(null);
    this.selectedTemplateId.set('');
    this.preflightAcknowledged.set(false);
    this.store.clearPreflight();
    this.form.set({ ...emptyForm(), workingDirectory: this.defaultWorkingDirectory() });
    this.overlay.set('form');
    void this.loadWebhookRoutes();
  }

  editSelected(): void {
    const automation = this.selected();
    if (!automation) return;
    this.selectedTemplateId.set('');
    this.preflightAcknowledged.set(false);
    this.store.clearPreflight();
    this.form.set(this.toForm(automation));
    this.overlay.set('form');
    void this.loadWebhookRoutes();
  }

  /** WS5: routes for the trigger picker; failure keeps the picker empty. */
  async loadWebhookRoutes(): Promise<void> {
    const response = await this.automationIpc.webhookListRoutes();
    if (response.success) {
      this.webhookRoutes.set(response.data ?? []);
    }
  }

  addWebhookFilter(): void {
    this.patchForm({
      webhookFilters: [...this.form().webhookFilters, { path: '', operator: 'equals', value: '' }],
    });
  }

  updateWebhookFilter(index: number, patch: Partial<AutomationFormModel['webhookFilters'][number]>): void {
    const filters = this.form().webhookFilters.map((filter, i) => (i === index ? { ...filter, ...patch } : filter));
    this.patchForm({ webhookFilters: filters });
  }

  removeWebhookFilter(index: number): void {
    this.patchForm({ webhookFilters: this.form().webhookFilters.filter((_, i) => i !== index) });
  }

  patchForm(patch: Partial<AutomationFormModel>): void {
    this.form.update((current) => ({ ...current, ...patch }));
    this.preflightAcknowledged.set(false);
    this.store.clearPreflight();
  }

  // --- Model picker ----------------------------------------------------------

  /** Same concrete provider set offered by the main-session model picker. */
  readonly modelPickerProviders = computed<PickerProvider[]>(() => [
    'claude',
    'codex',
    'gemini',
    'antigravity',
    'copilot',
    'cursor',
    'grok',
  ]);

  /**
   * Current picker selection derived from the form. The picker is only rendered
   * for a pinned provider; Claude is a defensive fallback while the form is in
   * automatic mode.
   */
  readonly modelPickerSelection = computed<PendingSelection>(() => {
    const model = this.form();
    return {
      provider: model.provider && model.provider !== 'auto'
        ? model.provider as PickerProvider
        : 'claude',
      model: model.model || null,
      reasoning: (model.reasoningEffort || null) as ReasoningEffort | null,
    };
  });

  useAutomaticModelSelection(): void {
    this.patchForm({ provider: 'auto', model: '', reasoningEffort: '' });
  }

  pinModelSelection(): void {
    if (this.form().provider === 'auto') {
      this.patchForm({
        provider: 'claude',
        model: getPrimaryModelForProvider('claude') ?? '',
        reasoningEffort: '',
      });
    }
  }

  /**
   * The inline model picker committed a selection. Always adopt the model; only
   * adopt reasoning when the user explicitly chose a tier (non-null) so a plain
   * model pick — which the picker reports with `reasoning: null` — preserves any
   * existing effort rather than silently clearing it.
   */
  onModelPicked(selection: PendingSelection): void {
    // Local runtimes require a node/runtime target that automation actions do
    // not currently persist, and are intentionally absent from providers.
    if (selection.provider === 'local-model') return;
    const current = this.form();
    const patch: Partial<AutomationFormModel> = {
      provider: selection.provider,
      model: selection.model ?? '',
    };
    if (selection.reasoning !== null) {
      patch.reasoningEffort = selection.reasoning as AutomationFormModel['reasoningEffort'];
    } else if (selection.provider !== current.provider) {
      patch.reasoningEffort = '';
    }
    this.patchForm(patch);
  }

  async save(): Promise<void> {
    const model = this.form();
    const report = await this.runPreflightForForm();
    if (!report?.okToSave) {
      return;
    }

    const schedule = this.toSchedule(model);
    const action: AutomationAction = {
      prompt: model.prompt,
      workingDirectory: model.workingDirectory,
      provider: model.provider,
      model: model.model || undefined,
      agentId: model.agentId || undefined,
      yoloMode: model.yoloMode,
      reasoningEffort: model.reasoningEffort || undefined,
      forceNodeId: model.forceNodeId || undefined,
      attachments: model.attachments,
      loop: formToLoopAction(model),
    };
    const trigger = formToTrigger(model);

    const ok = model.id
      ? await this.store.update(model.id, {
          name: model.name,
          description: model.description || undefined,
          enabled: model.enabled,
          schedule,
          trigger,
          missedRunPolicy: model.missedRunPolicy,
          concurrencyPolicy: model.concurrencyPolicy,
          action,
        })
      : await this.store.create({
          name: model.name,
          description: model.description || undefined,
          enabled: model.enabled,
          schedule,
          trigger,
          missedRunPolicy: model.missedRunPolicy,
          concurrencyPolicy: model.concurrencyPolicy,
          action,
        });

    if (ok) {
      this.closeOverlay();
    }
  }

  canSave(): boolean {
    const model = this.form();
    // WS5: a webhook trigger needs a route; a loop action needs its verify
    // authority (the WS6 policy would refuse the run at dispatch anyway).
    if (model.triggerKind === 'webhook' && !model.webhookRouteId.trim()) return false;
    if (model.loopEnabled && !model.loopVerifyCommand.trim()) return false;
    return Boolean(model.name.trim() && model.workingDirectory.trim() && model.prompt.trim() && !this.store.preflightLoading());
  }

  canRunPreflight(): boolean {
    const model = this.form();
    return Boolean(model.workingDirectory.trim() && model.prompt.trim() && !this.store.preflightLoading());
  }

  applySelectedTemplate(): void {
    const template = this.store.applyTemplate(this.selectedTemplateId());
    if (!template) {
      return;
    }
    this.applyTemplate(template);
  }

  async runPreflight(): Promise<void> {
    await this.runPreflightForForm();
  }

  acknowledgePreflight(): void {
    this.preflightAcknowledged.set(true);
  }

  applyPromptEdit(replacementPrompt: string): void {
    this.patchForm({ prompt: replacementPrompt });
  }

  preflightLabel(report: AutomationPreflightReport): string {
    if (!report.okToSave) {
      return 'Preflight blocked';
    }
    if (report.warnings.length > 0) {
      return this.preflightAcknowledged() ? 'Preflight acknowledged' : 'Preflight warnings';
    }
    return 'Preflight ready';
  }

  deleteSelected(): void {
    const automation = this.selected();
    if (!automation) return;
    void this.store.delete(automation.id);
    this.selectedId.set(null);
    this.confirmingDeleteId.set(null);
    this.closeOverlay();
  }

  onFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    Promise.all(files.map((file) => this.readAttachment(file))).then((attachments) => {
      this.form.update((current) => ({ ...current, attachments }));
    });
  }

  formCronLabel(): string {
    const model = this.form();
    if (model.scheduleType !== 'cron') return '';
    return describeSchedule({ type: 'cron', expression: model.cronExpression, timezone: model.timezone || 'UTC' });
  }

  formatTime(timestamp: number | null): string {
    return timestamp ? new Date(timestamp).toLocaleString() : 'None';
  }

  /**
   * Default working directory for a newly-created automation: the currently
   * active project if one is open, otherwise the most common workspace across
   * existing automations.
   */
  private defaultWorkingDirectory(): string {
    const current = this.currentProjectDir().trim();
    return current || this.suggestWorkingDirectory();
  }

  private suggestWorkingDirectory(): string {
    // Prefer the most common working directory across existing automations so a
    // chat-created automation lands in a familiar workspace by default.
    const counts = new Map<string, number>();
    for (const automation of this.store.automations()) {
      const wd = automation.action.workingDirectory?.trim();
      if (wd) {
        counts.set(wd, (counts.get(wd) ?? 0) + 1);
      }
    }
    let best = '';
    let bestCount = 0;
    for (const [wd, count] of counts) {
      if (count > bestCount) {
        best = wd;
        bestCount = count;
      }
    }
    return best;
  }

  private draftToForm(draft: AutomationDraft): AutomationFormModel {
    const base = emptyForm();
    const oneTimeTs = draft.runAtIso ? Date.parse(draft.runAtIso) : NaN;
    return {
      ...base,
      name: draft.name,
      description: draft.description ?? '',
      workingDirectory: this.chatWorkingDir().trim(),
      scheduleType: draft.scheduleType,
      cronExpression: draft.scheduleType === 'cron' && draft.cronExpression ? draft.cronExpression : base.cronExpression,
      timezone: draft.timezone || base.timezone,
      runAtLocal: draft.scheduleType === 'oneTime' && !Number.isNaN(oneTimeTs)
        ? toLocalDateInput(oneTimeTs)
        : base.runAtLocal,
      prompt: draft.prompt,
      provider: (draft.provider ?? 'auto') as AutomationFormModel['provider'],
    };
  }

  private async runPreflightForForm(): Promise<AutomationPreflightReport | null> {
    const model = this.form();
    if (!model.workingDirectory.trim() || !model.prompt.trim()) {
      return null;
    }
    const report = await this.store.runPreflight({
      workingDirectory: model.workingDirectory,
      prompt: model.prompt,
      provider: model.provider === 'auto' ? undefined : model.provider,
      model: model.model || undefined,
      yoloMode: model.yoloMode,
      expectedUnattended: true,
    });
    if (report && report.warnings.length === 0) {
      this.preflightAcknowledged.set(true);
    }
    return report;
  }

  private applyTemplate(template: AutomationTemplate): void {
    this.form.update((current) => ({
      ...current,
      name: current.name || template.name,
      description: current.description || template.description,
      scheduleType: template.suggestedSchedule.type,
      cronExpression: template.suggestedSchedule.expression,
      timezone: current.timezone || template.suggestedSchedule.timezone,
      prompt: template.prompt,
    }));
    this.preflightAcknowledged.set(false);
    this.store.clearPreflight();
  }

  private toForm(automation: Automation): AutomationFormModel {
    return {
      id: automation.id,
      name: automation.name,
      description: automation.description ?? '',
      enabled: automation.enabled,
      scheduleType: automation.schedule.type,
      cronExpression: automation.schedule.type === 'cron' ? automation.schedule.expression : '0 9 * * *',
      timezone: automation.schedule.type === 'cron'
        ? automation.schedule.timezone
        : automation.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      runAtLocal: automation.schedule.type === 'oneTime' ? toLocalDateInput(automation.schedule.runAt) : toLocalDateInput(Date.now() + 60 * 60 * 1000),
      missedRunPolicy: automation.missedRunPolicy,
      concurrencyPolicy: automation.concurrencyPolicy,
      prompt: automation.action.prompt,
      workingDirectory: automation.action.workingDirectory,
      provider: automation.action.provider ?? 'auto',
      model: automation.action.model ?? '',
      agentId: automation.action.agentId ?? 'build',
      yoloMode: automation.action.yoloMode ?? false,
      reasoningEffort: automation.action.reasoningEffort ?? '',
      forceNodeId: automation.action.forceNodeId ?? '',
      attachments: automation.action.attachments ?? [],
      triggerKind: automation.trigger?.kind === 'webhook' ? 'webhook' : 'schedule',
      webhookRouteId: automation.trigger?.kind === 'webhook' ? automation.trigger.routeId : '',
      webhookFilters: automation.trigger?.kind === 'webhook' ? [...automation.trigger.filters] : [],
      loopEnabled: Boolean(automation.action.loop),
      loopVerifyCommand: automation.action.loop?.verifyCommand ?? '',
      loopIsolateWorkspace: automation.action.loop?.isolateWorkspace ?? true,
      loopMaxIterations: automation.action.loop?.maxIterations != null ? String(automation.action.loop.maxIterations) : '',
      loopMaxCostCents: automation.action.loop?.maxCostCents != null ? String(automation.action.loop.maxCostCents) : '',
    };
  }

  private toSchedule(model: AutomationFormModel): AutomationSchedule {
    if (model.scheduleType === 'oneTime') {
      return {
        type: 'oneTime',
        runAt: fromLocalDateInput(model.runAtLocal),
        timezone: model.timezone || undefined,
      };
    }

    return {
      type: 'cron',
      expression: model.cronExpression,
      timezone: model.timezone || 'UTC',
    };
  }

  private readAttachment(file: File): Promise<FileAttachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        resolve({
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          data: String(reader.result),
        });
      };
      reader.readAsDataURL(file);
    });
  }
}
