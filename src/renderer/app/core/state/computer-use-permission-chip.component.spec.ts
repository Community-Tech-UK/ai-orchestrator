import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerUsePermissionChipComponent } from './computer-use-permission-chip.component';
import { ComputerUsePermissionStore } from './computer-use-permission.store';

function makeStore() {
  return {
    chipVisible: signal(true),
    unavailable: signal(false),
    attentionCount: signal(2),
  };
}

describe('ComputerUsePermissionChipComponent', () => {
  let store: ReturnType<typeof makeStore>;
  const router = { navigate: vi.fn(async () => true) };

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    store = makeStore();
    TestBed.configureTestingModule({
      imports: [ComputerUsePermissionChipComponent],
      providers: [
        { provide: ComputerUsePermissionStore, useValue: store },
        { provide: Router, useValue: router },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(ComputerUsePermissionChipComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the outstanding permission count', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('Computer Use: 2 needed');

    store.attentionCount.set(1);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Computer Use: 1 needed');
  });

  it('uses the error tone and unavailable copy for driver failures', () => {
    store.unavailable.set(true);
    const fixture = render();

    const chip = fixture.nativeElement.querySelector('.cu-permission-chip');
    expect(chip?.classList.contains('error')).toBe(true);
    expect(chip?.textContent).toContain('Computer Use unavailable');
  });

  it('navigates to the Computer Use settings tab on click', () => {
    const fixture = render();

    fixture.nativeElement.querySelector('button')?.click();

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(
      ['/settings'],
      { queryParams: { tab: 'computer-use' } },
    );
  });

  it('renders nothing before the banner has been dismissed', () => {
    store.chipVisible.set(false);
    const fixture = render();

    expect(fixture.nativeElement.querySelector('.cu-permission-chip')).toBeNull();
  });
});
