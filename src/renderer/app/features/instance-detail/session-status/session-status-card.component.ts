import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { SessionStatusView } from './session-status.model';
import { copyFor } from '../../../shared/tooltip/tooltip-copy';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
@Component({ selector: 'app-session-status-card', standalone: true, imports: [AioTooltipDirective], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<article aria-label="Session status">
    <header><h2>{{ view().title }}</h2><button type="button" (click)="copy()">Copy</button><button type="button" (click)="closed.emit()">Close</button></header>
    @if (copyMessage()) { <p role="status">{{ copyMessage() }}</p> }
    <dl>@for (row of view().rows; track row.label) { <dt [attr.tabindex]="row.label === 'Cache' ? 0 : null" [appTooltip]="row.label === 'Cache' && view().cacheIsClaudePlan ? cacheTooltip : null">{{ row.label }}</dt><dd>@for (line of row.lines; track $index) { <p>{{ line }}</p> }</dd> }</dl>
  </article>`,
  styles: [`article { padding:20px; color:var(--text-primary); background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:12px; }
    header { display:flex; align-items:center; gap:12px; } h2 { flex:1; font-size:16px; } dt { font-weight:600; margin-top:14px; } dd { margin:4px 0; } p { margin:4px 0; }`],
})
export class SessionStatusCardComponent {
  readonly cacheTooltip = copyFor('session.cacheWarm');
  readonly view = input.required<SessionStatusView>();
  readonly closed = output<void>();
  readonly copyMessage = signal('');
  async copy(): Promise<void> {
    try { await navigator.clipboard.writeText(this.view().text); this.copyMessage.set('Copied'); }
    catch { this.copyMessage.set('Could not copy. Select the text to copy it.'); }
  }
}
