import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type {
  Automation,
  AutomationAction,
  AutomationConcurrencyPolicy,
  AutomationMissedRunPolicy,
  AutomationSchedule,
} from '../../../../shared/types/automation.types';
import type { FileAttachment } from '../../../../shared/types/instance.types';
import { AutomationStore } from '../../core/state/automation.store';

interface AutomationFormModel {
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  scheduleType: 'cron' | 'oneTime';
  cronExpression: string;
  timezone: string;
  runAtLocal: string;
  missedRunPolicy: AutomationMissedRunPolicy;
  concurrencyPolicy: AutomationConcurrencyPolicy;
  prompt: string;
  workingDirectory: string;
  provider: AutomationAction['provider'];
  model: string;
  agentId: string;
  yoloMode: boolean;
  reasoningEffort: AutomationAction['reasoningEffort'] | '';
  forceNodeId: string;
  attachments: FileAttachment[];
}

function emptyForm(): AutomationFormModel {
  return {
    name: '',
    description: '',
    enabled: true,
    scheduleType: 'cron',
    cronExpression: '0 9 * * *',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    runAtLocal: toLocalDateInput(Date.now() + 60 * 60 * 1000),
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    prompt: '',
    workingDirectory: '',
    provider: 'auto',
    model: '',
    agentId: 'build',
    yoloMode: false,
    reasoningEffort: '',
    forceNodeId: '',
    attachments: [],
  };
}

