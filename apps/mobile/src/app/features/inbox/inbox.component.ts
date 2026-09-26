import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { NeedsYouStore, type NeedsYouItem } from './needs-you.store';

@Component({
  standalone: true,
  selector: 'app-inbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="inbox-screen">
      <app-mobile-header title="Needs you" [subtitle]="subtitle()">
        <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="back()" aria-label="Back to projects">
          <app-mobile-icon name="chevron-left" />
        </button>
        <span mobileHeaderTrailing aria-hidden="true"></span>
      </app-mobile-header>

      @if (statusSummary()) {
        <p class="inbox-status" role="status">{{ statusSummary() }}</p>
      }

      @if (inbox.items().length === 0) {
        <div class="mobile-empty-state inbox-empty">
          <app-mobile-icon name="check" />
          <h1>Nothing needs you right now</h1>
          <p>Pending approvals and completed sessions from paired hosts appear here.</p>
        </div>
      } @else {
        <h1 class="inbox-title">Attention across hosts</h1>
        <ul class="inbox-list">
          @for (item of inbox.items(); track item.key) {
            <li>
              <button class="inbox-row mobile-pressable" type="button" (click)="open(item)"
                [attr.aria-label]="item.title + ' on ' + item.hostName">
                <span class="inbox-row__icon" [class.inbox-row__icon--completion]="item.kind === 'completion'">
                  <app-mobile-icon [name]="item.kind === 'prompt' ? 'warning' : 'check'" />
                </span>
                <span class="inbox-row__copy">
                  <strong>{{ item.title }}</strong>
                  <span>{{ item.message }}</span>
                  <small>{{ item.hostName }}</small>
                </span>
                <app-mobile-icon name="chevron-down" />
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [`
    .inbox-screen { min-height: 100%; padding: var(--space-3) var(--mobile-gutter) var(--space-8); }
    .inbox-title { margin: var(--space-7) var(--space-3) var(--space-3); font-size: var(--font-size-xl); }
    .inbox-status { margin: var(--space-4) var(--space-3) 0; color: var(--text-secondary); font-size: var(--font-size-sm); }
    .inbox-list { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
    .inbox-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) 18px; width: 100%; min-height: 72px; align-items: center; gap: var(--space-3); border: 0; border-radius: var(--radius-md); padding: var(--space-3); background: var(--surface-raised); color: var(--text); text-align: left; }
    .inbox-row__icon { display: grid; width: 36px; height: 36px; place-items: center; border-radius: var(--radius-pill); background: color-mix(in srgb, var(--accent-warning) 18%, transparent); color: var(--accent-warning); }
    .inbox-row__icon--completion { background: color-mix(in srgb, var(--accent-online) 18%, transparent); color: var(--accent-online); }
    .inbox-row__copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
    .inbox-row__copy strong, .inbox-row__copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .inbox-row__copy span, .inbox-row__copy small { color: var(--text-secondary); font-size: var(--font-size-sm); }
    .inbox-row > app-mobile-icon { color: var(--text-secondary); transform: rotate(-90deg); }
    .inbox-empty > app-mobile-icon { color: var(--accent-online); font-size: 2.75rem; }
    .inbox-empty h1 { font-size: var(--font-size-xl); }
    .inbox-empty p { margin: 0; line-height: var(--line-height-normal); }
  `],
})
export class InboxComponent {
  protected readonly inbox = inject(NeedsYouStore);
  private readonly router = inject(Router);
  protected readonly subtitle = computed(() => {
    const count = this.inbox.items().length;
    return `${count} ${count === 1 ? 'item' : 'items'} · ${this.inbox.hostStates().length} ${this.inbox.hostStates().length === 1 ? 'host' : 'hosts'}`;
  });
  protected readonly statusSummary = computed(() => {
    const states = this.inbox.hostStates();
    const offline = states.filter((host) => host.status === 'offline').length;
    const unauthorized = states.filter((host) => host.status === 'unauthorized').length;
    const checking = states.filter((host) => host.status === 'checking').length;
    return [
      offline ? `${offline} ${offline === 1 ? 'host' : 'hosts'} offline` : '',
      unauthorized ? `${unauthorized} ${unauthorized === 1 ? 'host needs' : 'hosts need'} pairing` : '',
      checking ? `Checking ${checking} ${checking === 1 ? 'host' : 'hosts'}` : '',
    ].filter(Boolean).join(' · ');
  });

  protected open(item: NeedsYouItem): void { void this.inbox.open(item); }
  protected back(): void { void this.router.navigate(['/projects']); }
}
