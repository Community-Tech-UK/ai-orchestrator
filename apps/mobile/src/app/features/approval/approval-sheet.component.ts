import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ApprovalDecision, ApprovalDraft, ApprovalScope } from '../../core/approval-presentation.store';
import { MobileSheetComponent } from '../../shared/mobile-sheet.component';
import { availableChangeSections } from './approval-change';
import type { MobilePromptDto } from '../../core/models';
import { diffLines, type DiffRow } from '../../shared/line-diff';

export type { ApprovalDecision, ApprovalScope } from '../../core/approval-presentation.store';

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
  imports: [MobileSheetComponent],
  template: `
    <app-mobile-sheet label="Needs you" closeLabel="Later" (dismiss)="dismiss.emit()">
      <dl class="context">
        <div><dt>Host</dt><dd>{{ context().host }}</dd></div>
        <div><dt>Project</dt><dd>{{ context().project }}</dd></div>
        <div><dt>Session</dt><dd>{{ context().session }}</dd></div>
      </dl>
      <button type="button" class="secondary-link" (click)="open.emit()">Open session</button>
      @if (requests().length > 1) {
        <label class="request-picker">Needs you · {{ requests().length }}
          <select [value]="prompt().id" (change)="selectRequest($event)">
            @for (request of requests(); track request.id) {
              <option [value]="request.id">{{ request.title }}</option>
            }
          </select>
        </label>
      }

      @if (prompt().kind === 'permission') {
        <h3 class="title">{{ prompt().toolName ? prompt().toolName + ' needs approval' : 'Approve action?' }}</h3>
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
              <div class="diff-row d-skip">Preview shortened. Expand “Full available change” below to inspect all supplied content.</div>
            }
          </div>
        } @else if (commandText()) {
          <pre class="cmd">{{ commandText() }}</pre>
        } @else if (prompt().message) {
          <p class="msg">{{ prompt().message }}</p>
        }

        @if (fullChange().length) {
          <details class="full-change">
            <summary>Full available change</summary>
            @for (section of fullChange(); track $index) {
              <h4>{{ section.label }}</h4>
              <pre class="full-content" tabindex="0" [attr.aria-label]="section.label">{{ section.content }}</pre>
            }
          </details>
        }
        <div class="scope">
          @for (scopeOption of scopes; track scopeOption) {
            <button
              class="seg"
              type="button"
              [class.active]="draft().scope === scopeOption"
              [attr.data-scope]="scopeOption"
              [attr.aria-pressed]="draft().scope === scopeOption"
              [disabled]="pending()"
              (click)="scopeChange.emit(scopeOption)"
            >{{ scopeLabels[scopeOption] }}</button>
          }
        </div>

        <p class="scope-help">{{ scopeExplanations[draft().scope] }}</p>
        <div class="actions">
          <button type="button" class="deny" [disabled]="pending()" (click)="decide('deny')">Deny</button>
          <button type="button" class="allow" [disabled]="pending()" (click)="decide('allow')">Allow</button>
        </div>
      } @else {
        <h3 class="title">{{ prompt().title }}</h3>
        <p class="msg">{{ prompt().message }}</p>

        @if (prompt().requestType === 'select_option' && prompt().options?.length) {
          <div class="option-list">
            @for (option of prompt().options; track option.id) {
              <button type="button" class="option-button" [disabled]="pending()" (click)="submitOption(option.id)">
                <span class="option-label">{{ option.label }}</span>
                @if (option.description) {
                  <span class="option-description">{{ option.description }}</span>
                }
              </button>
            }
          </div>
        } @else if (prompt().requestType === 'ask_questions' && prompt().questions?.length) {
          <div class="question-list">
            @for (question of prompt().questions; track $index) {
              <label class="question">
                <span class="question-title">{{ question }}</span>
                <textarea
                  class="question-input"
                  rows="3"
                  [disabled]="pending()"
                  [value]="answerFor($index)"
                  (input)="updateAnswer($index, $event)"
                ></textarea>
              </label>
            }
          </div>
          <div class="actions">
            <button class="allow" [disabled]="pending() || !canSubmitAnswers()" (click)="submitAnswers()">
              {{ pending() ? 'Sending…' : error() ? 'Retry answers' : 'Send answers' }}
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
            <button type="button" class="deny" [disabled]="pending()" (click)="decide('deny')">Deny</button>
            <button type="button" class="allow" [disabled]="pending()" (click)="decide('allow')">Allow</button>
          </div>
        }
      }

      <!--
        Rendered once, outside every branch. It previously lived inside two of the
        four branches, so the commonest prompt kind (permission) silently dropped
        it and a rejected decision looked like a dead button.
      -->
      @if (pending()) {
        <p class="sending" role="status">Sending decision…</p>
      }
      @if (error()) {
        <p class="sheet-error" role="alert">{{ error() }}</p>
      }
    </app-mobile-sheet>
  `,
  styles: [
    `
      :host { display: block; }
      .context { margin: 0 0 8px; display: grid; gap: 4px; }
      .context div { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; }
      .context dt { color: var(--text-secondary); font-size: 13px; }
      .context dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
      .request-picker { display: grid; gap: 6px; margin: 0 0 16px; font-size: 13px; }
      .request-picker select { width: 100%; min-height: 44px; background: var(--surface-2); color: var(--text); border: 1px solid var(--separator); border-radius: 12px; padding: 8px; font: inherit; }
      .full-change { margin-bottom: 16px; }
      .full-change summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; text-decoration: underline; }
      .full-change h4 { margin: 8px 0; overflow-wrap: anywhere; }
      .full-content { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 50dvh; overflow: auto; background: var(--bg); border-radius: 12px; padding: 12px; font: 12px/1.5 var(--font-family-mono); }
      .scope-help, .sending { font-size: 13px; color: var(--text-secondary); margin: 0 0 16px; }
      button:disabled { opacity: 0.5; }
      .title { font-size: 20px; font-weight: 700; margin: 0 0 12px; }
      .cmd {
        background: var(--bg, #000); color: var(--text, #fff); border-radius: var(--radius-md); padding: 12px;
        font-family: var(--font-family-mono); font-size: 13px;
        white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; margin: 0 0 16px;
      }
      .diff-head {
        display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
        margin: 0 0 6px;
      }
      .diff-path {
        font-family: var(--font-family-mono); font-size: 12px;
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
        font-family: var(--font-family-mono); font-size: 12px; line-height: 1.5;
        padding: 0 12px; white-space: pre; min-width: max-content;
      }
      .d-add { background: rgba(52, 199, 89, 0.16); color: #7ee2a0; }
      .d-del { background: rgba(255, 69, 58, 0.16); color: #ff9d96; }
      .d-ctx { color: var(--text-secondary, #8e8e93); }
      .d-skip { white-space: normal; min-width: 0; color: var(--text-secondary, #8e8e93); font-style: italic; padding: 2px 12px; }
      .msg { color: var(--text-secondary, #8e8e93); margin: 0 0 16px; }
      .secondary-link {
        border: none; background: transparent; color: var(--accent-online, #34c759);
        min-height: 44px; padding: 8px 0; margin: 0 0 8px; font-size: 14px; font-weight: 600; text-align: left;
      }
      .options { margin: 0 0 16px; padding-left: 18px; color: var(--text); }
      .option-list, .question-list { display: grid; gap: 12px; margin-bottom: 16px; }
      .option-button {
        display: grid; gap: 4px; width: 100%; text-align: left;
        border: none; border-radius: 14px; padding: 14px 16px;
        background: var(--surface-2, #2c2c2e); color: var(--text, #fff);
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
      .scope { display: flex; gap: 4px; background: var(--bg, #000); border-radius: var(--radius-md); padding: 4px; margin-bottom: 16px; }
      .seg {
        flex: 1; border: none; background: transparent; color: var(--text-secondary, #8e8e93);
        min-height: var(--control-size); padding: 8px; border-radius: var(--radius-sm); text-transform: capitalize; font-size: 14px;
      }
      .seg.active { background: var(--surface-2, #2c2c2e); color: var(--text, #fff); }
      .actions { display: flex; gap: 12px; }
      .actions button { flex: 1; min-height: 52px; border: none; border-radius: var(--radius-md); padding: 12px 16px; font-size: 17px; font-weight: 600; }
      .actions button:disabled { opacity: 0.5; }
      .deny { background: var(--surface-2, #2c2c2e); color: var(--accent-error, #ff453a); }
      .sheet-error { margin: 0 0 8px; color: var(--accent-error, #ff453a); font-size: 13px; }
      .allow { background: var(--primitive-white); color: var(--primitive-black); }
    `,
  ],
})
export class ApprovalSheetComponent {
  readonly prompt = input.required<MobilePromptDto>();
  /**
   * Why the last decision didn't go through. The sheet covers most of the screen,
   * so without this a rejected token left the prompt sitting there with no
   * explanation and the connection pill hidden behind the scrim.
   */
  readonly error = input<string | null>(null);
  readonly pending = input(false);
  readonly draft = input<ApprovalDraft>({ scope: 'once', answers: {} });
  readonly requests = input<MobilePromptDto[]>([]);
  readonly context = input({ host: 'Unknown host', project: 'No workspace', session: 'Session unavailable' });
  readonly scopeChange = output<ApprovalScope>();
  readonly answerChange = output<{ index: number; value: string }>();
  readonly requestSelected = output<string>();
  readonly decision = output<ApprovalDecision>();
  readonly dismiss = output<void>();
  readonly open = output<void>();

