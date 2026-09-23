import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { IpcFacadeService } from '../../core/services/ipc';

interface WorkspaceSecretRow {
  name: string;
  label: string;
  purpose: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface WorkspaceSecretAuditRow {
  id: string;
  secretName: string;
  event: 'created' | 'updated' | 'resolved' | 'declined' | 'forgotten';
  instanceId: string | null;
  purpose: string;
  at: number;
}

@Component({
  selector: 'app-workspace-secrets-panel',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-secrets-panel.component.html',
  styleUrl: './workspace-secrets-panel.component.scss',
})
export class WorkspaceSecretsPanelComponent {
  private readonly ipc = inject(IpcFacadeService);
  private refreshGeneration = 0;

  readonly workingDirectory = signal('');
  readonly secrets = signal<WorkspaceSecretRow[]>([]);
  readonly audit = signal<WorkspaceSecretAuditRow[]>([]);
  readonly errorMessage = signal('');
  readonly loading = signal(false);

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const cwd = this.workingDirectory().trim();
    if (!cwd) {
      this.secrets.set([]);
      this.audit.set([]);
      return;
    }
    this.loading.set(true);
    this.errorMessage.set('');
    this.secrets.set([]);
    this.audit.set([]);
    try {
      const [secretsResult, auditResult] = await Promise.allSettled([
        this.ipc.listWorkspaceSecrets(cwd),
        this.ipc.getWorkspaceSecretAudit(cwd, 100),
      ]);
      if (generation !== this.refreshGeneration) return;
      if (secretsResult.status === 'rejected') {
        throw secretsResult.reason;
      }
      const secretsResponse = secretsResult.value;
      if (!secretsResponse.success) {
        this.errorMessage.set(secretsResponse.error?.message ?? 'Could not list workspace secrets.');
        return;
      }
      this.secrets.set((secretsResponse.data as WorkspaceSecretRow[]) ?? []);
      if (auditResult.status === 'rejected') {
        this.errorMessage.set(auditResult.reason instanceof Error
          ? auditResult.reason.message : 'Could not load workspace secret history.');
      } else if (auditResult.value.success) {
        this.audit.set((auditResult.value.data as WorkspaceSecretAuditRow[]) ?? []);
      } else {
        this.errorMessage.set(auditResult.value.error?.message ?? 'Could not load workspace secret history.');
      }
    } catch (error) {
      if (generation !== this.refreshGeneration) return;
      this.errorMessage.set(error instanceof Error ? error.message : 'Could not load workspace secrets.');
      this.secrets.set([]);
      this.audit.set([]);
    } finally {
      if (generation === this.refreshGeneration) this.loading.set(false);
    }
  }

  onWorkingDirectoryInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.value !== this.workingDirectory()) {
      this.refreshGeneration++;
      this.loading.set(false);
      this.secrets.set([]);
      this.audit.set([]);
    }
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