function toLocalDateInput(timestamp: number): string {
  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromLocalDateInput(value: string): number {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

@Component({
  selector: 'app-automations-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="toolbar">
        <div class="toolbar-title">
          <button class="btn" type="button" (click)="goBack()">← Back</button>
          <div>
            <h1>Automations</h1>
            <span class="muted">{{ store.automations().length }} schedules</span>
          </div>
        </div>
        <div class="toolbar-actions">
          <button class="btn" type="button" (click)="store.refresh()">Refresh</button>
          <button class="btn btn--primary" type="button" (click)="startCreate()">New</button>
        </div>
      </header>

      @if (store.error()) {
        <div class="error">{{ store.error() }}</div>
      }

      <main class="layout">
        <section class="list" aria-label="Automations">
          @if (store.loading()) {
            <div class="empty">Loading...</div>
          } @else if (store.automations().length === 0) {
            <div class="empty">No automations configured.</div>
          } @else {
            @for (automation of store.automations(); track automation.id) {
              <button
                type="button"
                class="automation-row"
                [class.selected]="selectedId() === automation.id"
                (click)="select(automation)"
              >
                <span class="row-main">
                  <span class="row-title">{{ automation.name }}</span>
                  <span class="row-subtitle">{{ scheduleLabel(automation) }}</span>
                </span>
                <span class="row-meta">
                  @if ((automation.unreadRunCount ?? 0) > 0) {
                    <span class="badge">{{ automation.unreadRunCount }}</span>
                  }
                  <span class="pill" [class.off]="!automation.enabled || !automation.active">
                    {{ automation.enabled && automation.active ? 'on' : 'off' }}
                  </span>
                </span>
              </button>
            }
          }
        </section>

        <section class="detail" aria-label="Automation detail">
          @if (editing()) {
            <form class="form" (ngSubmit)="save()">
              <div class="form-grid">
                <label>
                  <span>Name</span>
                  <input name="name" [ngModel]="form().name" (ngModelChange)="patchForm({ name: $event })" required />
                </label>
                <label>
                  <span>Working Directory</span>
                  <input name="workingDirectory" [ngModel]="form().workingDirectory" (ngModelChange)="patchForm({ workingDirectory: $event })" required />
                </label>
              </div>

              <label>
                <span>Description</span>
                <input name="description" [ngModel]="form().description" (ngModelChange)="patchForm({ description: $event })" />
              </label>

              <div class="form-grid">
                <label>
                  <span>Schedule</span>
                  <select name="scheduleType" [ngModel]="form().scheduleType" (ngModelChange)="patchForm({ scheduleType: $event })">
                    <option value="cron">Cron</option>
                    <option value="oneTime">One time</option>
                  </select>
                </label>
                <label>
                  <span>Timezone</span>
                  <input name="timezone" [ngModel]="form().timezone" (ngModelChange)="patchForm({ timezone: $event })" />
                </label>
              </div>

              @if (form().scheduleType === 'cron') {
                <label>
                  <span>Cron Expression</span>
                  <input name="cronExpression" [ngModel]="form().cronExpression" (ngModelChange)="patchForm({ cronExpression: $event })" required />
                </label>
              } @else {
                <label>
                  <span>Run At</span>
                  <input name="runAtLocal" type="datetime-local" [ngModel]="form().runAtLocal" (ngModelChange)="patchForm({ runAtLocal: $event })" required />
                </label>
              }

              <div class="form-grid">
                <label>
                  <span>Missed Runs</span>
                  <select name="missedRunPolicy" [ngModel]="form().missedRunPolicy" (ngModelChange)="patchForm({ missedRunPolicy: $event })">
                    <option value="skip">Skip</option>
                    <option value="notify">Notify</option>
                    <option value="runOnce">Run once</option>
                  </select>
                </label>
                <label>
                  <span>Concurrency</span>
                  <select name="concurrencyPolicy" [ngModel]="form().concurrencyPolicy" (ngModelChange)="patchForm({ concurrencyPolicy: $event })">
                    <option value="skip">Skip</option>
                    <option value="queue">Queue</option>
                  </select>
                </label>
              </div>

              <label>
                <span>Prompt</span>
                <textarea name="prompt" rows="8" [ngModel]="form().prompt" (ngModelChange)="patchForm({ prompt: $event })" required></textarea>
              </label>

              <div class="form-grid">
                <label>
                  <span>Provider</span>
                  <select name="provider" [ngModel]="form().provider" (ngModelChange)="patchForm({ provider: $event })">
                    <option value="auto">Auto</option>
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                    <option value="gemini">Gemini</option>
                    <option value="copilot">Copilot</option>
                    <option value="cursor">Cursor</option>
                  </select>
                </label>
                <label>
                  <span>Model</span>
                  <input name="model" [ngModel]="form().model" (ngModelChange)="patchForm({ model: $event })" />
                </label>
                <label>
                  <span>Agent</span>
                  <input name="agentId" [ngModel]="form().agentId" (ngModelChange)="patchForm({ agentId: $event })" />
                </label>
                <label>
                  <span>Reasoning</span>
                  <select name="reasoningEffort" [ngModel]="form().reasoningEffort" (ngModelChange)="patchForm({ reasoningEffort: $event })">
                    <option value="">Default</option>
                    <option value="none">None</option>
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">XHigh</option>
                  </select>
                </label>
              </div>

              <div class="form-grid form-grid--compact">
                <label class="checkbox">
                  <input name="enabled" type="checkbox" [ngModel]="form().enabled" (ngModelChange)="patchForm({ enabled: $event })" />
                  <span>Enabled</span>
                </label>
                <label class="checkbox">
                  <input name="yoloMode" type="checkbox" [ngModel]="form().yoloMode" (ngModelChange)="patchForm({ yoloMode: $event })" />
                  <span>YOLO</span>
                </label>
              </div>

              <label>
                <span>Attachments</span>
                <input type="file" multiple (change)="onFiles($event)" />
              </label>

              @if (form().attachments.length > 0) {
                <div class="attachments">
                  @for (attachment of form().attachments; track attachment.name + attachment.size) {
                    <span>{{ attachment.name }}</span>
                  }
                </div>
              }

              <div class="actions">
                <button class="btn btn--primary" type="submit" [disabled]="!canSave()">Save</button>
                <button class="btn" type="button" (click)="cancelEdit()">Cancel</button>
              </div>
            </form>
          } @else if (selected()) {
            <div class="summary">
              <div class="summary-header">
                <div>
                  <h2>{{ selected()!.name }}</h2>
                  <span class="muted">{{ selected()!.description || 'No description' }}</span>
                </div>
                <div class="actions">
                  <button class="btn" type="button" (click)="editSelected()">Edit</button>
                  <button class="btn" type="button" (click)="store.runNow(selected()!.id)">Run</button>
                  <button class="btn" type="button" (click)="store.cancelPending(selected()!.id)">Cancel Pending</button>
                  <button class="btn btn--danger" type="button" (click)="deleteSelected()">Delete</button>
                </div>
              </div>

              <div class="stats">
                <div><span>Next</span><strong>{{ formatTime(selected()!.nextFireAt) }}</strong></div>
                <div><span>Last Scheduled</span><strong>{{ formatTime(selected()!.lastFiredAt) }}</strong></div>
                <div><span>Policy</span><strong>{{ selected()!.missedRunPolicy }}</strong></div>
                <div><span>Concurrency</span><strong>{{ selected()!.concurrencyPolicy }}</strong></div>
              </div>

              <pre class="prompt">{{ selected()!.action.prompt }}</pre>

              <h3>Recent Runs</h3>
              <div class="runs">
                @for (run of selectedRuns(); track run.id) {
                  <div class="run-row" [class]="'run-row run-row--' + run.status">
                    <span>{{ run.status }}</span>
                    <span>{{ run.trigger }}</span>
                    <span>{{ formatTime(run.scheduledAt) }}</span>
                    <span class="run-error">{{ run.error || run.outputSummary || '' }}</span>
                  </div>
                } @empty {
                  <div class="empty">No runs yet.</div>
                }
              </div>
            </div>
          } @else {
            <div class="empty">Select an automation or create a new one.</div>
          }
        </section>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }
    .page { display: flex; flex-direction: column; height: 100%; padding: 16px; gap: 12px; color: var(--text-primary); background: var(--bg-primary); }
    .toolbar, .summary-header, .actions, .toolbar-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .toolbar-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 20px; }
    h2 { font-size: 18px; }
    h3 { font-size: 14px; margin-top: 16px; }
    .muted { color: var(--text-muted); font-size: 12px; }
    .layout { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); gap: 12px; }
    .list, .detail { min-height: 0; overflow: auto; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); }
    .list { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .detail { padding: 14px; }
    .automation-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 10px; text-align: left; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; }
    .automation-row:hover, .automation-row.selected { background: var(--bg-tertiary); border-color: var(--border-color); }
    .row-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .row-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-subtitle { color: var(--text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-meta { display: flex; align-items: center; gap: 6px; }
    .pill, .badge { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 20px; padding: 0 6px; border-radius: 999px; font-size: 11px; background: var(--success-color); color: #fff; }
    .pill.off { background: var(--text-muted); }
    .badge { background: var(--warning-color); }
    .form, .summary { display: flex; flex-direction: column; gap: 12px; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .form-grid--compact { grid-template-columns: repeat(4, max-content); }
    label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-muted); }
    .checkbox { flex-direction: row; align-items: center; color: var(--text-primary); }
    input, select, textarea { width: 100%; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); padding: 8px; font: inherit; font-size: 12px; }
    textarea { resize: vertical; min-height: 140px; }
    .btn { border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-tertiary); color: var(--text-primary); padding: 7px 10px; cursor: pointer; font-size: 12px; }
    .btn--primary { background: var(--primary-color); border-color: var(--primary-color); color: #fff; }
    .btn--danger { color: var(--error-color); }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .error { border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent); color: var(--error-color); border-radius: 6px; padding: 8px 10px; font-size: 12px; }
    .empty { color: var(--text-muted); padding: 18px; text-align: center; font-size: 12px; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .stats div { border: 1px solid var(--border-color); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 4px; }
    .stats span { color: var(--text-muted); font-size: 11px; }
    .stats strong { font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .prompt { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--border-color); border-radius: 6px; padding: 10px; max-height: 240px; overflow: auto; background: var(--bg-primary); font-size: 12px; }
    .runs { display: flex; flex-direction: column; gap: 6px; }
    .run-row { display: grid; grid-template-columns: 90px 80px 180px minmax(0, 1fr); gap: 8px; align-items: center; padding: 8px; border-radius: 6px; border: 1px solid var(--border-color); font-size: 12px; }
    .run-row--failed { border-color: color-mix(in srgb, var(--error-color) 45%, var(--border-color)); }
    .run-row--succeeded { border-color: color-mix(in srgb, var(--success-color) 45%, var(--border-color)); }
    .run-error { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachments { display: flex; flex-wrap: wrap; gap: 6px; }
    .attachments span { border: 1px solid var(--border-color); border-radius: 999px; padding: 3px 8px; font-size: 11px; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .stats, .form-grid { grid-template-columns: 1fr; } .run-row { grid-template-columns: 1fr; } }
  `],
})
export class AutomationsPageComponent {
  private readonly router = inject(Router);
  store = inject(AutomationStore);
  selectedId = signal<string | null>(null);
  editing = signal(false);
  form = signal<AutomationFormModel>(emptyForm());

  selected = computed(() =>
    this.store.automations().find((automation) => automation.id === this.selectedId()) ?? null
  );
  selectedRuns = computed(() =>
    this.store.runs().filter((run) => run.automationId === this.selectedId()).slice(0, 20)
  );

  startCreate(): void {
    this.selectedId.set(null);
    this.form.set(emptyForm());
    this.editing.set(true);
  }

  goBack(): void {
    void this.router.navigate(['/']);
  }

  patchForm(patch: Partial<AutomationFormModel>): void {
    this.form.update((current) => ({ ...current, ...patch }));
  }

  select(automation: Automation): void {
    this.selectedId.set(automation.id);
    this.editing.set(false);
    if ((automation.unreadRunCount ?? 0) > 0) {
      void this.store.markSeen(automation.id);
    }
  }

  editSelected(): void {
    const automation = this.selected();
    if (!automation) return;
    this.form.set(this.toForm(automation));
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
  }

  async save(): Promise<void> {
    const model = this.form();
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
    };

    const ok = model.id
      ? await this.store.update(model.id, {
          name: model.name,
          description: model.description || undefined,
          enabled: model.enabled,
          schedule,
          missedRunPolicy: model.missedRunPolicy,
          concurrencyPolicy: model.concurrencyPolicy,
          action,
        })
      : await this.store.create({
          name: model.name,
          description: model.description || undefined,
          enabled: model.enabled,
          schedule,
          missedRunPolicy: model.missedRunPolicy,
          concurrencyPolicy: model.concurrencyPolicy,
          action,
        });

    if (ok) {
      this.editing.set(false);
    }
  }

  canSave(): boolean {
    const model = this.form();
    return Boolean(model.name.trim() && model.workingDirectory.trim() && model.prompt.trim());
  }

  deleteSelected(): void {
    const automation = this.selected();
    if (!automation) return;
    void this.store.delete(automation.id);
    this.selectedId.set(null);
  }

  onFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    Promise.all(files.map((file) => this.readAttachment(file))).then((attachments) => {
      this.form.update((current) => ({ ...current, attachments }));
    });
  }

  scheduleLabel(automation: Automation): string {
    if (automation.schedule.type === 'cron') {
      return `${automation.schedule.expression} (${automation.schedule.timezone})`;
    }
    return `once at ${this.formatTime(automation.schedule.runAt)}`;
  }

  formatTime(timestamp: number | null): string {
    return timestamp ? new Date(timestamp).toLocaleString() : 'None';
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
