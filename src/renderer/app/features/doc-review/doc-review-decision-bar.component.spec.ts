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

it('asks to scroll to a clicked item and offers the recommendations shortcut only when there are items', () => {
  TestBed.configureTestingModule({ imports: [DocReviewDecisionBarComponent] });
  const fixture = TestBed.createComponent(DocReviewDecisionBarComponent);
  fixture.componentRef.setInput('items', []);
  fixture.detectChanges();
  const findShortcut = (): HTMLButtonElement | undefined => Array.from(
    fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
  ).find((button) => button.textContent?.includes('Go with your recommendations'));
  expect(findShortcut()).toBeUndefined();

  fixture.componentRef.setInput('items', [
    { info: { id: 'overview', title: 'Overview', decisionId: null, options: [] }, decision: null, comment: '', choice: null, choices: [] },
    { info: { id: 'decisions', title: 'Decisions', decisionId: null, options: [] }, decision: 'approve', comment: '', choice: null, choices: [] },
  ]);
  fixture.detectChanges();
  const selected = vi.fn(); fixture.componentInstance.itemSelected.subscribe(selected);
  const accepted = vi.fn(); fixture.componentInstance.recommendationsAccepted.subscribe(accepted);

  (fixture.nativeElement.querySelectorAll('button.item')[1] as HTMLButtonElement).click();
  expect(selected).toHaveBeenCalledWith('decisions');

  // Kept apart from the overall-verdict buttons so it is not read as a fourth verdict.
  expect(findShortcut()!.closest('.controls')).toBeNull();
  findShortcut()!.click();
  expect(accepted).toHaveBeenCalledOnce();
});
