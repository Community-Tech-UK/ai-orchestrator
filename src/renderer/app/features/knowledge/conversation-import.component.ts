import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KnowledgeStore } from '../../core/state/knowledge.store';

interface ImportResult {
  segmentsCreated: number;
  filesProcessed: number;
  formatDetected: string;
  errors: string[];
  duration: number;
}

@Component({
  selector: 'app-conversation-import',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="import-panel">
      <div class="panel-card">
        <div class="panel-title">Import Conversation</div>

        <div class="mode-toggle">
          <button class="toggle-btn" type="button" [class.active]="mode() === 'text'" (click)="mode.set('text')">
            Paste Text
          </button>
          <button class="toggle-btn" type="button" [class.active]="mode() === 'file'" (click)="mode.set('file')">
            File Path
          </button>
        </div>

        <label class="field">
          <span class="label">Wing (project namespace)</span>
          <input class="input" type="text" [(ngModel)]="wing" placeholder="e.g. my_project" />
        </label>

        @if (mode() === 'text') {
          <label class="field">
            <span class="label">Source Name</span>
            <input class="input" type="text" [(ngModel)]="sourceName" placeholder="e.g. planning-session.txt" />
          </label>

          <label class="field">
            <span class="label">Conversation Content</span>
            <textarea
              class="input textarea"
              [(ngModel)]="textContent"
              rows="8"
              placeholder="Paste conversation here...
> Question 1
Answer 1

> Question 2
Answer 2"
              (input)="onTextChange()"
            ></textarea>
          </label>

          @if (detectedFormat()) {
            <div class="format-badge">
              Detected format: <strong>{{ detectedFormat() }}</strong>
            </div>
          }

          <label class="field">
            <span class="label">Format (optional override)</span>
            <select class="input" [(ngModel)]="formatOverride">
              <option value="">Auto-detect</option>
              <option value="plain-text">Plain Text (Q&A)</option>
              <option value="claude-code-jsonl">Claude Code JSONL</option>
              <option value="codex-jsonl">Codex JSONL</option>
              <option value="claude-ai-json">Claude.ai JSON</option>
              <option value="chatgpt-json">ChatGPT JSON</option>
              <option value="slack-json">Slack JSON</option>
            </select>
          </label>

          <button
            class="btn primary"
            type="button"
            [disabled]="!textContent().trim() || !wing().trim() || !sourceName().trim() || store.loading()"
            (click)="importText()"
          >
            Import Text
          </button>
        } @else {
          <label class="field">
            <span class="label">File Path (absolute)</span>
            <input class="input" type="text" [(ngModel)]="filePath" placeholder="/path/to/conversation.jsonl" />
          </label>

          <button
            class="btn primary"
            type="button"
            [disabled]="!filePath().trim() || !wing().trim() || store.loading()"
            (click)="importFile()"
          >
            Import File
          </button>
        }

        @if (store.loading()) {
          <div class="hint">Importing...</div>
        }

        @if (lastResult(); as result) {
          <div class="result-card">
            <div class="panel-title">Import Result</div>
            <div class="stat-row"><span>Segments</span><span class="num">{{ result.segmentsCreated }}</span></div>
            <div class="stat-row"><span>Files</span><span class="num">{{ result.filesProcessed }}</span></div>
            <div class="stat-row"><span>Format</span><span>{{ result.formatDetected }}</span></div>
            <div class="stat-row"><span>Duration</span><span>{{ result.duration }}ms</span></div>
            @if (result.errors.length > 0) {
              <div class="error-list">
                @for (err of result.errors; track $index) {
                  <div class="error-line">{{ err }}</div>
                }
              </div>
            }
          </div>
        }
      </div>

      @if (store.importEvents().length > 0) {
        <div class="panel-card">
          <div class="panel-title">Recent Imports</div>
          <ul class="list compact">
            @for (event of store.importEvents(); track $index) {
              <li>
                <span class="mono small">{{ event.sourceFile }}</span>
                <span class="muted">{{ event.segmentsCreated }} segments ({{ event.format }})</span>
              </li>
            }
          </ul>
        </div>
      }
    </div>
  `,
  styles: [`
    .import-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 13px;
      font-weight: 600;
    }

    .mode-toggle {
      display: flex;
      gap: 0;
      border-radius: var(--radius-sm);
      overflow: hidden;
      border: 1px solid var(--border-color);
      width: fit-content;
    }

    .toggle-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      font-size: 12px;
      border: none;
      background: var(--bg-primary);
      color: var(--text-muted);
      cursor: pointer;
    }

    .toggle-btn.active {
      background: var(--primary-color);
      color: #fff;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
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
      font-family: var(--font-mono, monospace);
      min-height: 120px;
    }

    select.input {
      appearance: auto;
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
      align-self: flex-start;
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

    .format-badge {
      font-size: 11px;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      background: rgba(74, 222, 128, 0.1);
      border: 1px solid rgba(74, 222, 128, 0.2);
      color: #4ade80;
      width: fit-content;
    }

    .result-card {
      padding: var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      display: flex;
      flex-direction: column;
      gap: 2px;
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

    .hint {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .muted {
      color: var(--text-muted);
      font-size: 11px;
    }

    .mono {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
    }

    .small {
      font-size: 10px;
      word-break: break-all;
    }

    .error-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .error-line {
      font-size: 11px;
      color: #f87171;
    }

    .list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .list li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
      padding: 4px 0;
      font-size: 12px;
      border-bottom: 1px solid var(--border-color);
    }

    .list.compact li {
      padding: 2px 0;
      font-size: 11px;
    }
  `],
})
export class ConversationImportComponent implements OnDestroy {
  protected store = inject(KnowledgeStore);

  protected mode = signal<'text' | 'file'>('text');
  protected wing = signal('');
  protected sourceName = signal('');
  protected textContent = signal('');
  protected formatOverride = signal('');
  protected filePath = signal('');
  protected detectedFormat = signal('');
  protected lastResult = signal<ImportResult | null>(null);

  private detectTimeout: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void {
    if (this.detectTimeout) {
      clearTimeout(this.detectTimeout);
    }
  }

  onTextChange(): void {
    const content = this.textContent().trim();
    if (content.length < 20) {
      this.detectedFormat.set('');
      if (this.detectTimeout) {
        clearTimeout(this.detectTimeout);
        this.detectTimeout = null;
      }
      return;
    }

    if (this.detectTimeout) {
      clearTimeout(this.detectTimeout);
    }
    this.detectTimeout = setTimeout(async () => {
      const format = await this.store.detectFormat(content);
      this.detectedFormat.set(format ?? '');
    }, 500);
  }

  async importText(): Promise<void> {
    const content = this.textContent().trim();
    const wingValue = this.wing().trim();
    const sourceFile = this.sourceName().trim();
    if (!content || !wingValue || !sourceFile) {
      return;
    }

    const result = await this.store.importConversationString(
      content,
      wingValue,
      sourceFile,
      this.formatOverride() || undefined,
    );
    if (result) {
      this.lastResult.set(result);
      this.textContent.set('');
      this.detectedFormat.set('');
    }
  }

  async importFile(): Promise<void> {
    const path = this.filePath().trim();
    const wingValue = this.wing().trim();
    if (!path || !wingValue) {
      return;
    }

    const result = await this.store.importConversationFile(path, wingValue);
    if (result) {
      this.lastResult.set(result);
      this.filePath.set('');
    }
  }
}
