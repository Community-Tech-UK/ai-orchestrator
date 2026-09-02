import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { IpcFacadeService } from '../../core/services/ipc';

interface WorkspaceSecretRow {
  name: string;
  label: string;
  purpose: string;
  createdAt: number;
  lastUsedAt: number | null;
}

@Component({
  selector: 'app-workspace-secrets-panel',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-secrets-panel.component.html',
  styleUrl: './workspace-secrets-panel.component.scss',
})
export class WorkspaceSecretsPanelComponent {
  private readonly ipc = inject(IpcFacadeService);

  readonly workingDirectory = signal('');
  readonly secrets = signal<WorkspaceSecretRow[]>([]);
  readonly errorMessage = signal('');
  readonly loading = signal(false);

  async refresh(): Promise<void> {
    const cwd = this.workingDirectory().trim();
    if (!cwd) {
      this.secrets.set([]);
      return;
    }
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.ipc.listWorkspaceSecrets(cwd);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Could not list workspace secrets.');
        this.secrets.set([]);
        return;
      }
      this.secrets.set((response.data as WorkspaceSecretRow[]) ?? []);
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Could not list workspace secrets.');
      this.secrets.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  onWorkingDirectoryInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.workingDirectory.set(target.value);
  }

  async forget(name: string): Promise<void> {
    const cwd = this.workingDirectory().trim();
    if (!cwd) {
      return;
    }
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.ipc.forgetWorkspaceSecret(cwd, name);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Could not forget that secret.');
        return;
      }
      await this.refresh();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Could not forget that secret.');
    } finally {
      this.loading.set(false);
    }
  }

  async forgetAll(): Promise<void> {
    const names = this.secrets().map((row) => row.name);
    for (const name of names) {
      await this.forget(name);
    }
  }
}
