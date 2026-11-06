import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptFindBarComponent } from './transcript-find-bar.component';

describe('transcript match navigation hints', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('explains empty searches on focus, blocks navigation, and clears the reason for a match', () => {
    const fixture = TestBed.createComponent(TranscriptFindBarComponent);
    fixture.detectChanges();
    const next = vi.fn();
    fixture.componentInstance.next.subscribe(next);
    const button = fixture.nativeElement.querySelector('[aria-label="Next match"]') as HTMLButtonElement;
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    button.focus();
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Type something to search for first');
    button.click();
    expect(next).not.toHaveBeenCalled();

    fixture.componentRef.setInput('query', 'needle');
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('No matches for this search');
    fixture.componentRef.setInput('matchCount', 1);
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    button.click();
    expect(next).toHaveBeenCalledOnce();

    fixture.componentRef.setInput('loadingOlder', true);
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Loading...');
    button.click();
    expect(next).toHaveBeenCalledOnce();
    fixture.destroy();
  });
});
