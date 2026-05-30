import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { MobilePromptDto } from '../../core/models';

export type ApprovalScope = 'once' | 'session' | 'always';
export interface ApprovalDecision {
  action: 'allow' | 'deny';
  scope: ApprovalScope;
}

/**
 * Bottom-sheet for the highest-value action: answering an agent's approval
 * prompt. Permission prompts get Allow/Deny + a scope segmented control;
 * orchestration questions show the message with an "Open session" deep-link.
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
        @if (commandText()) {
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
        @if (prompt().options?.length) {
          <ul class="options">
            @for (o of prompt().options; track o) {
              <li>{{ o }}</li>
            }
          </ul>
        }
        <div class="actions">
          <button class="deny" (click)="dismiss.emit()">Later</button>
          <button class="allow" (click)="open.emit()">Open session</button>
        </div>
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
      .msg { color: var(--text-secondary, #8e8e93); margin: 0 0 16px; }
      .options { margin: 0 0 16px; padding-left: 18px; color: var(--text); }
      .scope { display: flex; gap: 6px; background: var(--bg, #000); border-radius: 10px; padding: 4px; margin-bottom: 16px; }
      .seg {
        flex: 1; border: none; background: transparent; color: var(--text-secondary, #8e8e93);
        padding: 8px; border-radius: 8px; text-transform: capitalize; font-size: 14px;
      }
      .seg.active { background: var(--surface-3, #2c2c2e); color: var(--text, #fff); }
      .actions { display: flex; gap: 12px; }
      .actions button { flex: 1; border: none; border-radius: 14px; padding: 16px; font-size: 17px; font-weight: 600; }
      .deny { background: var(--surface-3, #2c2c2e); color: var(--accent-error, #ff453a); }
      .allow { background: var(--accent-online, #34c759); color: #fff; }
    `,
  ],
})
export class ApprovalSheetComponent {
  readonly prompt = input.required<MobilePromptDto>();
  readonly decision = output<ApprovalDecision>();
  readonly dismiss = output<void>();
  readonly open = output<void>();

  protected readonly scopes: ApprovalScope[] = ['once', 'session', 'always'];
  protected readonly scope = signal<ApprovalScope>('once');

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

  protected decide(action: 'allow' | 'deny'): void {
    this.decision.emit({ action, scope: this.scope() });
  }
}
