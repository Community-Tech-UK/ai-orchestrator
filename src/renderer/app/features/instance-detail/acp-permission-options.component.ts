import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { AcpPermissionOption } from './user-action-request.input-required';

@Component({
  selector: 'app-acp-permission-options', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="options">@for (option of options(); track option.optionId) {
    <div><button type="button" [class]="option.tone === 'allow' ? 'btn-approve' : 'btn-reject'"
      [disabled]="busy()" (click)="optionChosen.emit(option.optionId)">{{ option.name }}</button>
      @if (option.lasting) { <p>Applies to later requests from this agent, as the agent defines it.</p> }
    </div>
  }</div>`,
  styles: `.options { display:flex; flex-wrap:wrap; gap:var(--spacing-sm); margin-bottom:var(--spacing-sm); }
    .options > div { max-width:100%; } button { padding:8px 12px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); white-space:normal; overflow-wrap:anywhere; cursor:pointer; }
    .btn-approve { background:var(--primary-color); color:var(--bg-primary); } .btn-reject { background:var(--bg-tertiary); color:var(--text-primary); }
    button:disabled { opacity:.5; cursor:not-allowed; } p { color:var(--text-muted); font-size:12px; max-width:36ch; }`,
})
export class AcpPermissionOptionsComponent {
  options = input.required<AcpPermissionOption[]>();
  busy = input(false);
  optionChosen = output<string>();
}
