import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KnowledgeStore } from '../../core/state/knowledge.store';

@Component({
  selector: 'app-wake-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wake-mgmt">
      <!-- Identity Editor -->
      <div class="panel-card">
        <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
          <span>L0 Identity</span>
          <button class="btn btn-sm" type="button" (click)="editingIdentity.set(!editingIdentity())">
            {{ editingIdentity() ? 'Cancel' : 'Edit' }}
          </button>
        </div>

        @if (editingIdentity()) {
          <div class="identity-editor">
            <textarea
              class="input textarea"
              [(ngModel)]="identityDraft"
              placeholder="Describe the project/persona identity (max 500 chars)"
              maxlength="500"
              rows="3"
            ></textarea>
            <div class="form-footer">
              <span class="muted">{{ identityDraft().length }}/500</span>
              <button class="btn primary" type="button"
                [disabled]="!identityDraft().trim() || store.loading()"
                (click)="saveIdentity()">
                Save Identity
              </button>
            </div>
          </div>
        } @else {
          @if (store.wakeIdentity(); as identity) {
            <pre class="wake-text">{{ identity }}</pre>
          } @else {
            <div class="hint">No identity set. Click "Edit" to define one.</div>
          }
        }
      </div>

      <!-- Wing-Filtered Regeneration -->
      <div class="panel-card">
        <div class="panel-title">Regenerate Wake Context</div>
        <div class="regen-row">
          <label class="field field-wide">
            <span class="label">Wing (optional)</span>
            <input class="input" type="text" [(ngModel)]="wakeWing" placeholder="e.g. my_project" />
          </label>
          <button class="btn primary" type="button"
            [disabled]="store.loading()"
            (click)="regenerate()">
            Regenerate
          </button>
        </div>

        @if (store.wakeContext(); as ctx) {
          <div class="stat-row"><span>Tokens</span><span class="num">~{{ ctx.totalTokens }}</span></div>
          @if (ctx.wing) {
            <div class="stat-row"><span>Wing</span><span>{{ ctx.wing }}</span></div>
          }
          <details class="wake-details">
            <summary>L0 Identity</summary>
            <pre class="wake-text">{{ ctx.identity.content }}</pre>
          </details>
          <details class="wake-details">
            <summary>L1 Essential Story</summary>
            <pre class="wake-text">{{ ctx.essentialStory.content }}</pre>
          </details>
        }
      </div>

      <!-- Hints Management -->
      <div class="panel-card">
        <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
          <span>Wake Hints ({{ store.hintCount() }})</span>
          <button class="btn btn-sm" type="button" (click)="showAddHint.set(!showAddHint())">
            {{ showAddHint() ? 'Cancel' : '+ Add Hint' }}
          </button>
        </div>

        @if (showAddHint()) {
          <div class="inline-form">
            <label class="field">
              <span class="label">Content</span>
              <textarea class="input textarea" [(ngModel)]="newHintContent" rows="2"
                placeholder="Describe a fact, pattern, or guideline..."></textarea>
            </label>
            <div class="form-row">
              <label class="field">
                <span class="label">Importance (0-10)</span>
                <input class="input" type="number" [(ngModel)]="newHintImportance"
                  min="0" max="10" step="1" placeholder="5" />
              </label>
              <label class="field">
                <span class="label">Room</span>
                <input class="input" type="text" [(ngModel)]="newHintRoom"
                  placeholder="e.g. architecture, security" />
              </label>
              <div class="field" style="justify-content: flex-end;">
                <button class="btn primary" type="button"
                  [disabled]="!newHintContent().trim() || store.loading()"
                  (click)="addHint()">
                  Add
                </button>
              </div>
            </div>
          </div>
        }

        @if (store.wakeHints().length > 0) {
          <ul class="hint-list">
            @for (hint of store.wakeHints(); track hint.id) {
              <li class="hint-item">
                <div class="hint-main">
                  <span class="hint-content">{{ hint.content }}</span>
                  <div class="hint-meta">
                    <span class="badge">{{ hint.room }}</span>
                    <span class="muted">imp: {{ hint.importance }}</span>
                    <span class="muted">used: {{ hint.usageCount }}x</span>
                  </div>
                </div>
                <button class="btn btn-sm btn-danger" type="button"
                  (click)="removeHint(hint.id)">
                  Remove
                </button>
              </li>
            }
          </ul>
        } @else {
          <div class="hint">No hints yet. Add hints to shape the wake context.</div>
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

  protected editingIdentity = signal(false);
  protected identityDraft = signal('');
  protected wakeWing = signal('');

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

  async regenerate(): Promise<void> {
    const wing = this.wakeWing().trim() || undefined;
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
    await this.store.removeHint(id);
  }
}
