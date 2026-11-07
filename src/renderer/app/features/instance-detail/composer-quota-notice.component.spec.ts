import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { ComposerQuotaNoticeComponent } from './composer-quota-notice.component';
import { InstanceStore } from '../../core/state/instance.store';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';
describe('account-scoped composer quota', () => {
  it('shows only the session account and hides behind the quota-park banner', async () => {
    const snap = (id: string, used: number): ProviderQuotaSnapshot => ({ provider: 'claude', accountProfileId: id, takenAt: Date.now(), ok: true, source: 'admin-api',
      windows: [{ id: 'claude.5h', kind: 'rolling-window', label: '5-hour', unit: 'percent', used, limit: 100, remaining: 100 - used, resetsAt: null }] });
    const session = signal<{ id: string; provider: string; accountProfileId: string; currentModel: string; waitReason?: { kind: string } }>({ id: 'i', provider: 'claude', accountProfileId: 'a', currentModel: 'opus' });
    TestBed.configureTestingModule({ imports: [ComposerQuotaNoticeComponent], providers: [
      { provide: InstanceStore, useValue: { getInstance: () => session() } },
      { provide: ProviderQuotaStore, useValue: { snapshots: () => ({ claude: snap('b', 99) }), accountSnapshots: () => [snap('a', 82), snap('b', 95)] } },
    ] });
    const fixture = TestBed.createComponent(ComposerQuotaNoticeComponent);
    (fixture.componentInstance as unknown as { instanceId: () => string }).instanceId = () => 'i';
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('18% left'); expect(fixture.nativeElement.textContent).not.toContain('5% left');
    expect(fixture.nativeElement.classList.contains('empty')).toBe(false);
    session.update(current => ({ ...current, waitReason: { kind: 'quota-park' } })); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.hint-quota')).toBeNull();
    expect(fixture.nativeElement.classList.contains('empty')).toBe(true);
  });
});
