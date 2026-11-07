import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { PauseBannerComponent } from '../state/pause/pause-banner.component';
import { PauseStore } from '../state/pause/pause.store';
import { AppUpdateStore } from '../state/app-update.store';
import { AppUpdateBannerComponent } from '../../shared/components/app-update-banner/app-update-banner.component';
import { NoticeSlotService } from './notice-slot.service';
import { NoticeOverflowComponent } from './notice-overflow.component';

@Component({
  standalone: true,
  imports: [PauseBannerComponent, AppUpdateBannerComponent, NoticeOverflowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (startupSlot()) { <p class="startup-test">Startup warning</p> }
    <app-pause-banner /><app-update-banner /><app-notice-overflow />`,
})
class Shell {
  readonly startupSlot = inject(NoticeSlotService).register('startup', signal(true), inject(DestroyRef));
}

describe('notice shell integration', () => {
  it('budgets real producers, names the hidden notices, expands and unregisters them', () => {
    TestBed.configureTestingModule({ imports: [Shell], providers: [
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: PauseStore, useValue: { isPaused: signal(true), detectorError: () => false, reasons: () => [],
        queuedTotal: () => 0, manualPaused: () => true, setManual: vi.fn() } },
      { provide: AppUpdateStore, useValue: { visible: signal(true), status: () => ({ availableVersion: '1.0' }),
        loading: () => false, error: () => null, restartAndInstall: vi.fn() } },
    ] });
    const fixture = TestBed.createComponent(Shell); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pause-banner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.app-update-banner')).toBeNull();
    expect(fixture.nativeElement.querySelector('.startup-test')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('2 more notices: Startup checks, App update');
    fixture.nativeElement.querySelector('.notice-overflow button').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.app-update-banner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.startup-test')).not.toBeNull();
    const service = TestBed.inject(NoticeSlotService);
    fixture.destroy(); expect(service.overflow()).toEqual([]);
  });
});
