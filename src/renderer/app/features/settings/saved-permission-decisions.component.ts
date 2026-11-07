import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { SecurityIpcService } from '../../core/services/ipc/security-ipc.service';
import type { SavedPermissionRule } from '../../../../shared/types/saved-permission-rule.types';

export function summarizeRule(rule: Pick<SavedPermissionRule, 'scope' | 'pattern'>): string {
  const pattern = rule.pattern.slice(0, 300);
  if (rule.scope.startsWith('bash_')) return `Shell command: ${pattern.replace(/^bash:/, '')}`;
  if (rule.scope.startsWith('file_') || rule.scope.startsWith('directory_')) return `File: ${pattern}`;
  return `Tool: ${pattern.replace(/^tool:/, '')}`;
}

@Component({
  selector: 'app-saved-permission-decisions', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section aria-label="Saved decisions">
    <h4>Saved decisions</h4>
    <p>Harness remembers these 'Always' answers across sessions and applies them without asking. Remove one and Harness asks again next time.</p>
    @if (loading()) { <p>Loading...</p> }
    @else if (!rules().length && !error()) { <p>Nothing saved yet.</p> }
    @for (rule of rules(); track rule.id) {
      <div class="saved-row">
        <div><strong [class.block]="rule.action === 'deny'">{{ rule.action === 'deny' ? 'Block' : rule.action === 'allow' ? 'Allow' : 'Ask' }}</strong>
          <span>{{ summarize(rule) }}</span>
          @if (rule.action === 'deny') { <small>Refuses without asking</small> }
          @if (rule.scope === 'tool_use' && rule.pattern.startsWith('bash:')) { <small>Older format; no longer used</small> }
          @if (!rule.enabled) { <small>Disabled</small> }
          @if (rule.createdAt !== null) { <small>{{ savedDate(rule.createdAt) }}</small> }
        </div>
        <button type="button" [disabled]="removing() !== null" [attr.aria-label]="'Remove saved decision: ' + summarize(rule)" (click)="remove(rule.id)">Remove</button>
      </div>
    }
    <p role="status" aria-live="polite">{{ status() }}</p>
    @if (error()) { <p role="alert">{{ error() }}</p> }
  </section>`,
  styles: `section { margin:16px 0; } p,small { color:var(--text-secondary); font-size:12px; } .saved-row { display:flex; justify-content:space-between; gap:16px; padding:12px 0; border-bottom:1px solid var(--border-subtle); }
    .saved-row > div { min-width:0; } span,small { display:block; overflow-wrap:anywhere; } strong { color:var(--primary-color); } strong.block { color:var(--error-color); }
    button { align-self:center; cursor:pointer; border:1px solid var(--border-subtle); background:var(--bg-tertiary); color:var(--text-primary); border-radius:var(--radius-md); padding:6px 12px; }`,
})
export class SavedPermissionDecisionsComponent implements OnInit {
  private readonly ipc = inject(SecurityIpcService);
  readonly rules = signal<SavedPermissionRule[]>([]);
  readonly loading = signal(true);
  readonly removing = signal<string | null>(null);
  readonly error = signal('');
  readonly status = signal('');
  readonly summarize = summarizeRule;
  ngOnInit(): void { void this.reload(); }
  savedDate(timestamp: number): string { return `Saved ${new Date(timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`; }
  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.ipc.permissionListUserRules();
      if (!result.success) throw new Error('Could not load saved decisions.');
      this.rules.set(result.data ?? []); this.error.set('');
    } catch { this.error.set('Could not load saved decisions.'); }
    finally { this.loading.set(false); }
  }
  async remove(id: string): Promise<void> {
    if (this.removing()) return;
    this.removing.set(id); this.status.set('');
    try {
      const result = await this.ipc.permissionRemoveUserRule(id);
      if (!result.success) throw new Error('Could not remove this decision.');
      await this.reload();
      if (!this.error()) this.status.set('Removed. Harness will ask again.');
    } catch { this.error.set('Could not remove this decision.'); }
    finally { this.removing.set(null); }
  }
}
