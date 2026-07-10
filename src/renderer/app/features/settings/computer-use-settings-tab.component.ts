/**
 * Computer Use Settings Tab
 *
 * Management surface for Harness Computer Use (desktop gateway, macOS v1):
 * the enable toggle and policy settings, live driver/permission health with
 * setup shortcuts, discovered apps, active grants (with revoke), and the audit
 * log. Runtime grant approvals ride the generic permission approval card, so
 * this tab is diagnostics + policy, not an approval queue.
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
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import { DesktopGatewayIpcService } from '../../core/services/ipc/desktop-gateway-ipc.service';
import type { AppSettings } from '../../../../shared/types/settings.types';
import type {
  DesktopAppDescriptor,
  DesktopAuditEntry,
  DesktopCapabilityState,
  DesktopGrantSummary,
  DesktopHealthData,
} from '../../../../shared/types/desktop-gateway.types';

const COMPUTER_USE_SETTING_KEYS = new Set<string>([
  'computerUseEnabled',
  'computerUseAllowedAppsJson',
  'computerUseDeniedAppsJson',
  'computerUseRequireApprovalForInput',
  'computerUseStoreScreenshotsForEscalations',
]);

interface CapabilityRow {
  label: string;
  state: DesktopCapabilityState;
  permission?: 'screen-recording' | 'accessibility';
}

@Component({
  standalone: true,
  selector: 'app-computer-use-settings-tab',
  imports: [CommonModule, SettingRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './computer-use-settings-tab.component.html',
  styleUrl: './computer-use-settings-tab.component.scss',
})
export class ComputerUseSettingsTabComponent implements OnInit {
  readonly store = inject(SettingsStore);
  private readonly desktop = inject(DesktopGatewayIpcService);

  readonly settingRows = computed(() =>
    this.store.metadata.filter((meta) => COMPUTER_USE_SETTING_KEYS.has(meta.key) && !meta.hidden),
  );

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly health = signal<DesktopHealthData | null>(null);
  readonly apps = signal<DesktopAppDescriptor[]>([]);
  readonly grants = signal<DesktopGrantSummary[]>([]);
  readonly auditEntries = signal<DesktopAuditEntry[]>([]);

  readonly capabilityRows = computed<CapabilityRow[]>(() => {
    const health = this.health();
    if (!health) {
      return [];
    }
    return [
      { label: 'Screen Recording', state: health.screenCapture, permission: 'screen-recording' },
      { label: 'Accessibility', state: health.accessibility, permission: 'accessibility' },
      { label: 'Input synthesis', state: health.input },
    ];
  });

  readonly setupActions = computed(() => this.health()?.setupActions ?? []);

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [health, apps, grants, audit] = await Promise.all([
        this.desktop.getHealth(),
        this.desktop.listApps(),
        this.desktop.listGrants({ includeExpired: true }),
        this.desktop.getAuditLog({ limit: 100 }),
      ]);
      if (health.success && health.data?.data) {
        this.health.set(health.data.data);
      }
      if (apps.success && apps.data?.data) {
        this.apps.set(apps.data.data.apps);
      }
      if (grants.success && grants.data?.data) {
        this.grants.set(grants.data.data.grants);
      }
      if (audit.success && audit.data?.data) {
        this.auditEntries.set(audit.data.data.entries);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
    // Health injectability depends on the enable flag; refresh after a change.
    void this.refresh();
  }

  async openPermission(permission: 'screen-recording' | 'accessibility'): Promise<void> {
    await this.desktop.openPermissionSettings(permission);
  }

  async revokeGrant(grantId: string): Promise<void> {
    const response = await this.desktop.revokeGrant({ grantId, reason: 'Revoked from Settings' });
    if (response.success) {
      await this.refresh();
    } else {
      this.error.set(response.error?.message ?? 'Failed to revoke grant');
    }
  }

  capabilityLabel(state: CapabilityRow['state']): string {
    switch (state) {
      case 'available':
        return 'Ready';
      case 'missing_permission':
        return 'Permission needed';
      case 'unsupported':
        return 'Unsupported';
      default:
        return 'Unavailable';
    }
  }

  formatTimestamp(value: number): string {
    if (!value || value >= Number.MAX_SAFE_INTEGER) {
      return 'Never expires';
    }
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  }

  grantStatus(grant: DesktopGrantSummary): string {
    if (grant.revokedAt) {
      return 'Revoked';
    }
    if (grant.expiresAt <= Date.now()) {
      return 'Expired';
    }
    return 'Active';
  }
}
