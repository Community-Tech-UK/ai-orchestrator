import {
  ChangeDetectionStrategy,
  Component,
  computed,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { WakeHint } from '../../../../shared/types/wake-context.types';
import { summarizeWakeHints } from '../../../../shared/types/wake-hint-summary';
import { KnowledgeStore } from '../../core/state/knowledge.store';
import { UndoService } from '../../core/services/undo.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';

@Component({
  selector: 'app-wake-management',
  standalone: true,
  imports: [CommonModule, FormsModule, AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wake-mgmt">
      <!-- Identity Editor -->
      <div class="panel-card">
        <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
          <span tabindex="0" [appTooltip]="copyFor('memory.identity')">About this project</span>
          <button class="btn btn-sm" type="button" [appTooltip]="copyFor(editingIdentity() ? 'memory.cancel' : 'memory.editIdentity')" (click)="editingIdentity.set(!editingIdentity())">
            {{ editingIdentity() ? 'Cancel' : 'Edit' }}
          </button>
        </div>

        @if (editingIdentity()) {
          <div class="identity-editor">
            <textarea
              class="input textarea"
              [(ngModel)]="identityDraft"
              [appTooltip]="copyFor('memory.identity')" aria-label="About this project"
              placeholder="Describe this project (max 500 chars)"
              maxlength="500"
              rows="3"
            ></textarea>
            <div class="form-footer">
              <span class="muted">{{ identityDraft().length }}/500</span>
              <button class="btn primary" type="button"
                [appTooltip]="copyFor('memory.saveIdentity')"
                [disabled]="store.loading()" [appTooltipDisabledReason]="!identityDraft().trim() ? 'Enter the identity text first' : null"
                (click)="saveIdentity()">
                Save description
              </button>
            </div>
          </div>
        } @else {
          @if (store.wakeIdentity(); as identity) {
            <pre class="wake-text">{{ identity }}</pre>
          } @else {
            <div class="hint">No project description yet. Click "Edit" to add one.</div>
          }
        }
      </div>

      <!-- Wing-Filtered Regeneration -->
      <div class="panel-card">
        <div class="panel-title">Rebuild starting notes</div>
        <div class="regen-row">
          <label class="field field-wide">
            <span class="label">Project (optional)</span>
            <input class="input" type="text" [(ngModel)]="wakeWing" placeholder="e.g. my_project" aria-label="Project override"
              [appTooltip]="copyFor('memory.project')" />
          </label>
          <button class="btn primary" type="button"
            [appTooltip]="copyFor('memory.rebuild')" [disabled]="store.loading() || !rebuildProject()"
            (click)="regenerate()">
            Rebuild starting notes
          </button>
        </div>
        @if (!rebuildProject()) { <div class="hint" role="status">Pick a project first.</div> }

        @if (store.wakeContext(); as ctx) {
          <div class="stat-row"><span>Tokens</span><span class="num">~{{ ctx.totalTokens }}</span></div>
          @if (ctx.wing) {
            <div class="stat-row"><span>Project</span><span>{{ ctx.wing }}</span></div>
          }
          <details class="wake-details">
            <summary [appTooltip]="copyFor('memory.identity')">About this project</summary>
            <pre class="wake-text">{{ ctx.identity.content }}</pre>
          </details>
          <details class="wake-details">
            <summary [appTooltip]="copyFor('memory.background')">Key background</summary>
            <pre class="wake-text">{{ backgroundPreview(ctx.essentialStory.content) }}</pre>
          </details>
        }
      </div>

      <!-- Hints Management -->
      <div class="panel-card">
        <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
          <span tabindex="0" [appTooltip]="copyFor('memory.projectNotes')">Project notes ({{ store.hintCount() }})</span>
          <button class="btn btn-sm" type="button" [appTooltip]="copyFor(showAddHint() ? 'memory.cancel' : 'memory.addNote')" (click)="showAddHint.set(!showAddHint())">
            {{ showAddHint() ? 'Cancel' : '+ Add note' }}
          </button>
        </div>
        <p class="hint">Removing a note deletes it. Undo is available for five seconds.</p>

        @if (showAddHint()) {
          <div class="inline-form">
            <label class="field">
              <span class="label">Content</span>
              <textarea class="input textarea" [(ngModel)]="newHintContent" rows="2" [appTooltip]="copyFor('memory.content')" aria-label="Note content"
                placeholder="Describe a fact, pattern, or guideline..."></textarea>
            </label>
            <div class="form-row">
              <label class="field">
                <span class="label">Priority (0-10)</span>
                <input class="input" type="number" [(ngModel)]="newHintImportance"
                  [appTooltip]="copyFor('memory.priority')" aria-label="Priority"
                  min="0" max="10" step="1" placeholder="5" />
              </label>
              <label class="field">
                <span class="label">Topic</span>
                <input class="input" type="text" [(ngModel)]="newHintRoom"
                  [appTooltip]="copyFor('memory.topic')" aria-label="Topic"
                  placeholder="e.g. architecture, security" />
              </label>
              <div class="field" style="justify-content: flex-end;">
                <button class="btn primary" type="button"
                  [appTooltip]="copyFor('memory.addNote')"
                  [disabled]="store.loading()" [appTooltipDisabledReason]="!newHintContent().trim() ? 'Enter the note text first' : null"
                  (click)="addHint()">
                  Add
                </button>
              </div>
            </div>
          </div>
        }

        <p class="muted">{{ store.hintCount() }} notes, {{ hintSummary().different }} different,
          {{ hintSummary().shownThisWeek }} shown this week</p>
        <div class="hint-meta" role="group" aria-label="Wake note visibility">
          <button class="btn btn-sm" type="button" [attr.aria-pressed]="!showHidden()"
            [appTooltip]="copyFor('memory.notes')" (click)="showHidden.set(false)">Notes ({{ hintSummary().visible.length }})</button>
          <button class="btn btn-sm" type="button" [attr.aria-pressed]="showHidden()"
            [appTooltip]="copyFor('memory.hidden')" (click)="showHidden.set(true)">Hidden ({{ hintSummary().hidden.length }})</button>
        </div>
        @if (showHidden()) {
          <p class="muted">Legacy notes last shown before 4 May 2026, and duplicate copies.</p>
        }
        @if (pendingRemoval(); as note) {
          <div class="inline-form" role="alertdialog" aria-labelledby="remove-wake-note-title">
            <strong id="remove-wake-note-title">Remove this note?</strong>
            <p class="hint-content">{{ note.content }}</p>
            <p class="muted">Removes 1 note ({{ note.content.length }} characters). The miner will remember the removal.</p>
            <div class="hint-meta">
              <button class="btn btn-sm" type="button" (click)="pendingRemoval.set(null)">Cancel</button>
              <button class="btn btn-sm btn-danger" type="button" [disabled]="store.loading()"
                (click)="removeHint(note.id)">Remove note</button>
            </div>
          </div>
        }
        @if (displayedHints().length > 0) {
          <ul class="hint-list">
            @for (hint of displayedHints(); track hint.id) {
              <li class="hint-item">
                <div class="hint-main">
                  <span class="hint-content">{{ hint.content }}</span>
                  <div class="hint-meta">
                    <span class="badge">{{ hint.room }}</span>
                    <span class="muted" tabindex="0" [appTooltip]="copyFor('memory.priority')">priority {{ hint.importance }}</span>
                    <span class="muted" tabindex="0" [appTooltip]="copyFor('memory.shown')">Shown {{ hint.usageCount }} {{ hint.usageCount === 1 ? 'time' : 'times' }}</span>
                  </div>
                  <div class="hint-meta muted">Added {{ hint.createdAt | date:'mediumDate' }} ·
                    <span tabindex="0" [appTooltip]="hint.sourceReflectionId ? copyFor('memory.reflection') : null">
                      {{ hint.sourceReflectionId ? 'from a lesson' : hint.sourceSessionId ? 'from a past session' : 'added by you' }}
                    </span>
                  </div>
                  @if (hint.lastUsed) { <div class="muted">Last shown {{ hint.lastUsed | date:'mediumDate' }}</div> }
                </div>
                <button class="btn btn-sm btn-danger" type="button"
                  [appTooltip]="copyFor('memory.removeNote')"
                  (click)="pendingRemoval.set(hint)">
                  Remove note
                </button>
              </li>
            }
          </ul>
        } @else {
          <div class="hint">No notes yet. Add a short fact to include in starting notes.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .wake-mgmt {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .panel-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: var(--spacing-sm);
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 0;
      font-size: 12px;
    }

    .num {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }

    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-sm {
      padding: 2px 6px;
      font-size: 10px;
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #f87171;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .field-wide {
      flex: 1;
    }

    .label {
      font-size: 11px;
      color: var(--text-muted);
    }

    .input {
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .textarea {
      resize: vertical;
      font-family: inherit;
      min-height: 40px;
    }

    .inline-form {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      border: 1px dashed var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }

    .form-row {
      display: flex;
      gap: var(--spacing-sm);
      align-items: end;
    }

    .form-row .field {
      flex: 1;
    }

    .form-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .identity-editor {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .regen-row {
      display: flex;
      gap: var(--spacing-sm);
      align-items: end;
      margin-bottom: var(--spacing-sm);
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .muted {
      color: var(--text-muted);
      font-size: 11px;
    }

    .wake-details {
      margin-top: var(--spacing-xs);
    }

    .wake-details summary {
      font-size: 12px;
      cursor: pointer;
      color: var(--primary-color);
    }

    .wake-text {
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
      padding: var(--spacing-sm);
      background: var(--bg-primary);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      margin-top: var(--spacing-xs);
    }

    .hint-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .hint-item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) 0;
      border-bottom: 1px solid var(--border-color);
    }

    .hint-item:last-child {
      border-bottom: none;
    }

    .hint-main {
      flex: 1;
      min-width: 0;
    }

    .hint-content {
      font-size: 12px;
      display: block;
      word-break: break-word;
    }

    .hint-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      margin-top: 2px;
    }

    .badge {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--bg-tertiary);
      color: var(--text-muted);
    }
  `],
})
export class WakeManagementComponent implements OnInit {
  protected store = inject(KnowledgeStore);
  private readonly undo = inject(UndoService);
  protected readonly copyFor = copyFor;

  protected editingIdentity = signal(false);
  protected identityDraft = signal('');
  protected wakeWing = signal('');
  protected readonly rebuildProject = computed(() => this.wakeWing().trim() || this.store.selectedProjectKey().trim());

  protected pendingRemoval = signal<WakeHint | null>(null);
  protected showHidden = signal(false);
  protected hintSummary = computed(() => summarizeWakeHints(this.store.wakeHints()));
  protected displayedHints = computed(() => this.showHidden() ? this.hintSummary().hidden : this.hintSummary().visible);
  protected showAddHint = signal(false);
  protected newHintContent = signal('');
  protected newHintImportance = signal(5);
  protected newHintRoom = signal('');

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.store.loadIdentity(),
      this.store.listHints(),
      this.store.loadWakeContext(),
    ]);
    this.identityDraft.set(this.store.wakeIdentity());
  }

  async saveIdentity(): Promise<void> {
    const text = this.identityDraft().trim();
    if (!text) return;
    const ok = await this.store.setIdentity(text);
    if (ok) {
      this.editingIdentity.set(false);
    }
  }

  protected backgroundPreview(content: string): string {
    // Translate only the builder's own leading heading, retaining note text.
    return content.replace(/^## L1 — ESSENTIAL STORY(?=\r?\n|$)/, 'Key background');
  }

  async regenerate(): Promise<void> {
    const wing = this.rebuildProject();
    if (!wing || this.store.loading()) return;
    await this.store.loadWakeContext(wing);
  }

  async addHint(): Promise<void> {
    const content = this.newHintContent().trim();
    if (!content) return;
    const importance = this.newHintImportance();
    const room = this.newHintRoom().trim() || undefined;
    const ok = await this.store.addHint(content, importance, room);
    if (ok) {
      this.newHintContent.set('');
      this.newHintImportance.set(5);
      this.newHintRoom.set('');
      this.showAddHint.set(false);
    }
  }

  async removeHint(id: string): Promise<void> {
    const note = this.store.wakeHints().find((hint) => hint.id === id);
    if (!note || !await this.store.removeHint(id)) return;
    this.pendingRemoval.set(null);
    this.undo.register({
      kind: `project-note:${id}`, message: `Removed note ‘${note.content.slice(0, 40)}’`,
      undo: () => this.store.addHint(note.content, note.importance, note.room),
    });
  }
}
