import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { BrowserProfile } from '@contracts/types/browser';
import { BrowserUnattendedStore } from './browser-unattended.store';
import type {
  CredentialAuthorizationOrigin,
  CredentialPurpose,
} from './browser-unattended.types';

const EXPIRY_PRESETS_DAYS = [30, 90, 365] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALL_PURPOSES: CredentialPurpose[] = ['login', 'register', 'totp', 'email_code'];

function blankOriginRow(): CredentialAuthorizationOrigin {
  return { scheme: 'https', hostPattern: '', includeSubdomains: false };
}

@Component({
  selector: 'app-browser-credential-authorization-panel',
  standalone: true,
  imports: [],
  templateUrl: './browser-credential-authorization-panel.component.html',
  styleUrl: './browser-credential-authorization-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserCredentialAuthorizationPanelComponent implements OnInit {
  private readonly store = inject(BrowserUnattendedStore);

  readonly profiles = input<BrowserProfile[]>([]);

  readonly authorizations = this.store.authorizations;
  readonly busy = this.store.busy;
  readonly errorMessage = this.store.errorMessage;
  readonly validationError = signal<string | null>(null);

  readonly allPurposes = ALL_PURPOSES;
  readonly expiryPresets = EXPIRY_PRESETS_DAYS;

  readonly selectedProfileId = signal('');
  readonly originRows = signal<CredentialAuthorizationOrigin[]>([blankOriginRow()]);
  readonly selectedPurposes = signal<Set<CredentialPurpose>>(new Set());
  readonly vaultFolder = signal('AIO-Agent');
  readonly expiryPresetDays = signal<number>(90);
  readonly note = signal('');

  constructor() {
    effect(() => {
      const profiles = this.profiles();
      if (!this.selectedProfileId() && profiles.length > 0) {
        this.selectedProfileId.set(profiles[0]!.id);
      }
    });
  }

  ngOnInit(): void {
    void this.store.refreshAuthorizations();
  }

  onProfileChange(event: Event): void {
    this.selectedProfileId.set((event.target as HTMLSelectElement).value);
  }

  addOriginRow(): void {
    this.originRows.update((rows) => [...rows, blankOriginRow()]);
  }

  removeOriginRow(index: number): void {
    this.originRows.update((rows) => rows.filter((_, i) => i !== index));
  }

  onOriginSchemeChange(index: number, event: Event): void {
    const scheme = (event.target as HTMLSelectElement).value as 'https' | 'http';
    this.updateOriginRow(index, (row) => ({ ...row, scheme }));
  }

  onOriginHostInput(index: number, event: Event): void {
    const hostPattern = (event.target as HTMLInputElement).value;
    this.updateOriginRow(index, (row) => ({ ...row, hostPattern }));
  }

  onOriginSubdomainsChange(index: number, event: Event): void {
    const includeSubdomains = (event.target as HTMLInputElement).checked;
    this.updateOriginRow(index, (row) => ({ ...row, includeSubdomains }));
  }

  togglePurpose(purpose: CredentialPurpose): void {
    this.selectedPurposes.update((current) => {
      const next = new Set(current);
      if (next.has(purpose)) {
        next.delete(purpose);
      } else {
        next.add(purpose);
      }
      return next;
    });
  }

  isPurposeSelected(purpose: CredentialPurpose): boolean {
    return this.selectedPurposes().has(purpose);
  }

  onVaultFolderInput(event: Event): void {
    this.vaultFolder.set((event.target as HTMLInputElement).value);
  }

  onNoteInput(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  setExpiryPreset(days: number): void {
    this.expiryPresetDays.set(days);
  }

  async submit(): Promise<void> {
    this.validationError.set(null);
    const profileId = this.selectedProfileId();
    if (!profileId) {
      this.validationError.set('Select a profile.');
      return;
    }

    const allowedOrigins = this.originRows()
      .map((row) => ({ ...row, hostPattern: row.hostPattern.trim() }))
      .filter((row) => row.hostPattern.length > 0);
    if (allowedOrigins.length === 0) {
      this.validationError.set('At least one allowed origin is required.');
      return;
    }

    const purposes = Array.from(this.selectedPurposes());
    if (purposes.length === 0) {
      this.validationError.set('At least one purpose is required.');
      return;
    }

    const vaultFolder = this.vaultFolder().trim() || 'AIO-Agent';
    const note = this.note().trim();
    const expiresAt = Date.now() + this.expiryPresetDays() * DAY_MS;

    const created = await this.store.createAuthorization({
      profileId,
      allowedOrigins,
      purposes,
      vaultFolder,
      expiresAt,
      ...(note ? { note } : {}),
    });
    if (created) {
      this.resetForm();
    }
  }

  async revoke(authorizationId: string): Promise<void> {
    await this.store.revokeAuthorization(authorizationId);
  }

  formatOrigins(origins: CredentialAuthorizationOrigin[]): string {
    return origins
      .map((origin) => `${origin.scheme}://${origin.includeSubdomains ? '*.' : ''}${origin.hostPattern}`)
      .join(', ');
  }

  formatExpiry(expiresAt: number): string {
    return new Date(expiresAt).toLocaleDateString();
  }

  private updateOriginRow(
    index: number,
    update: (row: CredentialAuthorizationOrigin) => CredentialAuthorizationOrigin,
  ): void {
    this.originRows.update((rows) => rows.map((row, i) => (i === index ? update(row) : row)));
  }

  private resetForm(): void {
    this.originRows.set([blankOriginRow()]);
    this.selectedPurposes.set(new Set());
    this.vaultFolder.set('AIO-Agent');
    this.note.set('');
  }
}
