/**
 * Security Page Component
 * Secret detection, audit logging, and environment security for the AI orchestrator.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { SecurityIpcService } from '../../core/services/ipc/security-ipc.service';
import { CommandIpcService } from '../../core/services/ipc/command-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

// ─── Local interfaces ────────────────────────────────────────────────────────

interface AuditEntry {
  timestamp: number;
  action: string;
  instanceId?: string;
  target?: string;
  severity: 'info' | 'warning' | 'error';
  details?: string;
}

interface SecretResult {
  type: string;
  line?: number;
  severity: string;
  value?: string;
}

interface EnvVar {
  name: string;
  value: string;
  allowed: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-security-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './security-page.component.html',
  styleUrl: './security-page.component.scss',
})
export class SecurityPageComponent implements OnInit {
  private readonly security = inject(SecurityIpcService);
  private readonly commandIpc = inject(CommandIpcService);
  private readonly router = inject(Router);

  // ── Tab state ──────────────────────────────────────────────────────────────

  readonly activeTab = signal<'audit' | 'scanner' | 'environment' | 'bash'>('audit');

  // ── Global state ───────────────────────────────────────────────────────────

  readonly loading = signal(false);
  readonly errorMessage = signal('');

  // ── Audit log state ────────────────────────────────────────────────────────

  readonly auditEntries = signal<AuditEntry[]>([]);
  readonly auditSeverityFilter = signal<'all' | 'info' | 'warning' | 'error'>('all');
  readonly auditLimit = signal(100);

  readonly filteredAuditEntries = computed(() => {
    const filter = this.auditSeverityFilter();
    return filter === 'all'
      ? this.auditEntries()
      : this.auditEntries().filter(e => e.severity === filter);
  });

  // ── Scanner state ──────────────────────────────────────────────────────────

  readonly scanContent = signal('');
  readonly scanContentType = signal<'auto' | 'env' | 'text'>('auto');
  readonly scanning = signal(false);
  readonly scanResults = signal<SecretResult[]>([]);
  readonly scanComplete = signal(false);
  readonly redactedOutput = signal('');

  // ── Environment state ──────────────────────────────────────────────────────

  readonly envVars = signal<EnvVar[]>([]);
  readonly testVarName = signal('');
  readonly testVarValue = signal('');
  readonly testVarResult = signal('');
  readonly testVarAllowed = signal(false);
  readonly filterConfig = signal('');

  // ── Bash validation state ─────────────────────────────────────────────────

  readonly bashCommand = signal('');
  readonly bashValidationResult = signal<{ riskLevel?: string; warnings?: string[]; blocked?: boolean } | null>(null);
  readonly bashValidating = signal(false);
  readonly bashConfig = signal<{ allowedCommands?: string[]; blockedCommands?: string[] } | null>(null);
  readonly bashNewRule = signal('');

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.loadAuditLog();
    this.loadBashConfig();
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  goBack(): void {
    this.router.navigate(['/']);
  }

  // ─── Tab switching ─────────────────────────────────────────────────────────

  switchTab(tab: 'audit' | 'scanner' | 'environment' | 'bash'): void {
    this.activeTab.set(tab);
    this.errorMessage.set('');

    if (tab === 'audit') {
      this.loadAuditLog();
    } else if (tab === 'environment') {
      this.loadSafeEnv();
      this.loadFilterConfig();
    }
  }

  refresh(): void {
    const tab = this.activeTab();
    if (tab === 'audit') {
      this.loadAuditLog();
    } else if (tab === 'environment') {
      this.loadSafeEnv();
      this.loadFilterConfig();
    }
  }

  // ─── Audit log ─────────────────────────────────────────────────────────────

  async loadAuditLog(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.security.securityGetAuditLog(undefined, this.auditLimit());
      const entries = this.unwrapData<AuditEntry[]>(response, []);
      this.auditEntries.set(entries);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load audit log');
    } finally {
      this.loading.set(false);
    }
  }

  async clearAuditLog(): Promise<void> {
    this.errorMessage.set('');
    try {
      await this.security.securityClearAuditLog();
      this.auditEntries.set([]);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to clear audit log');
    }
  }

  onSeverityFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.auditSeverityFilter.set(target.value as 'all' | 'info' | 'warning' | 'error');
  }

  onLimitChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = parseInt(target.value, 10);
    if (!isNaN(value) && value > 0) {
      this.auditLimit.set(value);
      this.loadAuditLog();
    }
  }

  exportAuditCsv(): void {
    const entries = this.auditEntries();
    const csv = ['timestamp,action,instanceId,target,severity']
      .concat(
        entries.map(
          e =>
            `${new Date(e.timestamp).toISOString()},${e.action},${e.instanceId || ''},${e.target || ''},${e.severity}`
        )
      )
      .join('\n');
    this.downloadFile('audit-log.csv', csv, 'text/csv');
  }

  // ─── Secret scanner ────────────────────────────────────────────────────────

  async scanForSecrets(): Promise<void> {
    const content = this.scanContent().trim();
    if (!content) return;

    this.scanning.set(true);
    this.errorMessage.set('');
    this.scanResults.set([]);
    this.scanComplete.set(false);
    this.redactedOutput.set('');

    try {
      const response = await this.security.securityDetectSecrets(content, this.scanContentType());
      const results = this.unwrapData<SecretResult[]>(response, []);
      this.scanResults.set(results);
      this.scanComplete.set(true);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      this.scanning.set(false);
    }
  }

  async redactContent(): Promise<void> {
    const content = this.scanContent().trim();
    if (!content) return;

    this.scanning.set(true);
    this.errorMessage.set('');
    this.redactedOutput.set('');

    try {
      const response = await this.security.securityRedactContent(content, this.scanContentType());
      const redacted = this.unwrapData<string>(response, '');
      this.redactedOutput.set(redacted);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Redaction failed');
    } finally {
      this.scanning.set(false);
    }
  }

  onScanContentInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.scanContent.set(target.value);
    // Reset results when content changes
    this.scanComplete.set(false);
    this.scanResults.set([]);
    this.redactedOutput.set('');
  }

  onContentTypeChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.scanContentType.set(target.value as 'auto' | 'env' | 'text');
  }

  // ─── Environment ───────────────────────────────────────────────────────────

  async loadSafeEnv(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const response = await this.security.securityGetSafeEnv();
      const raw = this.unwrapData<Record<string, string> | EnvVar[]>(response, {});

      // Normalize: backend may return a flat record or an array
      if (Array.isArray(raw)) {
        this.envVars.set(raw);
      } else {
        const vars: EnvVar[] = Object.entries(raw).map(([name, value]) => ({
          name,
          value: String(value),
          allowed: true
        }));
        this.envVars.set(vars);
      }
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load environment');
    } finally {
      this.loading.set(false);
    }
  }

  async loadFilterConfig(): Promise<void> {
    this.errorMessage.set('');
    try {
      const response = await this.security.securityGetEnvFilterConfig();
      const config = this.unwrapData<unknown>(response, null);
      this.filterConfig.set(config != null ? JSON.stringify(config, null, 2) : '');
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load filter config');
    }
  }

  async checkEnvVar(): Promise<void> {
    const name = this.testVarName().trim();
    const value = this.testVarValue();
    if (!name) return;

    this.errorMessage.set('');
    this.testVarResult.set('');

    try {
      const response = await this.security.securityCheckEnvVar(name, value);
      const result = this.unwrapData<{ allowed: boolean; reason?: string }>(response, { allowed: false });
      this.testVarAllowed.set(result.allowed);
      this.testVarResult.set(
        result.allowed
          ? `${name} is allowed`
          : `${name} is blocked${result.reason ? ': ' + result.reason : ''}`
      );
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Check failed');
    }
  }

  onTestVarNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.testVarName.set(target.value);
    this.testVarResult.set('');
  }

  onTestVarValueInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.testVarValue.set(target.value);
    this.testVarResult.set('');
  }

  // ─── Bash Validation ───────────────────────────────────────────────────────

  async loadBashConfig(): Promise<void> {
    try {
      const response = await this.commandIpc.bashGetConfig();
      this.bashConfig.set(this.unwrapData<{ allowedCommands?: string[]; blockedCommands?: string[] } | null>(response, null));
    } catch {
      // best-effort
    }
  }

  async validateBashCommand(): Promise<void> {
    const cmd = this.bashCommand().trim();
    if (!cmd) return;

    this.bashValidating.set(true);
    this.errorMessage.set('');
    this.bashValidationResult.set(null);

    try {
      const response = await this.commandIpc.bashValidate(cmd);
      this.bashValidationResult.set(
        this.unwrapData<{ riskLevel?: string; warnings?: string[]; blocked?: boolean } | null>(response, null)
      );
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      this.bashValidating.set(false);
    }
  }

  async addBashAllowed(): Promise<void> {
    const cmd = this.bashNewRule().trim();
    if (!cmd) return;
    try {
      await this.commandIpc.bashAddAllowed(cmd);
      this.bashNewRule.set('');
      await this.loadBashConfig();
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to add allowed command');
    }
  }

  async addBashBlocked(): Promise<void> {
    const cmd = this.bashNewRule().trim();
    if (!cmd) return;
    try {
      await this.commandIpc.bashAddBlocked(cmd);
      this.bashNewRule.set('');
      await this.loadBashConfig();
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to add blocked command');
    }
  }

  onBashCommandInput(event: Event): void {
    this.bashCommand.set((event.target as HTMLInputElement).value);
    this.bashValidationResult.set(null);
  }

  onBashNewRuleInput(event: Event): void {
    this.bashNewRule.set((event.target as HTMLInputElement).value);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  formatTimestamp(ts: number): string {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }

  maskValue(value: string): string {
    if (!value || value.length <= 4) return '****';
    return value.slice(0, 2) + '****' + value.slice(-2);
  }

  getSeverityClass(severity: string): string {
    const s = severity?.toLowerCase();
    if (s === 'error' || s === 'high' || s === 'critical') return 'badge-error';
    if (s === 'warning' || s === 'medium') return 'badge-warning';
    return 'badge-info';
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }

  private downloadFile(filename: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
