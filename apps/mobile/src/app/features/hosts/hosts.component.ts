import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AppLockService } from '../../core/app-lock.service';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';

@Component({
  standalone: true,
  selector: 'app-hosts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="hosts-screen">
      <app-mobile-header title="Hosts">
        <span mobileHeaderLeading aria-hidden="true"></span>
        <button
          mobileHeaderTrailing
          class="mobile-icon-button"
          type="button"
          (click)="add()"
          aria-label="Add host"
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
            <li>
              <button
                class="host-row mobile-pressable"
                type="button"
                (click)="open(host.id)"
                [attr.aria-label]="hostAriaLabel(host.id, host.name)"
              >
                <span
                  class="host-row__status"
                  [class.host-row__status--online]="host.id === activeId() && online()"
                  aria-hidden="true"
                ></span>
                <span class="host-row__copy">
                  <strong>{{ host.name }}</strong>
                  <small>{{ host.host }}:{{ host.port }}</small>
                </span>
                <span class="host-row__state">{{ stateLabel(host.id) }}</span>
                <app-mobile-icon name="chevron-down" />
              </button>
            </li>
          }
        </ul>
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
      .host-row__state { text-transform: capitalize; }
      .host-row > app-mobile-icon { color: var(--text-secondary); transform: rotate(-90deg); }
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
  protected readonly online = this.gateway.online;
  protected readonly lockEnabled = this.appLock.enabled;
  protected readonly lockAvailable = this.appLock.available;

  protected lockSubtitle(): string {
    if (!this.lockAvailable()) return 'Biometrics unavailable on this device';
    return this.lockEnabled() ? `Require ${this.appLock.biometryLabel()} to open` : 'Off';
  }

  protected toggleLock(): void {
    void this.appLock.setEnabled(!this.lockEnabled());
  }

  protected stateLabel(id: string): string {
    if (id !== this.activeId()) return '';
    return this.gateway.state() === 'connected' ? 'online' : this.gateway.state();
  }

  protected hostAriaLabel(id: string, name: string): string {
    const state = this.stateLabel(id);
    return state ? `Open ${name}, ${state}` : `Open ${name}`;
  }

  protected add(): void {
    void this.router.navigate(['/add-host']);
  }

  protected async open(id: string): Promise<void> {
    await this.hostStore.setActive(id);
    void this.router.navigate(['/projects']);
  }
}
