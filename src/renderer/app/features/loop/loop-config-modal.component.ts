import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';

/**
 * First-run / re-config modal for Loop Mode. Collects the prompt, optional
 * plan file, caps (with sensible defaults), provider, and the verify command.
 *
 * `confirm` emits the partial-config payload that LoopStore.start expects.
 */
@Component({
  selector: 'app-loop-config-modal',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="loop-cfg-overlay">
      <div class="loop-cfg-modal" role="dialog" aria-label="Loop Mode configuration">
        <header>
          <h2>Loop Mode</h2>
          <button type="button" class="close" (click)="dismissed.emit()" aria-label="Close">×</button>
        </header>

        <section class="row">
          <label for="loop-cfg-prompt">Prompt</label>
          <textarea
            id="loop-cfg-prompt"
            rows="4"
            placeholder="Describe what the loop should drive… (e.g., 'Implement the refactor in PLAN.md until tests pass and the file is renamed.')"
            [ngModel]="prompt()"
            (ngModelChange)="prompt.set($event)"
          ></textarea>
        </section>

        <section class="row">
          <label for="loop-cfg-plan">Plan file <span class="hint">(optional, relative to workspace)</span></label>
          <input id="loop-cfg-plan" type="text" placeholder="PLAN.md" [ngModel]="planFile()" (ngModelChange)="planFile.set($event)" />
        </section>

        <section class="row split">
          <div>
            <label for="loop-cfg-cap-iter">Max iterations</label>
            <input id="loop-cfg-cap-iter" type="number" min="1" max="500" [ngModel]="maxIterations()" (ngModelChange)="maxIterations.set($event)" />
          </div>
          <div>
            <label for="loop-cfg-cap-hours">Max wall time (hours)</label>
            <input id="loop-cfg-cap-hours" type="number" min="1" max="24" [ngModel]="maxHours()" (ngModelChange)="maxHours.set($event)" />
          </div>
          <div>
            <label for="loop-cfg-cap-cost">Max spend ($)</label>
            <input id="loop-cfg-cap-cost" type="number" min="1" max="1000" [ngModel]="maxDollars()" (ngModelChange)="maxDollars.set($event)" />
          </div>
        </section>

        <section class="row">
          <label for="loop-cfg-verify">Verify command <span class="hint">(runs before stop; empty disables)</span></label>
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
              <option value="debate">3-agent debate (default)</option>
              <option value="star-chamber">Claude + Codex Star Chamber</option>
              <option value="single">Single agent</option>
            </select>
          </div>
        </section>

        <section class="row toggles">
          <label>
            <input type="checkbox" [checked]="requireRename()" (change)="requireRename.set(toggleEvent($event))" />
            Belt-and-braces: require <code>*_Completed.md</code> rename before stopping
          </label>
          <label>
            <input type="checkbox" [checked]="runVerifyTwice()" (change)="runVerifyTwice.set(toggleEvent($event))" />
            Anti-flake: run verify command twice
          </label>
          <label class="warn">
            <input type="checkbox" [checked]="allowDestructive()" (change)="allowDestructive.set(toggleEvent($event))" />
            Allow destructive ops (rm -rf, force-push) — use with care
          </label>
        </section>

        @if (validationError(); as err) {
          <div class="cfg-error">{{ err }}</div>
        }

        <footer>
          <button type="button" class="btn-secondary" (click)="dismissed.emit()">Cancel</button>
          <button type="button" class="btn-primary" [disabled]="!canSubmit()" (click)="submit()">Start Loop</button>
        </footer>
      </div>
    </div>
  `,
  styles: [`
    .loop-cfg-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center; z-index: 9999;
    }
    .loop-cfg-modal {
      background: var(--surface, #1f1f24); color: var(--fg, #e7e7ea);
      width: min(680px, 92vw); max-height: 86vh; overflow: auto;
      border-radius: 10px; padding: 18px 22px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.45);
      font-family: inherit;
    }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    header h2 { margin: 0; font-size: 18px; }
    .close { background: none; border: none; font-size: 24px; cursor: pointer; color: inherit; }
    .row { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
    .row.split { flex-direction: row; gap: 12px; }
    .row.split > div { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    .row.toggles { gap: 8px; margin-top: 12px; }
    .row.toggles label { display: flex; gap: 8px; align-items: center; font-size: 13px; }
    .row.toggles label.warn { color: #f7c07a; }
    label { font-size: 12px; opacity: 0.85; }
    .hint { font-size: 11px; opacity: 0.6; }
    input[type="text"], input[type="number"], textarea, select {
      background: rgba(255,255,255,0.05); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
      padding: 6px 9px; font: inherit;
    }
    textarea { resize: vertical; min-height: 80px; }
    .cfg-error { background: rgba(255,80,80,0.15); border: 1px solid rgba(255,80,80,0.4); padding: 8px 10px; border-radius: 6px; margin: 8px 0; font-size: 13px; }
    footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    .btn-primary, .btn-secondary {
      padding: 7px 14px; border-radius: 6px; cursor: pointer; font: inherit;
      border: 1px solid rgba(255,255,255,0.12);
    }
    .btn-primary { background: #5f8ee0; color: white; border-color: #5f8ee0; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { background: transparent; color: inherit; }
    code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  `],
})
export class LoopConfigModalComponent {
  workspaceCwd = input.required<string>();
  initialPromptHint = input<string>('');

  dismissed = output<void>();
  confirm = output<LoopStartConfigInput>();

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

  constructor() {
    // Pre-fill prompt with the hint when component initializes — input() values
    // settle in the constructor for signal-input reads inside computed/effect.
    queueMicrotask(() => {
      const hint = this.initialPromptHint();
      if (hint && !this.prompt()) this.prompt.set(hint);
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

  submit(): void {
    if (!this.canSubmit()) return;
    const config: LoopStartConfigInput = {
      initialPrompt: this.prompt().trim(),
      workspaceCwd: this.workspaceCwd(),
      planFile: this.planFile().trim() || undefined,
      provider: this.provider(),
      reviewStyle: this.reviewStyle(),
      contextStrategy: 'fresh-child',
      caps: {
        maxIterations: this.maxIterations(),
        maxWallTimeMs: this.maxHours() * 60 * 60 * 1000,
        maxCostCents: this.maxDollars() * 100,
      },
      completion: {
        verifyCommand: this.verifyCommand(),
        runVerifyTwice: this.runVerifyTwice(),
        requireCompletedFileRename: this.requireRename(),
      },
      allowDestructiveOps: this.allowDestructive(),
    };
    this.confirm.emit(config);
  }
}
