import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { SettingsStore } from '../../core/state/settings.store';
import { SESSION_COST_TOOLTIP } from '../../../../shared/types/session-cost-copy';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { SessionCostLabelComponent } from './session-cost-label.component';

describe('SessionCostLabelComponent', () => {
  let showCost = true;
  let snapshots: Record<string, unknown> = {};

  beforeEach(() => {
    showCost = true;
    snapshots = {};
    TestBed.configureTestingModule({
      imports: [SessionCostLabelComponent],
      providers: [
        { provide: SettingsStore, useValue: { showCost: () => showCost } },
        { provide: ProviderQuotaStore, useValue: { snapshots: () => snapshots, accountSnapshots: () => [] } },
      ],
    });
  });

  const render = (provider: string, costEstimate?: number) => {
    const fixture = TestBed.createComponent(SessionCostLabelComponent);
    fixture.componentRef.setInput('instance', { provider, contextUsage: { used: 1, total: 2, percentage: 50, costEstimate } });
    fixture.detectChanges();
    return fixture;
  };

  it('shows the running cost with the Phase 0 explanation on a focusable hover', () => {
    const fixture = render('claude', 12.34);
    const cost = fixture.nativeElement.querySelector('.cost') as HTMLElement;
    expect(cost.textContent?.trim()).toBe('≈$12.34');
    expect(cost.tabIndex).toBe(0);
    expect(fixture.debugElement.query((n) => n.nativeElement === cost).injector.get(AioTooltipDirective).appTooltip()).toBe(SESSION_COST_TOOLTIP);
  });

  it('says API-equivalent when a plan pays for the use', () => {
    snapshots = { claude: { plan: 'max', windows: [] } };
    expect(render('claude', 12.34).nativeElement.textContent).toContain('≈$12.34 API-equivalent');
  });

  it('shows nothing while the cost setting is off, nothing is spent, or the provider bills in credits', () => {
    showCost = false;
    expect(render('claude', 12.34).nativeElement.textContent.trim()).toBe('');
    showCost = true;
    expect(render('claude', 0).nativeElement.textContent.trim()).toBe('');
    expect(render('claude', undefined).nativeElement.textContent.trim()).toBe('');
    expect(render('copilot', 5).nativeElement.textContent.trim()).toBe('');
  });
});
