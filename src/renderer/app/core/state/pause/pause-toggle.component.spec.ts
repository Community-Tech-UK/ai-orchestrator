import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PauseToggleComponent } from './pause-toggle.component';
import { PauseStore } from './pause.store';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';

describe('Pause toggle tooltips', () => {
  const manualPaused = signal(false);
  const setManual = vi.fn();
  beforeEach(() => {
    manualPaused.set(false); setManual.mockClear();
    TestBed.configureTestingModule({ imports: [PauseToggleComponent],
      providers: [{ provide: PauseStore, useValue: { manualPaused, setManual } }] });
  });
  afterEach(() => TestBed.resetTestingModule());
  it('retains both state-dependent names and hints and opens on keyboard focus', () => {
    const fixture = TestBed.createComponent(PauseToggleComponent); fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button'));
    expect(button.nativeElement.hasAttribute('title')).toBe(false);
    expect(button.nativeElement.getAttribute('aria-label')).toBe('Pause orchestrator');
    expect(button.injector.get(AioTooltipDirective).appTooltip()).toBe('Pause orchestrator');
    const element = button.nativeElement as HTMLElement;
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    element.dispatchEvent(new FocusEvent('focus')); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Pause orchestrator');
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    manualPaused.set(true); fixture.detectChanges();
    expect(button.nativeElement.getAttribute('aria-label')).toBe('Resume orchestrator');
    expect(button.injector.get(AioTooltipDirective).appTooltip()).toBe('Resume orchestrator');
    button.nativeElement.click();
    expect(setManual).toHaveBeenCalledWith(false);
  });
});
