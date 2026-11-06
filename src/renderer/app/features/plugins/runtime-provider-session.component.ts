import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PluginIpcService } from '../../core/services/ipc/plugin-ipc.service';
import type { RuntimeProviderChoice } from '../../../../shared/types/runtime-provider-session.types';

@Component({
  selector: 'app-runtime-provider-session',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="provider-session-heading">
      <h2 id="provider-session-heading">Send one message</h2>
      <p>Use an installed provider package here for a text reply without tools. Each send starts a fresh session; messages are not saved.</p>
      <label>Working folder
        <input [value]="folder()" (input)="changeFolder($any($event.target).value)" [disabled]="busy()" />
      </label>
      <button type="button" (click)="refresh()" [disabled]="busy() || !folder().trim()">
        {{ busy() ? 'Working…' : 'Find providers' }}
      </button>
      @if (searched() && providers().length === 0) {
        <p>No provider packages could be activated for this folder.</p>
      }
      @if (providers().length > 0) {
        <label>Provider
          <select [value]="selected()" (change)="changeProvider($any($event.target).value)" [disabled]="busy()">
            @for (choice of providers(); track choice.provider) {
              <option [value]="choice.provider">{{ choice.name }}</option>
            }
          </select>
        </label>
        <label>Message
          <textarea [value]="message()" (input)="changeMessage($any($event.target).value)" [disabled]="busy()" maxlength="100000"></textarea>
        </label>
        <p>Your provider may charge for this message.</p>
        <button type="button" (click)="send()" [disabled]="!canSend()">{{ busy() ? 'Sending…' : 'Send' }}</button>
      }
      <p role="status" aria-live="polite">{{ reply() }}</p>
      <p role="alert">{{ error() ? 'The provider request could not finish. See Details.' : '' }}</p>
      @if (error() || failures().length) {
        <details><summary>Details</summary><pre>{{ error() || failures().join('; ') }}</pre></details>
      }
    </section>
  `,
  styles: `
    section { padding: 20px; border: 1px solid var(--border-primary); border-radius: 8px; background: var(--bg-secondary); }
    h2 { font-size: 16px; margin: 0 0 12px; }
    label { display: grid; gap: 6px; margin: 12px 0; }
    input, textarea, select { width: 100%; box-sizing: border-box; padding: 8px; color: var(--text-primary); background: var(--bg-primary); border: 1px solid var(--border-primary); border-radius: 4px; font: inherit; }
    textarea { min-height: 80px; resize: vertical; }
    button { padding: 8px 12px; color: var(--text-primary); background: var(--bg-primary); border: 1px solid var(--border-primary); border-radius: 4px; cursor: pointer; }
    button:disabled { opacity: .6; cursor: default; }
    [role="status"], pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    [role="alert"] { color: var(--pill-error-fg); }
  `,
})
export class RuntimeProviderSessionComponent {
  private readonly ipc = inject(PluginIpcService);
  private readonly folderState = signal('');
  private readonly selectedState = signal('');
  private readonly messageState = signal('');
  private readonly providersState = signal<RuntimeProviderChoice[]>([]);
  private readonly failuresState = signal<string[]>([]);
  private readonly searchedState = signal(false);
  private readonly busyState = signal(false);
  private readonly errorState = signal('');
  private readonly replyState = signal('');
  readonly folder = this.folderState.asReadonly();
  readonly selected = this.selectedState.asReadonly();
  readonly message = this.messageState.asReadonly();
  readonly providers = this.providersState.asReadonly();
  readonly failures = this.failuresState.asReadonly();
  readonly searched = this.searchedState.asReadonly();
  readonly busy = this.busyState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly reply = this.replyState.asReadonly();
  readonly canSend = computed(() => !this.busy() && !!this.message().trim()
    && this.providers().some((choice) => choice.provider === this.selected()));

  changeFolder(value: string): void {
    this.folderState.set(value);
    this.providersState.set([]);
    this.selectedState.set('');
    this.searchedState.set(false);
    this.errorState.set('');
    this.replyState.set('');
    this.failuresState.set([]);
  }

  changeProvider(value: string): void {
    this.selectedState.set(value);
  }

  changeMessage(value: string): void {
    this.messageState.set(value);
  }

  async refresh(): Promise<void> {
    if (this.busy() || !this.folder().trim()) return;
    this.busyState.set(true);
    this.errorState.set('');
    this.providersState.set([]);
    this.selectedState.set('');
    this.failuresState.set([]);
    this.replyState.set('');
    try {
      const response = await this.ipc.runtimeProviderList(this.folder().trim());
      if (!response.success || !response.data) throw new Error(response.error?.message ?? 'Could not read providers.');
      this.providersState.set(response.data.providers);
      this.failuresState.set(response.data.failures);
      this.selectedState.set(response.data.providers[0]?.provider ?? '');
      this.searchedState.set(true);
    } catch (error) { this.errorState.set(error instanceof Error ? error.message : String(error)); }
    finally { this.busyState.set(false); }
  }

  async send(): Promise<void> {
    if (!this.canSend()) return;
    this.busyState.set(true);
    this.errorState.set('');
    this.replyState.set('');
    try {
      const response = await this.ipc.runtimeProviderSend({
        workingDirectory: this.folder().trim(), provider: this.selected(), message: this.message().trim(),
      });
      if (!response.success || !response.data) throw new Error(response.error?.message ?? 'The provider did not answer.');
      this.replyState.set(response.data.content);
    } catch (error) { this.errorState.set(error instanceof Error ? error.message : String(error)); }
    finally { this.busyState.set(false); }
  }
}
