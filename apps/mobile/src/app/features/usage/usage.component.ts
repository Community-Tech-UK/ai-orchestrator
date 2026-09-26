import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MobileSheetComponent } from '../../shared/mobile-sheet.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { providerDisplayName } from '../new-session/new-session.presentation';
import { UsageStore } from './usage.store';

@Component({
  selector: 'app-usage', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MobileSheetComponent, MobileIconComponent],
  templateUrl: './usage.component.html', styleUrl: './usage.component.scss',
})
export class UsageComponent {
  protected readonly usage = inject(UsageStore);
  protected readonly open = signal(false);
  protected readonly providerName = providerDisplayName;
  protected readonly summary = computed(() => {
    if (!this.usage.online()) return 'Offline';
    if (this.usage.status() === 'loading') return 'Checking…';
    if (this.usage.status() === 'error') return 'Unavailable';
    const providers = this.usage.providers();
    const exhausted = providers.filter(provider => provider.exhausted).length;
    if (exhausted) return `${exhausted} ${exhausted === 1 ? 'limit' : 'limits'} reached`;
    const known = providers.flatMap(provider => provider.freshness === 'fresh' ? provider.windows : [])
      .flatMap(window => window.percentUsed === null ? [] : [window.percentUsed]);
    return known.length ? `${Math.max(...known)}% highest usage` : 'Usage unknown';
  });
}
