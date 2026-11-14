/**
 * Mobile Settings Tab
 * Enable the mobile gateway, pair a phone (QR), and manage paired devices.
 */

import { ConfirmService } from '../../shared/confirm/confirm.service';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MobileGatewayIpcService,
  type MobilePairingResult,
} from '../../core/services/ipc/mobile-gateway-ipc.service';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import { presentError } from '../../../../shared/present-error';
import { MobilePeopleStore } from '../../core/state/mobile-people.store';
import {
  MOBILE_OWNER_PROFILE_ID,
  type MobileGatewayStatus,
  type MobileDeviceSummary,
  type MobileMemberProfile,
  type MobilePeopleOverview,
} from '../../../../shared/types/mobile-gateway.types';

/** What is typed in for one person's sessions before it is saved. */
interface PersonDraft {
  workerNodeId: string;
  workingDirectory: string;
  accountIds: string[];
}

@Component({
  standalone: true,
  selector: 'app-mobile-settings-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="mobile-tab">
      @if (error()) {
        <div class="banner error">{{ error() }}</div>
      }

      <div class="card">
        <div class="status-line">
          <span class="dot" [class.on]="status()?.running"></span>
          <strong>{{ status()?.running ? 'Gateway running' : 'Gateway stopped' }}</strong>
          @if (status()?.running && status()?.tailnetUrl) {
            <code>{{ status()?.tailnetUrl }}</code>
          }
        </div>

        @if (!tailscaleReady()) {
          <p class="hint warn">
            No Tailscale address detected. Start Tailscale on this Mac (and your iPhone, same
            tailnet) so the phone can reach the gateway from anywhere.
          </p>
        }

        <button class="primary" (click)="toggle()" [disabled]="busy()">
          {{ busy() ? 'Working…' : status()?.running ? 'Stop gateway' : 'Start gateway' }}
        </button>
      </div>

      <div class="card">
        <div class="status-line">
          <span class="dot" [class.on]="status()?.pushConfigured"></span>
          <strong>Push notifications (APNs)</strong>
        </div>
        <p class="hint">
          Get pinged on your phone when an agent needs your approval, even when the app is closed.
          Paste your Apple Push <code>.p8</code> Auth Key and IDs from the Apple Developer account.
          Push delivers over Apple's network independently of Tailscale.
        </p>

        <label class="field">
          <span>Auth Key (.p8 contents)</span>
          <textarea
            rows="4"
            [ngModel]="apnsKeyP8()"
            (ngModelChange)="apnsKeyP8.set($event)"
            [placeholder]="apnsHasKey() ? '•••• key stored — paste a new one to replace ••••' : '-----BEGIN PRIVATE KEY-----\\n…'"
          ></textarea>
        </label>
        <div class="grid">
          <label class="field">
            <span>Key ID</span>
            <input [ngModel]="apnsKeyId()" (ngModelChange)="apnsKeyId.set($event)" placeholder="ABCDE12345" />
          </label>
          <label class="field">
            <span>Team ID</span>
            <input [ngModel]="apnsTeamId()" (ngModelChange)="apnsTeamId.set($event)" placeholder="TEAM123456" />
          </label>
        </div>
        <label class="field">
          <span>Bundle ID (APNs topic)</span>
          <input
            [ngModel]="apnsBundleId()"
            (ngModelChange)="apnsBundleId.set($event)"
            placeholder="com.shutupandshave.aiorchestrator"
          />
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            [ngModel]="apnsProduction()"
            (ngModelChange)="apnsProduction.set($event)"
          />
          <span>Production APNs endpoint (uncheck while testing with a development build)</span>
        </label>
        <button (click)="saveApns()" [disabled]="apnsBusy()">
          {{ apnsBusy() ? 'Saving…' : apnsSaved() ? 'Saved' : 'Save push settings' }}
        </button>
      </div>

      <div class="card">
        <div class="status-line">
          <span class="dot" [class.on]="status()?.secure"></span>
          <strong>Secure connection (TLS / wss)</strong>
        </div>
        <p class="hint">
          Optional. Tailscale already encrypts the link end-to-end, so this is extra hardening.
          Generate a publicly-trusted cert with
          <code>tailscale cert &lt;this-mac&gt;.&lt;tailnet&gt;.ts.net</code>
          and point these at the resulting <code>.crt</code> and <code>.key</code> files. The phone
          then connects over <code>wss://</code> by the cert's hostname with no trust prompt.
          Leave blank for plain <code>ws://</code>. Restart the gateway after changing.
        </p>
        @if (status()?.secure && status()?.tlsHostname) {
          <p class="hint">Serving TLS for <code>{{ status()?.tlsHostname }}</code>.</p>
        }
        <label class="field">
          <span>Certificate file (.crt / fullchain.pem)</span>
          <input
            [ngModel]="tlsCertPath()"
            (ngModelChange)="tlsCertPath.set($event)"
            placeholder="/Users/you/certs/mac.tailnet.ts.net.crt"
          />
        </label>
        <label class="field">
          <span>Private key file (.key)</span>
          <input
            [ngModel]="tlsKeyPath()"
            (ngModelChange)="tlsKeyPath.set($event)"
            placeholder="/Users/you/certs/mac.tailnet.ts.net.key"
          />
        </label>
        <button (click)="saveTls()" [disabled]="tlsBusy()">
          {{ tlsBusy() ? 'Saving…' : tlsSaved() ? 'Saved' : 'Save TLS settings' }}
        </button>
      </div>

      <div class="card">
        <h3>People</h3>
        <p class="hint">
          Each person sees only their own sessions in the phone app. Their sessions run on a computer
          kept for them, in a folder you choose, and only on the accounts you tick. Those sessions use
          your accounts, count against your limits and run without asking for approval first, because
          the computer is theirs alone.
        </p>
        @for (person of members(); track person.profileId) {
          <div class="person">
            <div class="person-head">
              <strong>{{ person.name }}</strong>
              <button class="danger" (click)="removePerson(person)">Remove {{ person.name }}</button>
            </div>
            @if (!person.session) {
              <p class="hint warn">Not set up yet. They cannot start sessions until you choose a computer, a folder and an account.</p>
            }
            <label class="field">
              <span>Computer</span>
              <select
                [ngModel]="draftFor(person).workerNodeId"
                (ngModelChange)="updateDraft(person, { workerNodeId: $event })"
              >
                <option value="">Choose a computer</option>
                @for (computer of computers(); track computer.id) {
                  <option [value]="computer.id">{{ computer.name }}{{ computer.online ? '' : ' (offline)' }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>Folder on that computer</span>
              <input
                [ngModel]="draftFor(person).workingDirectory"
                (ngModelChange)="updateDraft(person, { workingDirectory: $event })"
                placeholder="/home/cyntia/work"
              />
            </label>
            <div class="field">
              <span>Accounts they may use</span>
              @for (account of accounts(); track account.id) {
                <label class="checkbox">
                  <input
                    type="checkbox"
                    [ngModel]="draftFor(person).accountIds.includes(account.id)"
                    (ngModelChange)="toggleAccount(person, account.id, $event)"
                  />
                  <span>{{ account.label }} ({{ account.provider === 'claude' ? 'Claude' : 'Codex' }})</span>
                </label>
              } @empty {
                <span class="hint">No Claude or Codex accounts are set up.</span>
              }
            </div>
            <button (click)="savePerson(person)" [disabled]="!canSave(person) || savingPerson() === person.profileId">
              {{ savingPerson() === person.profileId ? 'Saving…' : savedPerson() === person.profileId ? 'Saved' : 'Save choices' }}
            </button>
            @if (!canSave(person)) {
              <span class="hint">Choose a computer, a folder and at least one account to save.</span>
            }
          </div>
        } @empty {
          <p class="hint">Only you use the phone app so far.</p>
        }
        <div class="add-person">
          <input
            [ngModel]="newPersonName()"
            (ngModelChange)="newPersonName.set($event)"
            placeholder="Name"
            aria-label="Name of the person to add"
          />
          <button (click)="addPerson()" [disabled]="!newPersonName().trim()">Add person</button>
        </div>
      </div>

      @if (status()?.running) {
        <div class="card">
          <h3>Pair a phone</h3>
          <p class="hint">
            Generate a one-time code, then scan it in the Harness phone app.
          </p>
          @if (members().length > 0) {
            <label class="field">
              <span>Whose phone</span>
              <select [ngModel]="pairingProfileId()" (ngModelChange)="pairingProfileId.set($event); pairing.set(null)">
                <option [value]="ownerProfileId">Mine</option>
                @for (person of members(); track person.profileId) {
                  <option [value]="person.profileId">{{ person.name }}</option>
                }
              </select>
            </label>
          }
          <button (click)="generatePairing()" [disabled]="pairingBusy()">
            {{ pairingBusy() ? 'Generating…' : 'Generate pairing code' }}
          </button>

          @if (pairing(); as p) {
            <div class="pairing">
              <img class="qr" [src]="p.qrDataUrl" alt="Pairing QR code" />
              <div class="pairing-meta">
                <code class="addr">{{ p.host }}:{{ p.port }}</code>
                <span class="hint">Expires {{ formatExpiry(p.expiresAt) }}</span>
                <span class="hint">Or paste this connection code into the phone app:</span>
                <code class="conn-code">{{ connectionCode(p) }}</code>
                <button (click)="copyCode(p)">{{ copied() ? 'Copied' : 'Copy connection code' }}</button>
              </div>
            </div>
          }
        </div>

        <div class="card">
          <h3>Paired devices ({{ devices().length }})</h3>
          @if (devices().length === 0) {
            <p class="hint">No phones paired yet.</p>
          } @else {
            @for (device of devices(); track device.deviceId) {
              <div class="device-row">
                <div class="device-info">
                  <strong>{{ device.label }}{{ deviceOwnerSuffix(device) }}</strong>
                  <span class="meta">
                    last seen {{ formatRelativeTime(device.lastSeenAt) }} ·
                    expires {{ formatExpiry(device.expiresAt) }}
                  </span>
                </div>
                <button class="danger" (click)="revoke(device)">Revoke</button>
              </div>
            }
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .mobile-tab { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
      .card {
        background: var(--surface-2, #1c1c1e);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      h3 { margin: 0; font-size: 15px; }
      .status-line { display: flex; align-items: center; gap: 10px; }
      .status-line code { color: var(--text-secondary, #8e8e93); font-size: 13px; }
      .dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: var(--text-secondary, #8e8e93);
      }
      .dot.on { background: #34c759; }
      .hint { color: var(--text-secondary, #8e8e93); font-size: 13px; margin: 0; }
      .hint.warn { color: #ff9f0a; }
      button {
        align-self: flex-start;
        padding: 8px 16px;
        border-radius: 8px;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        background: var(--surface-3, #2c2c2e);
        color: var(--text, #fff);
        cursor: pointer;
        font-size: 14px;
      }
      button:disabled { opacity: 0.5; cursor: default; }
      button.primary { background: #0a84ff; border-color: #0a84ff; }
      button.danger { background: transparent; border-color: #ff453a; color: #ff453a; padding: 6px 12px; }
      .banner.error {
        background: rgba(255, 69, 58, 0.15);
        border: 1px solid #ff453a;
        color: #ff453a;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 13px;
      }
      .pairing { display: flex; gap: 16px; align-items: center; }
      .qr { width: 180px; height: 180px; border-radius: 8px; background: #fff; padding: 8px; }
      .pairing-meta { display: flex; flex-direction: column; gap: 6px; max-width: 360px; }
      .addr { font-size: 14px; }
      .conn-code {
        font-size: 11px; color: var(--text-secondary, #8e8e93); word-break: break-all;
        background: var(--bg, #000); padding: 8px; border-radius: 6px; user-select: all;
      }
      .device-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 0; border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      }
      .device-info { display: flex; flex-direction: column; gap: 2px; }
      .device-info .meta { color: var(--text-secondary, #8e8e93); font-size: 12px; }
      .person {
        display: flex; flex-direction: column; gap: 10px;
        padding-top: 12px; border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      }
      .person-head { display: flex; justify-content: space-between; align-items: center; }
      .add-person { display: flex; gap: 8px; align-items: center; }
      select {
        background: var(--bg, #000); color: var(--text, #fff);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        border-radius: 8px; padding: 8px 10px; font-size: 13px; width: 100%;
      }
      .field { display: flex; flex-direction: column; gap: 4px; }
      .field > span { font-size: 12px; color: var(--text-secondary, #8e8e93); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      input[type='text'], input:not([type]), textarea {
        background: var(--bg, #000); color: var(--text, #fff);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        border-radius: 8px; padding: 8px 10px; font-size: 13px; width: 100%;
        font-family: inherit;
      }
      textarea { font-family: 'SF Mono', ui-monospace, Menlo, monospace; resize: vertical; }
      .checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary, #8e8e93); }
      .checkbox input { width: auto; }
    `,
  ],
})
export class MobileSettingsTabComponent implements OnInit {
  private readonly confirmService = inject(ConfirmService);
  private readonly ipc = inject(MobileGatewayIpcService);
  private readonly settings = inject(SettingsIpcService);
  private readonly peopleStore = inject(MobilePeopleStore);

  protected readonly ownerProfileId = MOBILE_OWNER_PROFILE_ID;
  protected readonly people = signal<MobilePeopleOverview | null>(null);
  protected readonly members = computed(() => this.people()?.members ?? []);
  protected readonly computers = computed(() => this.people()?.computers ?? []);
  protected readonly accounts = computed(() => this.people()?.accounts ?? []);
  protected readonly drafts = signal<Record<string, PersonDraft>>({});
  protected readonly newPersonName = signal('');
  protected readonly savingPerson = signal<string | null>(null);
  protected readonly savedPerson = signal<string | null>(null);
  protected readonly pairingProfileId = signal(MOBILE_OWNER_PROFILE_ID);

  protected readonly status = signal<MobileGatewayStatus | null>(null);
  protected readonly devices = signal<MobileDeviceSummary[]>([]);
  protected readonly pairing = signal<MobilePairingResult | null>(null);
  protected readonly busy = signal(false);
  protected readonly pairingBusy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);

  // APNs push config
  protected readonly apnsKeyP8 = signal('');
  protected readonly apnsKeyId = signal('');
  protected readonly apnsTeamId = signal('');
  protected readonly apnsBundleId = signal('');
  protected readonly apnsProduction = signal(false);
  protected readonly apnsHasKey = signal(false);
  protected readonly apnsBusy = signal(false);
  protected readonly apnsSaved = signal(false);

  // Optional TLS (wss://)
  protected readonly tlsCertPath = signal('');
  protected readonly tlsKeyPath = signal('');
  protected readonly tlsBusy = signal(false);
  protected readonly tlsSaved = signal(false);

  protected readonly tailscaleReady = computed(() => Boolean(this.status()?.tailscaleIp));

  protected connectionCode(p: MobilePairingResult): string {
    return JSON.stringify({
      v: 1,
      host: p.host,
      port: p.port,
      pairingToken: p.pairingToken,
      ...(p.secure ? { secure: true } : {}),
    });
  }

  protected async copyCode(p: MobilePairingResult): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.connectionCode(p));
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      /* clipboard may be unavailable in the sandbox; the code is still selectable */
    }
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.status.set(await this.ipc.getStatus());
    this.devices.set(await this.ipc.listDevices());
    await this.loadPeople();
    await this.loadApnsConfig();
  }

  private async loadPeople(): Promise<void> {
    const overview = await this.ipc.listPeople();
    this.people.set(overview);
    // Keep what is being typed for a person who is still there; start the others from what is saved.
    const previous = this.drafts();
    const next: Record<string, PersonDraft> = {};
    for (const person of overview?.members ?? []) {
      next[person.profileId] = previous[person.profileId] ?? {
        workerNodeId: person.session?.workerNodeId ?? '',
        workingDirectory: person.session?.workingDirectory ?? '',
        accountIds: [...(person.session?.allowedAccountProfileIds ?? [])],
      };
    }
    this.drafts.set(next);
    if (!next[this.pairingProfileId()] && this.pairingProfileId() !== MOBILE_OWNER_PROFILE_ID) {
      this.pairingProfileId.set(MOBILE_OWNER_PROFILE_ID);
    }
    await this.peopleStore.refresh();
  }

  protected draftFor(person: MobileMemberProfile): PersonDraft {
    return this.drafts()[person.profileId] ?? { workerNodeId: '', workingDirectory: '', accountIds: [] };
  }

  protected updateDraft(person: MobileMemberProfile, change: Partial<PersonDraft>): void {
    this.drafts.update((all) => ({ ...all, [person.profileId]: { ...this.draftFor(person), ...change } }));
  }

  protected toggleAccount(person: MobileMemberProfile, accountId: string, checked: boolean): void {
    const current = this.draftFor(person).accountIds.filter((id) => id !== accountId);
    this.updateDraft(person, { accountIds: checked ? [...current, accountId] : current });
  }

  protected canSave(person: MobileMemberProfile): boolean {
    const draft = this.draftFor(person);
    return Boolean(draft.workerNodeId && draft.workingDirectory.trim() && draft.accountIds.length > 0);
  }

  protected async addPerson(): Promise<void> {
    this.error.set(null);
    try {
      await this.ipc.addPerson(this.newPersonName());
      this.newPersonName.set('');
      await this.loadPeople();
    } catch (err) {
      this.error.set(presentError(err).rawDetail);
    }
  }

  protected async savePerson(person: MobileMemberProfile): Promise<void> {
    const draft = this.draftFor(person);
    this.savingPerson.set(person.profileId);
    this.error.set(null);
    try {
      await this.ipc.setPersonSession({
        profileId: person.profileId,
        workerNodeId: draft.workerNodeId,
        workingDirectory: draft.workingDirectory.trim(),
        allowedAccountProfileIds: draft.accountIds,
      });
      this.savedPerson.set(person.profileId);
      setTimeout(() => this.savedPerson.set(null), 2000);
      await this.loadPeople();
    } catch (err) {
      this.error.set(presentError(err).rawDetail);
    } finally {
      this.savingPerson.set(null);
    }
  }

  protected async removePerson(person: MobileMemberProfile): Promise<void> {
    if (!await this.confirmService.confirm({
      message: `Remove ${person.name}? Their phones disconnect now and must pair again. Sessions they started stay on your list.`,
      confirmLabel: `Remove ${person.name}`,
      danger: true,
    })) {
      return;
    }
    this.error.set(null);
    try {
      await this.ipc.removePerson(person.profileId);
      this.devices.set(await this.ipc.listDevices());
      await this.loadPeople();
    } catch (err) {
      this.error.set(presentError(err).rawDetail);
    }
  }

  /** The person's name after a phone's label, when the phone is not the owner's. */
  protected deviceOwnerSuffix(device: MobileDeviceSummary): string {
    if (device.profileId === MOBILE_OWNER_PROFILE_ID) return '';
    const name = this.members().find((person) => person.profileId === device.profileId)?.name;
    return name ? ` (${name})` : '';
  }

  private async loadApnsConfig(): Promise<void> {
    const res = await this.settings.getSettings();
    if (!res.success) return;
    const s = (res.data ?? {}) as Record<string, unknown>;
    this.apnsKeyId.set(typeof s['mobileGatewayApnsKeyId'] === 'string' ? (s['mobileGatewayApnsKeyId'] as string) : '');
    this.apnsTeamId.set(typeof s['mobileGatewayApnsTeamId'] === 'string' ? (s['mobileGatewayApnsTeamId'] as string) : '');
    this.apnsBundleId.set(
      typeof s['mobileGatewayApnsBundleId'] === 'string' ? (s['mobileGatewayApnsBundleId'] as string) : '',
    );
    this.apnsProduction.set(Boolean(s['mobileGatewayApnsProduction']));
    // Never echo the secret key back into the UI; just note whether one is stored.
    this.apnsHasKey.set(typeof s['mobileGatewayApnsKeyP8'] === 'string' && (s['mobileGatewayApnsKeyP8'] as string).length > 0);
    this.apnsKeyP8.set('');
    this.tlsCertPath.set(typeof s['mobileGatewayTlsCertPath'] === 'string' ? (s['mobileGatewayTlsCertPath'] as string) : '');
    this.tlsKeyPath.set(typeof s['mobileGatewayTlsKeyPath'] === 'string' ? (s['mobileGatewayTlsKeyPath'] as string) : '');
  }

  protected async saveTls(): Promise<void> {
    this.tlsBusy.set(true);
    this.error.set(null);
    try {
      await this.settings.setSetting('mobileGatewayTlsCertPath', this.tlsCertPath().trim());
      await this.settings.setSetting('mobileGatewayTlsKeyPath', this.tlsKeyPath().trim());
      this.tlsSaved.set(true);
      setTimeout(() => this.tlsSaved.set(false), 2000);
      await this.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.tlsBusy.set(false);
    }
  }

  protected async saveApns(): Promise<void> {
    this.apnsBusy.set(true);
    this.error.set(null);
    try {
      await this.settings.setSetting('mobileGatewayApnsKeyId', this.apnsKeyId().trim());
      await this.settings.setSetting('mobileGatewayApnsTeamId', this.apnsTeamId().trim());
      await this.settings.setSetting('mobileGatewayApnsBundleId', this.apnsBundleId().trim());
      await this.settings.setSetting('mobileGatewayApnsProduction', this.apnsProduction());
      // Only overwrite the key when the user pasted a new one.
      const key = this.apnsKeyP8().trim();
      if (key) {
        await this.settings.setSetting('mobileGatewayApnsKeyP8', key);
      }
      this.apnsSaved.set(true);
      setTimeout(() => this.apnsSaved.set(false), 2000);
      await this.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.apnsBusy.set(false);
    }
  }

  protected async toggle(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.status()?.running) {
        this.pairing.set(null);
        this.status.set(await this.ipc.stop());
      } else {
        this.status.set(await this.ipc.start());
      }
      this.devices.set(await this.ipc.listDevices());
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async generatePairing(): Promise<void> {
    this.pairingBusy.set(true);
    this.error.set(null);
    try {
      const profileId = this.pairingProfileId();
      const result = await this.ipc.issuePairing(profileId === MOBILE_OWNER_PROFILE_ID ? undefined : profileId);
      if (!result) {
        this.error.set('Could not generate a pairing code — is Tailscale running on this Mac?');
      }
      this.pairing.set(result);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.pairingBusy.set(false);
    }
  }

  protected async revoke(device: MobileDeviceSummary): Promise<void> {
    if (!await this.confirmService.confirm({ message: `Revoke "${device.label}"? It will need to pair again to reconnect.`, confirmLabel: 'Revoke device', danger: true })) {
      return;
    }
    this.error.set(null);
    try {
      await this.ipc.revokeDevice(device.deviceId);
      this.devices.set(await this.ipc.listDevices());
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  protected formatExpiry(timestamp: number): string {
    const remainingMs = timestamp - Date.now();
    if (remainingMs <= 0) return 'now';
    const minutes = Math.round(remainingMs / 60_000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `in ${hours}h`;
    return `in ${Math.round(hours / 24)}d`;
  }

  protected formatRelativeTime(timestamp?: number): string {
    if (!timestamp) return 'never';
    const deltaMs = Date.now() - timestamp;
    if (deltaMs < 60_000) return 'just now';
    const minutes = Math.round(deltaMs / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }
}
