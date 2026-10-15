import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeepAwakeState } from '@contracts/schemas/observability';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { KeepAwakeChipComponent } from './keep-awake-chip.component';

const inactive: KeepAwakeState = { mode: 'while-working', active: false, reason: null, since: null };
describe('KeepAwakeChipComponent', () => {
  let callback: (state: KeepAwakeState) => void;
  const ipc = { getKeepAwakeState: vi.fn(), onKeepAwakeState: vi.fn() };
  const base = { platform: 'darwin' };
  const unsubscribe = vi.fn();
  const router = { navigate: vi.fn(async () => true) };
  beforeEach(() => {
    TestBed.resetTestingModule(); vi.clearAllMocks(); base.platform = 'darwin';
    ipc.getKeepAwakeState.mockResolvedValue(inactive);
    ipc.onKeepAwakeState.mockImplementation((cb: typeof callback) => { callback = cb; return unsubscribe; });
    TestBed.configureTestingModule({ imports: [KeepAwakeChipComponent], providers: [
      { provide: AppIpcService, useValue: ipc }, { provide: ElectronIpcService, useValue: base },
      { provide: Router, useValue: router },
    ] });
  });
  const create = async () => {
    const fixture = TestBed.createComponent(KeepAwakeChipComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); return fixture;
  };
  it('is hidden when inactive', async () => {
    const fixture = await create(); expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });
  it.each([
    ['loop', 'loop running'], ['plan-queue', 'plan queue running'], ['automation', 'automation running'],
    ['session', 'session working'], ['always', 'always on'],
  ] as const)('shows %s reason and the registry tooltip', async (reason, text) => {
    const fixture = await create(); callback({ mode: 'always', active: true, reason, since: 100 }); fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Mac awake: ' + text); expect(button.hasAttribute('title')).toBe(false);
    const tooltip = fixture.debugElement.query(By.directive(AioTooltipDirective)).injector.get(AioTooltipDirective);
    expect(tooltip.appTooltip()).toBe(copyFor('keepAwakeChip'));
  });
  it('uses Computer on other platforms and navigates to General', async () => {
    base.platform = 'win32'; const fixture = await create();
    callback({ ...inactive, active: true, reason: 'session', since: 100 }); fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Computer awake: session working'); button.click();
    expect(router.navigate).toHaveBeenCalledWith(['/settings'], { queryParams: { tab: 'general' } });
  });
  it('preserves a push newer than the initial read and unsubscribes on destroy', async () => {
    let resolve!: (value: KeepAwakeState) => void;
    ipc.getKeepAwakeState.mockReturnValue(new Promise<KeepAwakeState>(r => { resolve = r; }));
    const fixture = TestBed.createComponent(KeepAwakeChipComponent); fixture.detectChanges();
    callback({ ...inactive, active: true, reason: 'loop', since: 100 }); resolve(inactive);
    await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('loop running'); fixture.destroy(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
