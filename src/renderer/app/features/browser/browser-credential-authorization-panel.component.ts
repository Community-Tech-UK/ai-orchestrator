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
  /** Comma/space separated; only meaningful when 'email_code' is selected. */
  readonly senderDomains = signal('');

  /**
   * Shared existing Chrome tabs authorize by NODE scope, not by a managed
   * profile id: a tab's own profileId is per-tab and ephemeral. Offering the
   * node scopes here is what makes an authorization for the user's real browser
   * possible at all — previously only managed profiles could be selected, so a
   * shared-tab fill could never find a matching record.
   */
  readonly sharedTabScopes = input<{ id: string; label: string }[]>([]);

  /** Enrol-an-existing-login form. */
  readonly enrolItem = signal('');
  readonly enrolOrigin = signal('');
  readonly enrolMoveIntoFolder = signal(false);
  readonly enrolResult = signal<{ vaultItemRef: string; username: string; movedIntoFolder: boolean } | null>(
    null,
  );
  readonly enrolError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const profiles = this.profiles();
      const scopes = this.sharedTabScopes();
      if (this.selectedProfileId()) {
        return;
      }
      if (profiles.length > 0) {
        this.selectedProfileId.set(profiles[0]!.id);
      } else if (scopes.length > 0) {
        // With no managed profile the form used to be unusable; a shared-tab
        // scope is a valid authorization target on its own.
        this.selectedProfileId.set(scopes[0]!.id);
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

  onSenderDomainsInput(event: Event): void {
    this.senderDomains.set((event.target as HTMLInputElement).value);
  }

  onEnrolItemInput(event: Event): void {
    this.enrolItem.set((event.target as HTMLInputElement).value);
  }

  onEnrolOriginInput(event: Event): void {
    this.enrolOrigin.set((event.target as HTMLInputElement).value);
  }

  onEnrolMoveIntoFolderChange(event: Event): void {
    this.enrolMoveIntoFolder.set((event.target as HTMLInputElement).checked);
  }

  /**
   * Bind an existing vault login to an origin. Required for any account that
   * was registered by hand: without a binding the vault refuses to resolve its
   * secret, so an authorization alone can never fill it.
   */
  async enrol(): Promise<void> {
    this.enrolError.set(null);
    this.enrolResult.set(null);
    const item = this.enrolItem().trim();
    const origin = this.enrolOrigin().trim();
    if (!item) {
      this.enrolError.set('Enter the vault item name or id.');
      return;
    }
    if (!origin) {
      this.enrolError.set('Enter the origin to bind to, e.g. https://auth.portal.gov.uk');
      return;
    }
    const result = await this.store.enrolCredential({
      item,
      origin,
      moveIntoFolder: this.enrolMoveIntoFolder(),
    });
    if (!result) {
      this.enrolError.set(this.store.errorMessage() ?? 'Failed to enrol the credential.');
      return;
    }
    this.enrolResult.set(result);
    this.enrolItem.set('');
    this.enrolOrigin.set('');
    this.enrolMoveIntoFolder.set(false);
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
    const allowedSenderDomains = this.senderDomains()
      .split(/[\s,]+/)
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length > 0);

    const created = await this.store.createAuthorization({
      profileId,
      allowedOrigins,
      purposes,
      vaultFolder,
      expiresAt,
      ...(note ? { note } : {}),
      ...(allowedSenderDomains.length > 0 ? { allowedSenderDomains } : {}),
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
    this.senderDomains.set('');
  }
}
