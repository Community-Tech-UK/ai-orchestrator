import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodebaseSearchComponent } from './codebase-search.component';

describe('Codebase search hints', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the same HyDE explanation over its label and on checkbox focus', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [CodebaseSearchComponent] });
    const fixture = TestBed.createComponent(CodebaseSearchComponent);
    fixture.componentRef.setInput('storeId', 'example-codebase');
    fixture.detectChanges();
    const label = fixture.nativeElement.querySelector('label[for="hyde-toggle"]') as HTMLLabelElement;
    const input = fixture.nativeElement.querySelector('#hyde-toggle') as HTMLInputElement;
    const words = 'Hypothetical Document Embedding - generates better semantic queries';
    label.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(words);
    label.dispatchEvent(new MouseEvent('mouseleave'));
    const matches = input.matches.bind(input);
    vi.spyOn(input, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    input.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(words);
    expect(input.labels?.[0]).toBe(label);
    label.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.useHyDE()).toBe(false);
  });
});
