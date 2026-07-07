import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { HapticsService } from '../../core/haptics.service';
import type { MobilePromptDto } from '../../core/models';
import { diffLines, type DiffRow } from '../../shared/line-diff';

export type ApprovalScope = 'once' | 'session' | 'always';
export interface ApprovalDecision {
  action: 'allow' | 'deny';
  scope: ApprovalScope;
  response?: string;
}

interface FileDiffView {
  filePath: string;
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
}

/**
 * Bottom-sheet for the highest-value action: answering an agent's approval
 * prompt. Permission prompts get Allow/Deny + a scope segmented control; user
 * actions can now be answered directly from the phone instead of only deep-linking
 * into the session.
 */
@Component({
  standalone: true,
  selector: 'app-approval-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="scrim" aria-label="Dismiss" (click)="dismiss.emit()"></button>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="grabber"></div>

      @if (prompt().kind === 'permission') {
        <h2 class="title">{{ prompt().toolName ? prompt().toolName + ' needs approval' : 'Approve action?' }}</h2>
        @if (fileDiff(); as d) {
          <div class="diff-head">
            <span class="diff-path">{{ d.filePath }}</span>
            <span class="diff-stat">
              @if (d.added) { <span class="plus">+{{ d.added }}</span> }
              @if (d.removed) { <span class="minus">−{{ d.removed }}</span> }
            </span>
          </div>
          <div class="diff">
            @for (row of d.rows; track $index) {
              <div class="diff-row" [class]="'d-' + row.kind">{{ rowPrefix(row) }}{{ row.text }}</div>
            }
            @if (d.truncated) {
              <div class="diff-row d-skip">⋯ diff truncated — open the session for the full change</div>
            }
          </div>
        } @else if (commandText()) {
          <pre class="cmd">{{ commandText() }}</pre>
        } @else if (prompt().message) {
          <p class="msg">{{ prompt().message }}</p>
        }

        <div class="scope">
          @for (s of scopes; track s) {
            <button class="seg" [class.active]="scope() === s" (click)="scope.set(s)">{{ s }}</button>
          }
        </div>

        <div class="actions">
          <button class="deny" (click)="decide('deny')">Deny</button>
          <button class="allow" (click)="decide('allow')">Allow</button>
        </div>
      } @else {
        <h2 class="title">{{ prompt().title }}</h2>
        <p class="msg">{{ prompt().message }}</p>
        <button type="button" class="secondary-link" (click)="open.emit()">Open session</button>

        @if (prompt().requestType === 'select_option' && prompt().options?.length) {
          <div class="option-list">
            @for (option of prompt().options; track option.id) {
              <button type="button" class="option-button" (click)="submitOption(option.id)">
                <span class="option-label">{{ option.label }}</span>
                @if (option.description) {
                  <span class="option-description">{{ option.description }}</span>
                }
              </button>
            }
          </div>
          <div class="actions">
            <button class="deny" (click)="dismiss.emit()">Later</button>
          </div>
        } @else if (prompt().requestType === 'ask_questions' && prompt().questions?.length) {
          <div class="question-list">
            @for (question of prompt().questions; track $index) {
              <label class="question">
                <span class="question-title">{{ question }}</span>
                <textarea
                  class="question-input"
                  rows="3"
                  [value]="answerFor($index)"
                  (input)="updateAnswer($index, $event)"
                ></textarea>
              </label>
            }
          </div>
          <div class="actions">
            <button class="deny" (click)="dismiss.emit()">Later</button>
            <button class="allow" [disabled]="!canSubmitAnswers()" (click)="submitAnswers()">
              Send answers
            </button>
          </div>
        } @else {
          @if (prompt().options?.length) {
            <ul class="options">
              @for (option of prompt().options; track option.id) {
                <li>{{ option.label }}</li>
              }
            </ul>
          }
          <div class="actions">
            <button class="deny" (click)="decide('deny')">Deny</button>
            <button class="allow" (click)="decide('allow')">Allow</button>
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      :host { position: fixed; inset: 0; z-index: 50; display: block; }
      .scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); border: none; padding: 0; cursor: default; }
      .sheet {
        position: absolute; left: 0; right: 0; bottom: 0;
        background: var(--surface-2, #1c1c1e);
        border-radius: 20px 20px 0 0; padding: 8px 20px calc(20px + env(safe-area-inset-bottom));
        box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.5);
        animation: slideUp 0.18s ease-out;
      }
      @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
      .grabber { width: 36px; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.25); margin: 6px auto 14px; }
      .title { font-size: 20px; font-weight: 700; margin: 0 0 12px; }
      .cmd {
        background: var(--bg, #000); color: var(--text, #fff); border-radius: 10px; padding: 12px;
        font-family: 'SF Mono', ui-monospace, Menlo, monospace; font-size: 13px;
        white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; margin: 0 0 16px;
      }
      .diff-head {
        display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
        margin: 0 0 6px;
      }
      .diff-path {
        font-family: 'SF Mono', ui-monospace, Menlo, monospace; font-size: 12px;
        color: var(--text-secondary, #8e8e93);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
      }
      .diff-stat { font-size: 12px; font-weight: 700; flex: none; display: flex; gap: 6px; }
      .diff-stat .plus { color: var(--accent-online, #34c759); }
      .diff-stat .minus { color: var(--accent-error, #ff453a); }
      .diff {
        background: var(--bg, #000); border-radius: 10px; padding: 8px 0;
        max-height: 240px; overflow: auto; margin: 0 0 16px;
        -webkit-overflow-scrolling: touch;
      }
      .diff-row {
        font-family: 'SF Mono', ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.5;
        padding: 0 12px; white-space: pre; min-width: max-content;
      }
      .d-add { background: rgba(52, 199, 89, 0.16); color: #7ee2a0; }
      .d-del { background: rgba(255, 69, 58, 0.16); color: #ff9d96; }
      .d-ctx { color: var(--text-secondary, #8e8e93); }
      .d-skip { color: var(--text-secondary, #8e8e93); font-style: italic; padding: 2px 12px; }
      .msg { color: var(--text-secondary, #8e8e93); margin: 0 0 16px; }
      .secondary-link {
        border: none; background: transparent; color: var(--accent-online, #34c759);
        padding: 0; margin: 0 0 16px; font-size: 14px; font-weight: 600; text-align: left;
      }
      .options { margin: 0 0 16px; padding-left: 18px; color: var(--text); }
      .option-list, .question-list { display: grid; gap: 12px; margin-bottom: 16px; }
      .option-button {
        display: grid; gap: 4px; width: 100%; text-align: left;
        border: none; border-radius: 14px; padding: 14px 16px;
        background: var(--surface-3, #2c2c2e); color: var(--text, #fff);
      }
      .option-label { font-size: 16px; font-weight: 600; }
      .option-description { color: var(--text-secondary, #8e8e93); font-size: 13px; }
      .question { display: grid; gap: 8px; }
      .question-title { font-size: 14px; font-weight: 600; color: var(--text, #fff); }
      .question-input {
        width: 100%; border: none; border-radius: 12px; padding: 12px;
        background: var(--bg, #000); color: var(--text, #fff); resize: vertical;
        font: inherit;
      }
      .scope { display: flex; gap: 6px; background: var(--bg, #000); border-radius: 10px; padding: 4px; margin-bottom: 16px; }
      .seg {
        flex: 1; border: none; background: transparent; color: var(--text-secondary, #8e8e93);
        padding: 8px; border-radius: 8px; text-transform: capitalize; font-size: 14px;
      }
      .seg.active { background: var(--surface-3, #2c2c2e); color: var(--text, #fff); }
      .actions { display: flex; gap: 12px; }
      .actions button { flex: 1; border: none; border-radius: 14px; padding: 16px; font-size: 17px; font-weight: 600; }
      .actions button:disabled { opacity: 0.5; }
      .deny { background: var(--surface-3, #2c2c2e); color: var(--accent-error, #ff453a); }
      .allow { background: var(--accent-online, #34c759); color: #fff; }
    `,
  ],
})
export class ApprovalSheetComponent {
  private readonly haptics = inject(HapticsService);

  readonly prompt = input.required<MobilePromptDto>();
  readonly decision = output<ApprovalDecision>();
  readonly dismiss = output<void>();
  readonly open = output<void>();

  protected readonly scopes: ApprovalScope[] = ['once', 'session', 'always'];
  protected readonly scope = signal<ApprovalScope>('once');
  protected readonly answers = signal<Record<number, string>>({});

  /**
   * Real diff for file-editing tools so approvals aren't blind: Edit renders
   * old→new, Write renders the content as additions, MultiEdit concatenates
   * its hunks. Anything unrecognised falls back to the command/JSON preview.
   */
  protected readonly fileDiff = computed<FileDiffView | null>(() => {
    const p = this.prompt();
    if (p.kind !== 'permission' || !p.toolInput) return null;
    const args = p.toolInput;
    const filePath = typeof args['file_path'] === 'string' ? args['file_path'] : '';
    if (!filePath) return null;
    const tool = (p.toolName ?? '').toLowerCase();

    if (tool === 'edit' && typeof args['old_string'] === 'string' && typeof args['new_string'] === 'string') {
      return { filePath, ...diffLines(args['old_string'], args['new_string']) };
    }
    if (tool === 'write' && typeof args['content'] === 'string') {
      return { filePath, ...diffLines('', args['content']) };
    }
    if (tool === 'multiedit' && Array.isArray(args['edits'])) {
      const rows: DiffRow[] = [];
      let added = 0;
      let removed = 0;
      let truncated = false;
      for (const edit of args['edits'] as unknown[]) {
        if (!edit || typeof edit !== 'object') continue;
        const e = edit as Record<string, unknown>;
        if (typeof e['old_string'] !== 'string' || typeof e['new_string'] !== 'string') continue;
        if (rows.length) rows.push({ kind: 'skip', text: '⋯' });
        const d = diffLines(e['old_string'], e['new_string']);
        rows.push(...d.rows);
        added += d.added;
        removed += d.removed;
        truncated ||= d.truncated;
      }
      return rows.length ? { filePath, rows, added, removed, truncated } : null;
    }
    return null;
  });

  protected rowPrefix(row: DiffRow): string {
    switch (row.kind) {
      case 'add':
        return '+ ';
      case 'del':
        return '- ';
      case 'ctx':
        return '  ';
      default:
        return '';
    }
  }

  protected readonly commandText = computed(() => {
    const args = this.prompt().toolInput;
    if (!args) return '';
    if (typeof args['command'] === 'string') return args['command'];
    if (typeof args['file_path'] === 'string') return String(args['file_path']);
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return '';
    }
  });

  protected readonly canSubmitAnswers = computed(() =>
    Object.values(this.answers()).some((answer) => answer.trim().length > 0),
  );

  constructor() {
    effect(() => {
      void this.prompt().id;
      this.scope.set('once');
      this.answers.set({});
      // A new prompt sliding up is the "needs you" moment — buzz once.
      this.haptics.warning();
    });
  }

  protected decide(action: 'allow' | 'deny'): void {
    if (action === 'allow') this.haptics.success();
    else this.haptics.warning();
    this.decision.emit({ action, scope: this.scope() });
  }

  protected submitOption(optionId: string): void {
    this.haptics.tap();
    this.decision.emit({ action: 'allow', scope: 'once', response: optionId });
  }

  protected updateAnswer(index: number, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.answers.update((current) => ({ ...current, [index]: value }));
  }

  protected submitAnswers(): void {
    const questions = this.prompt().questions ?? [];
    const response = JSON.stringify(
      Object.fromEntries(questions.map((question, index) => [question, this.answers()[index] ?? ''])),
    );
    this.decision.emit({ action: 'allow', scope: 'once', response });
  }

  protected answerFor(index: number): string {
    return this.answers()[index] ?? '';
  }
}
