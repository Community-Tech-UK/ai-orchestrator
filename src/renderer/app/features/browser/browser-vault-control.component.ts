import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { BrowserUnattendedStore } from './browser-unattended.store';
import type { BrowserVaultUnlockReason } from './browser-unattended.types';

const UNLOCK_REASON_LABELS: Record<BrowserVaultUnlockReason, string> = {
  empty_password:
    'No vault master password is configured. Set the local password-file source in Settings first.',
  bw_unlock_failed: 'Bitwarden CLI unlock failed. Check the vault is reachable and the password is correct.',
  empty_session: 'Bitwarden did not return a session token. Try unlocking again.',
};

export function vaultUnlockReasonLabel(reason: BrowserVaultUnlockReason | null): string | null {
  if (!reason) {
    return null;
  }
  return UNLOCK_REASON_LABELS[reason] ?? `Unlock failed (${reason}).`;
}

@Component({
  selector: 'app-browser-vault-control',
  standalone: true,
  imports: [],
  templateUrl: './browser-vault-control.component.html',
  styleUrl: './browser-vault-control.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserVaultControlComponent implements OnInit {
  private readonly store = inject(BrowserUnattendedStore);

  readonly status = this.store.vaultStatus;
  readonly busy = this.store.vaultBusy;

  readonly reasonLabel = computed(() => vaultUnlockReasonLabel(this.store.vaultUnlockReason()));

  ngOnInit(): void {
    void this.store.refreshVaultStatus();
  }

  async unlock(): Promise<void> {
    await this.store.unlockVault();
  }

  async lock(): Promise<void> {
    await this.store.lockVault();
  }
}
