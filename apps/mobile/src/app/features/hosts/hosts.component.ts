import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AppLockService } from '../../core/app-lock.service';
import { connectionHelpText, connectionLabel } from '../../core/connection-status';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { PairedHost } from '../../core/models';
import { unpairFromHost } from '../../core/pairing';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { MobileSheetComponent } from '../../shared/mobile-sheet.component';

@Component({
  standalone: true,
  selector: 'app-hosts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent, MobileSheetComponent],
  template: `
    <section class="hosts-screen">
      <app-mobile-header title="Hosts">
        <span mobileHeaderLeading aria-hidden="true"></span>
        <button
          mobileHeaderTrailing
          class="mobile-icon-button"
          type="button"
          (click)="add()"
          aria-label="Add host" [disabled]="busy()"
        >
          <app-mobile-icon name="plus" />
        </button>
      </app-mobile-header>

      @if (hosts().length === 0) {
        <div class="mobile-empty-state hosts-empty">
          <app-mobile-icon name="host" />
          <h1>No hosts yet</h1>
          <p>On your Mac, open Settings, choose Mobile, start the gateway, and generate a pairing code.</p>
          <button class="mobile-primary-button" type="button" (click)="add()">
            <app-mobile-icon name="plus" />
            Add host
          </button>
        </div>
      } @else {
        <h1 class="hosts-title">Your hosts</h1>
        <ul class="host-list">
          @for (host of hosts(); track host.id) {
            <li class="host-item">
              <button
                class="host-row mobile-pressable"
                type="button"
                (click)="open(host.id)"
                [attr.aria-label]="hostAriaLabel(host.id, host.name)" [disabled]="busy()"
              >
                <span
                  class="host-row__status"
                  [class.host-row__status--online]="isOnline(host.id)"
                  aria-hidden="true"
                ></span>
                <span class="host-row__copy">
                  <strong>{{ host.name }}</strong>
                  <small>{{ host.host }}:{{ host.port }}</small>
                </span>
                <span class="host-row__state">{{ stateLabel(host.id) }}</span>
                <app-mobile-icon name="chevron-down" />
              </button>
              <button
                class="host-options mobile-pressable"
                type="button"
                (click)="options.set(host)"
                [attr.aria-label]="'Options for ' + host.name" [disabled]="busy()"
              >
                <app-mobile-icon name="more" />
              </button>
            </li>
          }
        </ul>
        @if (selectedHost(); as selected) {
          <section class="host-recovery" aria-labelledby="selected-host-title">
            <h2 id="selected-host-title">{{ selected.name }}</h2>
            <p>Selected · {{ stateLabel(selected.id) }}</p>
            @if (connectionState() !== 'connected') {
              <p>{{ recoveryHelp() }}</p>
            }
            <div class="recovery-actions">
              @if (connectionState() === 'unauthorized') {
                <button class="mobile-primary-button" type="button" (click)="add()" [disabled]="busy()">Pair again</button>
              } @else if (connectionState() === 'disconnected') {
                <button class="mobile-primary-button" type="button" (click)="reconnect()" [disabled]="busy()">Reconnect</button>
              }
              @if (hosts().length > 1) {
                <button class="host-action" type="button" (click)="changingHost.set(true)" [disabled]="busy()">Change host</button>
              }
            </div>
          </section>
        }
      }

      @if (notice()) {
        <p class="hosts-notice" role="alert">{{ notice() }}</p>
      }

      @if (options(); as host) {
        <app-mobile-sheet [label]="host.name + ' options'" [dismissible]="!busy()" (dismiss)="options.set(null)">
          <p class="host-sheet-copy">{{ host.host }}:{{ host.port }}</p>
          <button class="host-action host-action--remove" type="button" (click)="remove(host)" [disabled]="busy()">
            {{ busy() ? 'Removing…' : 'Remove host' }}
          </button>
          <p class="host-sheet-copy">You’ll need a new pairing code to connect again. If the host is offline, revoke this phone’s access later in Settings, Mobile.</p>
        </app-mobile-sheet>
      }
      @if (changingHost()) {
        <app-mobile-sheet label="Change host" [dismissible]="!busy()" (dismiss)="changingHost.set(false)">
          @for (host of hosts(); track host.id) {
            <button class="host-action host-choice" type="button" (click)="open(host.id)" [disabled]="busy()"
              [attr.aria-label]="'Select ' + host.name">
              <strong>{{ host.name }}</strong><small>{{ host.id === activeId() ? 'Selected' : 'Not selected' }}</small>
            </button>
          }
        </app-mobile-sheet>
      }

      <section class="security-section" aria-labelledby="security-heading">
        <h2 id="security-heading">Security</h2>
        <button
          class="lock-row mobile-pressable"
          type="button"
          (click)="toggleLock()"
          [attr.aria-pressed]="lockEnabled()"
          [disabled]="!lockAvailable()"
        >
          <app-mobile-icon name="lock" />
          <span class="host-row__copy">
            <strong>App Lock</strong>
            <small>{{ lockSubtitle() }}</small>
          </span>
          <span class="switch" [class.switch--on]="lockEnabled() && lockAvailable()" aria-hidden="true"></span>
        </button>
      </section>
    </section>
  `,
  styles: [
    `
      .hosts-screen { min-height: 100%; padding: var(--space-3) var(--mobile-gutter) var(--space-8); }
      .hosts-title { margin: var(--space-8) 0 var(--space-3); font-size: var(--font-size-xl); }
      .hosts-empty > app-mobile-icon { color: var(--text-secondary); font-size: 2.75rem; }
      .hosts-empty h1 { font-size: var(--font-size-xl); }
      .hosts-empty p { margin: 0; line-height: var(--line-height-normal); }
      .host-list { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
      .host-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-1); align-items: center; }
      .host-options {
        display: flex; align-items: center; justify-content: center;
        min-width: 44px; min-height: 44px; padding: 0;
        border: none; border-radius: var(--radius-md);
        background: var(--surface-2, #2c2c2e); color: var(--text-secondary);
      }
      .host-options:active { background: rgba(255, 255, 255, 0.055); }
      .hosts-notice { margin: var(--space-1) 0 0; color: var(--accent-error, #ff453a); font-size: var(--font-size-sm); }
      .host-row, .lock-row {
        display: grid; width: 100%; min-height: 64px; align-items: center; gap: var(--space-3);
        border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text);
        padding: var(--space-2) var(--space-3); text-align: left;
      }
      .host-row { grid-template-columns: 10px minmax(0, 1fr) auto 18px; }
      .host-row:active, .lock-row:active { background: rgba(255, 255, 255, 0.055); }
      .host-row__status { width: 9px; height: 9px; border-radius: var(--radius-pill); background: var(--text-tertiary); }
      .host-row__status--online { background: var(--accent-online); }
      .host-row__copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
      .host-row__copy strong { overflow: hidden; font-size: var(--font-size-base); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
      .host-row__copy small, .host-row__state { color: var(--text-secondary); font-size: var(--font-size-sm); }
      .host-row__copy small { overflow-wrap: anywhere; }
      .host-row__state { text-transform: capitalize; max-width: 90px; text-align: right; }
      .host-row > app-mobile-icon { color: var(--text-secondary); transform: rotate(-90deg); }
      .host-recovery { margin-top: var(--space-5); padding: var(--space-4); background: var(--surface-raised); border: 1px solid var(--separator); border-radius: var(--radius-md); }
      .host-recovery h2 { margin: 0; font-size: var(--font-size-lg); overflow-wrap: anywhere; }
      .host-recovery p, .host-sheet-copy { color: var(--text-secondary); line-height: var(--line-height-normal); overflow-wrap: anywhere; }
      .recovery-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
      .host-action { min-height: 44px; border: 1px solid var(--separator); border-radius: var(--radius-md); padding: var(--space-3); background: var(--surface-2); color: var(--text); font: inherit; }
      .host-action--remove { width: 100%; color: var(--accent-error); }
      .host-choice { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-2); text-align: left; }
      .host-choice strong { overflow-wrap: anywhere; min-width: 0; }
      .host-choice small { flex: none; color: var(--text-secondary); }
      .security-section { margin-top: var(--space-10); border-top: 1px solid var(--separator); padding-top: var(--space-5); }
      .security-section h2 { margin: 0 var(--space-3) var(--space-2); color: var(--text-secondary); font-size: var(--font-size-sm); text-transform: uppercase; }
      .lock-row { grid-template-columns: 24px minmax(0, 1fr) 44px; }
      .lock-row > app-mobile-icon { color: var(--text-secondary); font-size: 1.25rem; }
      .switch { position: relative; width: 44px; height: 26px; border-radius: var(--radius-pill); background: var(--surface-2); transition: background var(--motion-press) ease-out; }
      .switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--primitive-white); transition: transform var(--motion-press) ease-out; }
      .switch--on { background: var(--accent-online); }
      .switch--on::after { transform: translateX(18px); }
    `,
  ],
})
export class HostsComponent {
  private readonly hostStore = inject(HostStore);
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);
  private readonly appLock = inject(AppLockService);

  protected readonly hosts = this.hostStore.hosts;
  protected readonly activeId = this.hostStore.activeId;
  protected readonly selectedHost = computed(() => this.hosts().find((host) => host.id === this.activeId()) ?? null);
  protected readonly connectionState = computed(() => this.gateway.dataHostId() === this.activeId() ? this.gateway.state() : null);
  protected readonly recoveryHelp = computed(() => {
    const state = this.connectionState();
    return state ? connectionHelpText(state) : 'Checking the selected host’s connection.';
  });
  protected readonly options = signal<PairedHost | null>(null);
  protected readonly changingHost = signal(false);
  protected readonly busy = signal(false);
  protected readonly lockEnabled = this.appLock.enabled;
  protected readonly lockAvailable = this.appLock.available;
  /** Set when a removal couldn't revoke the token on the host. */
  protected readonly notice = signal<string | null>(null);

  protected lockSubtitle(): string {
    if (!this.lockAvailable()) return 'Biometrics unavailable on this device';
    return this.lockEnabled() ? `Require ${this.appLock.biometryLabel()} to open` : 'Off';
  }

  protected toggleLock(): void {
    void this.appLock.setEnabled(!this.lockEnabled());
  }

  protected stateLabel(id: string): string {
    if (id !== this.activeId()) return 'Not selected';
    const state = this.connectionState();
    return state ? connectionLabel(state) : 'Not checked';
  }

  protected isOnline(id: string): boolean {
    return id === this.activeId() && this.connectionState() === 'connected';
  }

  protected reconnect(): void {
    if (this.connectionState() === 'disconnected') this.gateway.reconnect();
  }

  protected hostAriaLabel(id: string, name: string): string {
    const state = this.stateLabel(id);
    return state ? `Open ${name}, ${state}` : `Open ${name}`;
  }

  /**
   * Removing a host is destructive — the device token is the only copy and
   * reconnecting means pairing again — so confirm first, matching the terminate
   * flow in the conversation screen.
   *
   * Revoking on the host first means the Mac's paired-device list doesn't keep an
   * entry the user has already deleted here. It's best-effort: an unreachable host
   * or an already-dead token must not block the local removal, but the user is
   * told when the token may still be live so they can finish the job on the Mac.
   */
  protected async remove(host: PairedHost): Promise<void> {
    if (this.busy() || !confirm(`Remove ${host.name}? You'll need to pair again to reconnect.`)) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const revoked = await unpairFromHost(host);
      await this.hostStore.removeHost(host.id);
      this.options.set(null);
      if (!revoked) {
        this.notice.set(
          `Removed ${host.name}, but couldn't reach it to revoke this phone's access. ` +
            `Revoke it on the Mac under Settings, Mobile, Paired devices.`,
        );
      }
    } catch {
      this.options.set(null);
      this.notice.set('Could not save the host removal. Check device storage. You may need to pair again to reconnect.');
    } finally {
      this.busy.set(false);
    }
  }

  protected add(): void {
    if (!this.busy()) void this.router.navigate(['/add-host']);
  }

  protected async open(id: string): Promise<void> {
    if (this.busy() || !this.hosts().some((host) => host.id === id)) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      await this.hostStore.setActive(id);
      this.changingHost.set(false);
      if (this.activeId() === id) void this.router.navigate(['/projects']);
    } catch {
      this.changingHost.set(false);
      this.notice.set('Could not save the selected host. Check device storage and try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
