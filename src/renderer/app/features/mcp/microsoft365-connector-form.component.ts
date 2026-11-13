import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import { ORCHESTRATOR_INJECTION_PROVIDERS, type OrchestratorRuntimeInjectionProvider } from '../../../../shared/types/mcp-scopes.types';
import { providerName } from '../../../../shared/display-names';
import { presentError } from '../../../../shared/present-error';

@Component({
  selector: 'app-microsoft365-connector-form',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './microsoft365-connector-form.component.html',
  styleUrl: './microsoft365-connector-form.component.scss',
})
export class Microsoft365ConnectorFormComponent {
  private readonly ipc = inject(McpIpcService);
  readonly existingNames = input<readonly string[]>([]);
  readonly added = output<string>();
  readonly cancelled = output<void>();
  readonly busyChange = output<boolean>();
  readonly nickname = signal('');
  readonly mailEnabled = signal(true);
  readonly providers = signal<readonly OrchestratorRuntimeInjectionProvider[]>([...ORCHESTRATOR_INJECTION_PROVIDERS]);
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  readonly errorDetails = signal<string | null>(null);
  readonly availableProviders = ORCHESTRATOR_INJECTION_PROVIDERS;
  readonly providerLabel = providerName;

  toggleProvider(provider: OrchestratorRuntimeInjectionProvider, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.providers.update(current => checked ? [...new Set([...current, provider])] : current.filter(value => value !== provider));
  }

  async connect(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending()) return;
    this.error.set(null);
    this.errorDetails.set(null);
    if (!this.providers().length) {
      this.error.set('Choose at least one AI tool under Session settings.');
      return;
    }
    const label = this.nickname().trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    if (this.nickname().trim() && !label) {
      this.error.set('Use at least one letter or number for the account nickname.');
      return;
    }
    const base = `m365-${label || 'account'}`;
    const existing = new Set(this.existingNames().map(name => name.toLowerCase()));
    let name = base;
    for (let suffix = 2; existing.has(name); suffix++) name = `${base}-${suffix}`;

    this.pending.set(true);
    this.busyChange.emit(true);
    let username: string | undefined;
    try {
      const response = await this.ipc.connectorAddMicrosoft365({ name, mailEnabled: this.mailEnabled(), injectInto: this.providers() });
      if (!response.success) {
        this.error.set('Microsoft 365 could not connect. Finish the sign-in or ask your organisation’s IT team if approval is required, then try again.');
        this.errorDetails.set(presentError(response.error).rawDetail || null);
      } else {
        username = (response.data as { username: string }).username;
      }
    } catch (error) {
      this.error.set('Microsoft 365 could not connect. Try again.');
      this.errorDetails.set(presentError(error).rawDetail || null);
    } finally {
      this.pending.set(false);
      this.busyChange.emit(false);
    }
    if (username) this.added.emit(username);
  }
}
