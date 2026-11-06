import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';
import { DocReviewDecisionBarComponent } from './doc-review-decision-bar.component';

it('keeps the missing-verdict action focusable, blocks submission, and permits a verdict while using native busy protection', () => {
  TestBed.configureTestingModule({ imports: [DocReviewDecisionBarComponent] });
  const fixture = TestBed.createComponent(DocReviewDecisionBarComponent);
  fixture.componentRef.setInput('items', []);
  fixture.detectChanges();
  const submit = fixture.nativeElement.querySelector('.submit') as HTMLButtonElement;
  const submitted = vi.fn(); fixture.componentInstance.submitted.subscribe(submitted);
  expect(submit.disabled).toBe(false);
  expect(submit.tabIndex).toBe(0);
  expect(submit.getAttribute('aria-disabled')).toBe('true');
  submit.click(); expect(submitted).not.toHaveBeenCalled();
  fixture.componentRef.setInput('overall', 'approve'); fixture.detectChanges();
  expect(submit.getAttribute('aria-disabled')).toBeNull();
  submit.click(); expect(submitted).toHaveBeenCalledOnce();
  fixture.componentRef.setInput('busy', true); fixture.detectChanges();
  expect(submit.disabled).toBe(true);
  expect(submit.textContent).toContain('Sending');
  submit.click(); expect(submitted).toHaveBeenCalledOnce();
});
