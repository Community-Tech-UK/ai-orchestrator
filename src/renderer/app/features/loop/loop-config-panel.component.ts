import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import { DEFAULT_LOOP_PROMPT, LoopPromptHistoryService } from './loop-prompt-history.service';

// Defaults that match defaultLoopConfig() in src/shared/types/loop.types.ts.
// We must include all sub-fields whenever caps/completion are sent — Zod's
// `LoopConfigInputSchema` only makes the top-level keys optional.
const DEFAULT_CAPS = {
  maxTokens: 1_000_000,
  maxToolCallsPerIteration: 200,
};
const DEFAULT_COMPLETION = {
  completedFilenamePattern: '*_[Cc]ompleted.md',
  donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
  doneSentinelFile: 'DONE.txt',
  verifyTimeoutMs: 600_000,
};

/**
 * Inline accordion panel for configuring and starting a loop.
 *
 * Renders directly above the message composer (slides up). Pre-fills the
 * prompt from the textarea content (or the user's last prompt, or the
 * canonical default), and surfaces the last 3 unique prompts as quick-pick
 * chips. Advanced fields (caps, verify, provider, review style) are tucked
 * behind a "Show advanced" expander to keep the visible panel compact.
 */
@Component({
  selector: 'app-loop-config-panel',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="loop-cfg-panel" role="dialog" aria-label="Loop Mode configuration">
      <header>
        <div class="header-titles">
          <h2>Loop Mode</h2>
          <span class="subtitle">Iterate until verify passes — caps and review style apply.</span>
        </div>
        <button type="button" class="close" (click)="dismissed.emit()" aria-label="Close">×</button>
      </header>

      @if (recentPrompts().length > 0 || !prompt().trim()) {
        <div class="recall-row">
          <span class="recall-label">Recent</span>
          <div class="recall-chips">
            @for (entry of recentPrompts(); track entry) {
              <span class="recall-chip-wrap" [class.active]="prompt().trim() === entry">
                <button
                  type="button"
                  class="recall-chip"
                  (click)="prompt.set(entry)"
                  [title]="entry"
                >{{ entry.length > 60 ? (entry.slice(0, 57) + '…') : entry }}</button>
                <button
                  type="button"
                  class="recall-chip-remove"
                  (click)="onForgetPrompt(entry)"
                  aria-label="Remove from recent"
                  title="Remove from recent"
                >×</button>
              </span>
            }
            <button
              type="button"
              class="recall-chip default"
              [class.active]="prompt().trim() === defaultPrompt"
              (click)="prompt.set(defaultPrompt)"
              title="Use canonical default prompt"
            >Default</button>
          </div>
        </div>
      }

      <section class="row">
        <label for="loop-cfg-prompt">Prompt</label>
        <textarea
          id="loop-cfg-prompt"
          rows="3"
          placeholder="What should the loop drive toward?"
          [ngModel]="prompt()"
          (ngModelChange)="prompt.set($event)"
        ></textarea>
      </section>

      <button
        type="button"
        class="advanced-toggle"
        (click)="showAdvanced.set(!showAdvanced())"
        [attr.aria-expanded]="showAdvanced()"
      >
        <span class="caret">{{ showAdvanced() ? '▾' : '▸' }}</span>
        Advanced
      </button>

      @if (showAdvanced()) {
        <div class="advanced-section">
          <section class="row">
            <label for="loop-cfg-plan">Plan file <span class="hint">(optional)</span></label>
            <input id="loop-cfg-plan" type="text" placeholder="PLAN.md" [ngModel]="planFile()" (ngModelChange)="planFile.set($event)" />
          </section>

          <section class="row split">
            <div>
              <label for="loop-cfg-cap-iter">Max iterations</label>
              <input id="loop-cfg-cap-iter" type="number" min="1" max="500" [ngModel]="maxIterations()" (ngModelChange)="maxIterations.set($event)" />
            </div>
            <div>
              <label for="loop-cfg-cap-hours">Max hours</label>
              <input id="loop-cfg-cap-hours" type="number" min="1" max="24" [ngModel]="maxHours()" (ngModelChange)="maxHours.set($event)" />
            </div>
            <div>
              <label for="loop-cfg-cap-cost">Max spend ($)</label>
              <input id="loop-cfg-cap-cost" type="number" min="1" max="1000" [ngModel]="maxDollars()" (ngModelChange)="maxDollars.set($event)" />
            </div>
          </section>

          <section class="row">
            <label for="loop-cfg-verify">Verify command <span class="hint">(empty disables)</span></label>
            <input id="loop-cfg-verify" type="text" [ngModel]="verifyCommand()" (ngModelChange)="verifyCommand.set($event)" />
          </section>

          <section class="row split">
            <div>
              <label for="loop-cfg-provider">Provider</label>
              <select id="loop-cfg-provider" [ngModel]="provider()" (ngModelChange)="provider.set($event)">
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div>
              <label for="loop-cfg-review">Review style</label>
              <select id="loop-cfg-review" [ngModel]="reviewStyle()" (ngModelChange)="reviewStyle.set($event)">
                <option value="debate">3-agent debate</option>
                <option value="star-chamber">Star Chamber</option>
                <option value="single">Single agent</option>
              </select>
            </div>
          </section>

          <section class="row toggles">
            <label>
              <input type="checkbox" [checked]="requireRename()" (change)="requireRename.set(toggleEvent($event))" />
              Require <code>*_Completed.md</code> rename before stopping
            </label>
            <label>
              <input type="checkbox" [checked]="runVerifyTwice()" (change)="runVerifyTwice.set(toggleEvent($event))" />
              Run verify command twice (anti-flake)
            </label>
            <label class="warn">
              <input type="checkbox" [checked]="allowDestructive()" (change)="allowDestructive.set(toggleEvent($event))" />
              Allow destructive ops (rm -rf, force-push)
            </label>
          </section>
        </div>
      }

      @if (validationError(); as err) {
        <div class="cfg-error">{{ err }}</div>
      }

      <footer>
        <button type="button" class="btn-secondary" (click)="dismissed.emit()">Cancel</button>
        <button type="button" class="btn-primary" [disabled]="!canSubmit()" (click)="submit()">Start Loop</button>
      </footer>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      animation: loopPanelSlideUp 0.22s ease-out;
      transform-origin: bottom center;
    }
    @keyframes loopPanelSlideUp {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .loop-cfg-panel {
      background: var(--bg-secondary, #1f1f24);
      color: var(--text-primary, #e7e7ea);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 14px 16px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
      max-height: 60vh;
      overflow: auto;
    }
    header {
      display: flex; align-items: flex-start; justify-content: space-between;
      margin-bottom: 10px; gap: 12px;
    }
    .header-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .subtitle { font-size: 11px; opacity: 0.6; }
    .close { background: none; border: none; font-size: 22px; cursor: pointer; color: inherit; line-height: 1; padding: 0 4px; }
    .recall-row {
      display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .recall-label {
      font-family: var(--font-mono, monospace); font-size: 9px;
      letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.55;
    }
    .recall-chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }
    .recall-chip {
      max-width: 360px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.03);
      color: inherit;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .recall-chip:hover { background: rgba(255, 255, 255, 0.07); }
    .recall-chip.active { border-color: var(--primary-color, #d4b45a); color: var(--primary-color, #d4b45a); }
    .recall-chip.default { font-style: italic; opacity: 0.85; }
    .recall-chip-wrap {
      display: inline-flex; align-items: stretch; gap: 0;
      border-radius: 999px;
    }
    .recall-chip-wrap.active .recall-chip { border-color: var(--primary-color, #d4b45a); color: var(--primary-color, #d4b45a); }
    .recall-chip-wrap .recall-chip { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: none; }
    .recall-chip-remove {
      padding: 0 8px; font: inherit; font-size: 11px; line-height: 1;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-top-left-radius: 0; border-bottom-left-radius: 0;
      border-top-right-radius: 999px; border-bottom-right-radius: 999px;
      color: inherit; opacity: 0.5; cursor: pointer;
    }
    .recall-chip-remove:hover { opacity: 1; color: #f7c07a; }
    .row { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
    .row.split { flex-direction: row; gap: 12px; }
    .row.split > div { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    .row.toggles { gap: 6px; margin-top: 10px; }
    .row.toggles label { display: flex; gap: 8px; align-items: center; font-size: 12px; }
    .row.toggles label.warn { color: #f7c07a; }
    label { font-size: 11px; opacity: 0.85; }
    .hint { font-size: 10px; opacity: 0.6; }
    input[type="text"], input[type="number"], textarea, select {
      background: rgba(255, 255, 255, 0.05);
      color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 6px 9px;
      font: inherit;
      font-size: 13px;
    }
    textarea { resize: vertical; min-height: 64px; }
    .advanced-toggle {
      background: none; border: none; padding: 6px 0; font: inherit;
      color: inherit; opacity: 0.7; cursor: pointer; font-size: 12px;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .advanced-toggle:hover { opacity: 1; }
    .caret { font-size: 10px; }
    .advanced-section { animation: loopPanelSlideUp 0.18s ease-out; }
    .cfg-error {
      background: rgba(255, 80, 80, 0.12);
      border: 1px solid rgba(255, 80, 80, 0.32);
      padding: 6px 9px;
      border-radius: 6px;
      margin: 8px 0;
      font-size: 12px;
    }
    footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    .btn-primary, .btn-secondary {
      padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit;
      border: 1px solid rgba(255, 255, 255, 0.12); font-size: 13px;
    }
    .btn-primary {
      background: var(--primary-color, #5f8ee0);
      color: #11131a;
      border-color: var(--primary-color, #5f8ee0);
      font-weight: 600;
    }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { background: transparent; color: inherit; }
    code { background: rgba(255, 255, 255, 0.08); padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  `],
})
export class LoopConfigPanelComponent {
  workspaceCwd = input.required<string>();

  dismissed = output<void>();
  confirm = output<LoopStartConfigInput>();

  private history = inject(LoopPromptHistoryService);
  recentPrompts = this.history.recent;
  defaultPrompt = DEFAULT_LOOP_PROMPT;

  prompt = signal('');
  planFile = signal('');
  maxIterations = signal(50);
  maxHours = signal(8);
  maxDollars = signal(10);
  verifyCommand = signal('npx tsc --noEmit && npm test --silent');
  provider = signal<'claude' | 'codex'>('claude');
  reviewStyle = signal<'single' | 'debate' | 'star-chamber'>('debate');
  requireRename = signal(true);
  runVerifyTwice = signal(true);
  allowDestructive = signal(false);
  showAdvanced = signal(false);

  constructor() {
    // Pre-fill the prompt: most recent saved > canonical default.
    // Deliberately don't autofill from the message textarea — that's the
    // user's pending message, not the loop's seed prompt.
    effect(() => {
      if (this.prompt().trim()) return;
      const recent = this.recentPrompts();
      if (recent.length > 0) {
        this.prompt.set(recent[0]);
        return;
      }
      this.prompt.set(DEFAULT_LOOP_PROMPT);
    });
  }

  validationError = computed(() => {
    if (!this.prompt().trim()) return 'Prompt is required.';
    if (this.maxIterations() < 1) return 'Max iterations must be at least 1.';
    if (this.maxHours() < 1) return 'Max wall time must be at least 1 hour.';
    if (this.maxDollars() < 1) return 'Max spend must be at least $1.';
    return null;
  });

  canSubmit = computed(() => !this.validationError());

  toggleEvent(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  onForgetPrompt(entry: string): void {
    this.history.forget(entry);
    if (this.prompt() === entry) this.prompt.set('');
  }

  submit(): void {
    if (!this.canSubmit()) return;
    const trimmed = this.prompt().trim();
    const config: LoopStartConfigInput = {
      initialPrompt: trimmed,
      workspaceCwd: this.workspaceCwd(),
      planFile: this.planFile().trim() || undefined,
      provider: this.provider(),
      reviewStyle: this.reviewStyle(),
      contextStrategy: 'fresh-child',
      caps: {
        maxIterations: this.maxIterations(),
        maxWallTimeMs: this.maxHours() * 60 * 60 * 1000,
        maxTokens: DEFAULT_CAPS.maxTokens,
        maxCostCents: this.maxDollars() * 100,
        maxToolCallsPerIteration: DEFAULT_CAPS.maxToolCallsPerIteration,
      },
      completion: {
        completedFilenamePattern: DEFAULT_COMPLETION.completedFilenamePattern,
        donePromiseRegex: DEFAULT_COMPLETION.donePromiseRegex,
        doneSentinelFile: DEFAULT_COMPLETION.doneSentinelFile,
        verifyCommand: this.verifyCommand(),
        verifyTimeoutMs: DEFAULT_COMPLETION.verifyTimeoutMs,
        runVerifyTwice: this.runVerifyTwice(),
        requireCompletedFileRename: this.requireRename(),
      },
      allowDestructiveOps: this.allowDestructive(),
    };
    this.confirm.emit(config);
  }
}
