import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import type { SupportedProvider } from '../../../../shared/types/mcp-scopes.types';
import { SUPPORTED_PROVIDERS } from '../../../../shared/types/mcp-scopes.types';
import type { WorkspaceMcpConnectorDto } from '../../../../shared/types/workspace-mcp-connector.types';

@Component({
  selector: 'app-workspace-mcp-connectors-panel',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-mcp-connectors-panel.component.html',
  styleUrl: './workspace-mcp-connectors-panel.component.scss',
})
export class WorkspaceMcpConnectorsPanelComponent {
  private readonly mcpIpc = inject(McpIpcService);

  readonly providers = SUPPORTED_PROVIDERS;
  readonly workingDirectory = signal('');
  readonly provider = signal<SupportedProvider>('claude');
  readonly connectors = signal<WorkspaceMcpConnectorDto[]>([]);
  readonly errorMessage = signal('');
  readonly loading = signal(false);
  readonly name = signal('');
  readonly command = signal('');
  readonly envJson = signal('{"API_TOKEN":"secret://example"}');

  onWorkingDirectoryInput(event: Event): void {
    this.workingDirectory.set((event.target as HTMLInputElement).value);
  }

  onProviderChange(event: Event): void {
    this.provider.set((event.target as HTMLSelectElement).value as SupportedProvider);
  }

  onNameInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  onCommandInput(event: Event): void {
    this.command.set((event.target as HTMLInputElement).value);
  }

  onEnvInput(event: Event): void {
    this.envJson.set((event.target as HTMLTextAreaElement).value);
  }

  async refresh(): Promise<void> {
    const cwd = this.workingDirectory().trim();
    if (!cwd) {
      this.connectors.set([]);
      return;
    }
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.mcpIpc.workspaceConnectorList({
        workingDirectory: cwd,
        provider: this.provider(),
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Could not list workspace connectors.');
        this.connectors.set([]);
        return;
      }
      this.connectors.set((response.data as WorkspaceMcpConnectorDto[]) ?? []);
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Could not list workspace connectors.');
      this.connectors.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    const cwd = this.workingDirectory().trim();
    if (!cwd || !this.name().trim() || !this.command().trim()) {
      this.errorMessage.set('Working directory, name, and command are required.');
      return;
    }
    let env: Record<string, string> | undefined;
    try {
      const parsed = JSON.parse(this.envJson() || '{}') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        env = parsed as Record<string, string>;
      }
    } catch {
      this.errorMessage.set('Env must be a JSON object of string values.');
      return;
    }
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.mcpIpc.workspaceConnectorUpsert({
        workingDirectory: cwd,
        provider: this.provider(),
        name: this.name().trim(),
        transport: 'stdio',
        command: this.command().trim(),
        env,
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Could not save the workspace connector.');
        return;
      }
      await this.refresh();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Could not save the workspace connector.');
    } finally {
      this.loading.set(false);
    }
  }

  async remove(id: string): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.mcpIpc.workspaceConnectorDelete(id);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Could not delete the workspace connector.');
        return;
      }
      await this.refresh();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Could not delete the workspace connector.');
    } finally {
      this.loading.set(false);
    }
  }
}
