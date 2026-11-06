import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MobileSheetComponent } from '../../shared/mobile-sheet.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { accountFamilyDisplayName } from '../new-session/new-session.presentation';
import { UsageStore, type UsageAccountView } from './usage.store';

export interface UsageStripPart {
  readonly text: string;
  readonly band: 'normal' | 'high' | 'critical';
  readonly stale: boolean;
}

export interface UsageStripEntry {
  readonly provider: string;
  readonly name: string;
  readonly parts: UsageStripPart[];
}

/** One strip value per account, matching the desktop quota strip: "Claude 42% · 7%". */
export function usageStripPart(account: UsageAccountView): UsageStripPart | null {
  if (account.needsReauth) return { text: 'sign in', band: 'critical', stale: false };
  const stale = account.freshness !== 'fresh';
  if (account.headlinePercent !== null) {
    const percent = account.headlinePercent;
    return { text: `${Math.round(percent)}%`, band: percent >= 90 ? 'critical' : percent >= 75 ? 'high' : 'normal', stale };
  }
  return null;
}

export function planLabel(plan: string): string {
  return `${plan.charAt(0).toLocaleUpperCase()}${plan.slice(1)} plan`;
}

@Component({
  selector: 'app-usage', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MobileSheetComponent, MobileIconComponent],
  templateUrl: './usage.component.html', styleUrl: './usage.component.scss',
})
export class UsageComponent {
  protected readonly usage = inject(UsageStore);
  protected readonly open = signal(false);
  protected readonly providerName = accountFamilyDisplayName;
  protected readonly planLabel = planLabel;
  protected readonly strip = computed<UsageStripEntry[]>(() => this.usage.providers().flatMap(provider => {
    const usable = provider.accounts.filter(account => !account.disabled);
    const parts = usable.flatMap(account => usageStripPart(account) ?? []);
    const plan = usable.find(account => account.plan && account.freshness !== 'unavailable')?.plan;
    if (!parts.length && !plan) return [];
    const name = accountFamilyDisplayName(provider.provider);
    return [{ provider: provider.provider, name,
      parts: parts.length ? parts : [{ text: planLabel(plan!), band: 'normal', stale: false }] }];
  }));
  protected readonly summary = computed(() => {
    if (!this.usage.online()) return 'Usage offline';
    if (this.usage.status() === 'loading' && !this.usage.providers().length) return 'Checking usage…';
    if (this.usage.status() === 'error') return 'Usage unavailable';
    return 'No usage measured yet';
  });
  /** Dimming alone cannot say "not confirmed", so the strip says it in words too. */
  protected readonly showsLastKnown = computed(() => this.strip().some(entry => entry.parts.some(part => part.stale)));
  protected readonly stripLabel = computed(() => {
    const entries = this.strip();
    const text = entries.length
      ? entries.map(entry => `${entry.name} ${entry.parts.map(part => part.text).join(' and ')}`).join(', ')
      : this.summary();
    return `Usage${this.showsLastKnown() ? ', last known' : ''}: ${text}. Show details`;
  });

  protected freshnessText(account: UsageAccountView): string {
    if (account.freshness === 'fresh') return 'Current';
    return account.freshness === 'stale' ? 'Stale · not confirmed' : 'Unavailable';
  }
}
