import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { TranscriptFindBarComponent } from './transcript-find-bar.component';
import { TranscriptJumpRailComponent } from './transcript-jump-rail.component';
import type { DisplayItem } from './display-item.types';

function focusWithKeyboard(button: HTMLElement): void {
  const matches = button.matches.bind(button);
  vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
  button.dispatchEvent(new FocusEvent('focus'));
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('transcript find hints', () => {
  it('keeps no-match navigation focusable, explains it, and refuses activation', () => {
    const fixture = TestBed.createComponent(TranscriptFindBarComponent);
    fixture.componentRef.setInput('query', 'missing');
    fixture.detectChanges();
    const previous = vi.fn();
    fixture.componentInstance.previous.subscribe(previous);
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    focusWithKeyboard(button);
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('No matches for this search');
    button.click();
    expect(previous).not.toHaveBeenCalled();
    fixture.componentRef.setInput('matchCount', 2);
    fixture.detectChanges();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    button.click();
    expect(previous).toHaveBeenCalledOnce();
  });

  it('gives each find icon a real tooltip and preserves its accessible name', () => {
    const fixture = TestBed.createComponent(TranscriptFindBarComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const buttons = fixture.debugElement.queryAll(By.css('button'));
    expect(buttons.map(button => button.nativeElement.getAttribute('aria-label'))).toEqual(['Previous match', 'Next match', 'Close find']);
    for (const button of buttons) expect(button.injector.get(AioTooltipDirective, null)).not.toBeNull();
  });
});

describe('transcript rail keyboard preview', () => {
  const item = (id: string, timestamp: number, content: string): DisplayItem => ({
    id: `item-${id}`, type: 'message', message: { id, timestamp, type: 'user', content },
  });
  const first = item('one', 1, 'First prompt');
  const second = item('two', 2, 'Second prompt');

  function setup(): ComponentFixture<TranscriptJumpRailComponent> {
    const fixture = TestBed.createComponent(TranscriptJumpRailComponent);
    const viewport = document.createElement('div');
    Object.defineProperties(viewport, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
    Object.defineProperty(fixture.nativeElement, 'clientHeight', { value: 400 });
    fixture.componentRef.setInput('items', [first, second]);
    fixture.componentRef.setInput('viewport', viewport);
    fixture.detectChanges();
    // jsdom has no layout; measure the supplied dimensions like the existing rail tests.
    (fixture.componentInstance as unknown as { measure(): void }).measure();
    fixture.detectChanges();
    return fixture;
  }

  it('opens exactly one preview on keyboard focus and closes it with Escape and blur', () => {
    const fixture = setup();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.tick');
    focusWithKeyboard(button);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview')?.textContent).toContain('First prompt');
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(button.getAttribute('aria-describedby')).toBe(fixture.nativeElement.querySelector('.preview').id);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
    button.dispatchEvent(new FocusEvent('blur'));
    fixture.detectChanges();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });

  it('retains the focused message when history is prepended and ignores pending hover', () => {
    vi.useFakeTimers();
    const fixture = setup();
    const buttons = fixture.nativeElement.querySelectorAll('.tick') as NodeListOf<HTMLButtonElement>;
    buttons[0].dispatchEvent(new MouseEvent('mouseenter'));
    focusWithKeyboard(buttons[1]);
    fixture.detectChanges();
    vi.advanceTimersByTime(200);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview')?.textContent).toContain('Second prompt');
    fixture.componentRef.setInput('items', [item('older', 0, 'Older prompt'), first, second]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview')?.textContent).toContain('Second prompt');
    fixture.nativeElement.querySelector('.rail').dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview')?.textContent).toContain('Second prompt');
  });

  it('clears removed focus so subsequent pointer previews still work', () => {
    vi.useFakeTimers();
    const fixture = setup();
    focusWithKeyboard(fixture.nativeElement.querySelectorAll('.tick')[1]);
    fixture.detectChanges();
    fixture.componentRef.setInput('items', [first, item('replacement', 3, 'Replacement prompt')]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview')).toBeNull();
    fixture.nativeElement.querySelector('.tick').dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(200);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview')?.textContent).toContain('First prompt');
  });

  it('does not pin a preview when a pointer click focuses the tick', () => {
    const fixture = setup();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.tick');
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector !== ':focus-visible' && matches(selector));
    button.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview')).toBeNull();
  });
});
