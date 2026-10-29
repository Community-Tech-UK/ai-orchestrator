import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
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
        latestVersion: '1.1.0',
        updateAvailable: true,
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
          latestVersion: '1.1.0',
          updateAvailable: true,
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

  it('keeps every CLI hint fragment on the real directive without native titles', () => {
    const button = fixture.debugElement.query(By.css('.cli-update-pill'));
    expect(button.nativeElement.hasAttribute('title')).toBe(false);
    expect(button.injector.get(AioTooltipDirective).appTooltip()).toBe('Claude Code 1.0.0 → 1.1.0: claude update');
    state.set({ generatedAt: 2, count: 1, entries: [{ cli: 'codex', displayName: 'Codex', currentVersion: '2.0',
      updateAvailable: true, updatePlan: { cli: 'codex', displayName: 'Codex', supported: false, reason: 'Update manually' } }] });
    fixture.detectChanges();
    expect(button.injector.get(AioTooltipDirective).appTooltip()).toBe('Codex 2.0: Update manually');
  });

  it('renders when update work is available', () => {
    expect(store.init).toHaveBeenCalledOnce();
    const button = fixture.nativeElement.querySelector('.cli-update-pill') as HTMLButtonElement | null;

    expect(button?.textContent).toContain('Update CLI');
    expect(fixture.debugElement.query(By.css('.cli-update-pill')).injector.get(AioTooltipDirective).appTooltip()).toContain('Claude Code 1.0.0 → 1.1.0: claude update');
  });

  it('pluralises when multiple updates are pending', () => {
    state.set({
      generatedAt: 3,
      count: 2,
      entries: [
        {
          cli: 'claude',
          displayName: 'Claude Code',
          currentVersion: '1.0.0',
          latestVersion: '1.1.0',
          updateAvailable: true,
          updatePlan: { cli: 'claude', displayName: 'Claude Code', supported: true, displayCommand: 'claude update' },
        },
        {
          cli: 'codex',
          displayName: 'OpenAI Codex',
          currentVersion: '0.5.0',
          latestVersion: '0.6.0',
          updateAvailable: true,
          updatePlan: { cli: 'codex', displayName: 'OpenAI Codex', supported: true, displayCommand: 'npm install -g @openai/codex@latest' },
        },
      ],
    });
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.cli-update-pill') as HTMLButtonElement | null;
    expect(button?.textContent).toContain('Update CLIs');
  });

  it('hides when there are no pending updates', () => {
    state.set({ generatedAt: 2, count: 0, entries: [] });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cli-update-pill')).toBeNull();
  });

  it('explains why automatic updates are waiting for a turn to finish', () => {
    state.set({ ...state(), waitingSessionCount: 2 });
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.cli-update-pill') as HTMLButtonElement;
    expect(button.textContent).toContain('Update waiting: 2 sessions are mid-turn');
    state.set({ ...state(), waitingSessionCount: 1 });
    fixture.detectChanges();
    expect(button.textContent).toContain('Update waiting: 1 session is mid-turn');
  });

  it('hides when entries exist but none have updateAvailable=true', () => {
    state.set({
      generatedAt: 4,
      count: 0,
      entries: [
        {
          cli: 'claude',
          displayName: 'Claude Code',
          currentVersion: '1.0.0',
          updateAvailable: false,
          updatePlan: { cli: 'claude', displayName: 'Claude Code', supported: true, displayCommand: 'claude update' },
        },
      ],
    });
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
