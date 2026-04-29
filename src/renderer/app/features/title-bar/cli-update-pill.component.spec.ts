import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliUpdatePillState } from '../../../../shared/types/diagnostics.types';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';
import { CliUpdatePillComponent } from './cli-update-pill.component';

describe('CliUpdatePillComponent', () => {
  let fixture: ComponentFixture<CliUpdatePillComponent>;
  let navigate: ReturnType<typeof vi.fn>;
  const state = signal<CliUpdatePillState>({
    generatedAt: 1,
    count: 1,
    entries: [
      {
        cli: 'claude',
        displayName: 'Claude Code',
        currentVersion: '1.0.0',
        updatePlan: {
          cli: 'claude',
          displayName: 'Claude Code',
          supported: true,
          displayCommand: 'claude update',
        },
      },
    ],
  });
  const store = {
    state: state.asReadonly(),
    init: vi.fn(),
  };

  beforeEach(() => {
    navigate = vi.fn();
    store.init.mockClear();
    state.set({
      generatedAt: 1,
      count: 1,
      entries: [
        {
          cli: 'claude',
          displayName: 'Claude Code',
          currentVersion: '1.0.0',
          updatePlan: {
            cli: 'claude',
            displayName: 'Claude Code',
            supported: true,
            displayCommand: 'claude update',
          },
        },
      ],
    });

    TestBed.configureTestingModule({
      imports: [CliUpdatePillComponent],
      providers: [
        { provide: CliUpdatePillStore, useValue: store },
        { provide: Router, useValue: { navigate } },
      ],
    });

    fixture = TestBed.createComponent(CliUpdatePillComponent);
    fixture.detectChanges();
  });

  it('renders when update work is available', () => {
    expect(store.init).toHaveBeenCalledOnce();
    const button = fixture.nativeElement.querySelector('.cli-update-pill') as HTMLButtonElement | null;

    expect(button?.textContent).toContain('1 updater');
    expect(button?.title).toContain('Claude Code 1.0.0: claude update');
  });

  it('hides when there are no pending updates', () => {
    state.set({ generatedAt: 2, count: 0, entries: [] });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cli-update-pill')).toBeNull();
  });

  it('opens CLI Health settings when clicked', () => {
    const button = fixture.nativeElement.querySelector('.cli-update-pill') as HTMLButtonElement;
    button.click();

    expect(navigate).toHaveBeenCalledWith(['/settings'], {
      queryParams: { tab: 'cli-health' },
    });
  });
});