  protected readonly scopes: ApprovalScope[] = ['once', 'session', 'always'];
  protected readonly scopeLabels = { once: 'Once', session: 'This session', always: 'Always' };
  protected readonly scopeExplanations = {
    once: 'Use this decision for this request without adding a saved rule.',
    session: 'Reuse this decision for matching actions in this session.',
    always: 'Save this decision for matching actions on this host, including future sessions.',
  };
  protected readonly fullChange = computed(() => availableChangeSections(this.prompt()));

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
    Object.values(this.draft().answers).some((answer) => answer.trim().length > 0),
  );

  protected decide(action: 'allow' | 'deny'): void {
    if (this.pending()) return;
    this.decision.emit({ action, scope: this.draft().scope });
  }

  protected submitOption(optionId: string): void {
    if (this.pending()) return;
    this.decision.emit({ action: 'allow', scope: 'once', response: optionId });
  }

  protected updateAnswer(index: number, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    if (!this.pending()) this.answerChange.emit({ index, value });
  }

  protected submitAnswers(): void {
    if (this.pending() || !this.canSubmitAnswers()) return;
    const questions = this.prompt().questions ?? [];
    const response = JSON.stringify(
      Object.fromEntries(questions.map((question, index) => [question, this.draft().answers[index] ?? ''])),
    );
    this.decision.emit({ action: 'allow', scope: 'once', response });
  }

  protected selectRequest(event: Event): void {
    this.requestSelected.emit((event.target as HTMLSelectElement).value);
  }

  protected answerFor(index: number): string {
    return this.draft().answers[index] ?? '';
  }
}
