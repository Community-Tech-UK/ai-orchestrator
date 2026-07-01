import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptModalComponent } from './prompt-modal.component';

/**
 * Note on scope: this project's vitest Angular transform does not register
 * signal `input()` declarations for template binding (NG0303) — which is why
 * the loop-control spec relies on NO_ERRORS_SCHEMA and overrides input
 * functions directly. We therefore exercise the modal's behaviour through its
 * instance (draft / guard / emit logic). The DOM rendering and input bindings
 * are validated by the real app, which has no such schema, and by the
 * loop-control routing test.
 */
interface ModalInternals {
  draft: { set(value: string): void };
  canConfirm: () => boolean;
  onConfirm(): void;
  onCancel(): void;
  submitted: { subscribe(fn: (value: string) => void): unknown };
  cancelled: { subscribe(fn: () => void): unknown };
}

describe('PromptModalComponent', () => {
  let fixture: ComponentFixture<PromptModalComponent>;
  let ci: ModalInternals;
  let opener: HTMLButtonElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PromptModalComponent],
    }).compileComponents();
    opener = document.createElement('button');
    opener.textContent = 'Open modal';
    document.body.append(opener);
    fixture = TestBed.createComponent(PromptModalComponent);
    ci = fixture.componentInstance as unknown as ModalInternals;
  });

  afterEach(() => {
    fixture.destroy();
    opener.remove();
  });

  it('renders nothing while closed (default)', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pm-overlay')).toBeNull();
  });

  it('cannot confirm a blank draft when a value is required (default)', () => {
    expect(ci.canConfirm()).toBe(false);
    ci.draft.set('   ');
    expect(ci.canConfirm()).toBe(false);
    ci.draft.set('something');
    expect(ci.canConfirm()).toBe(true);
  });

  it('emits the trimmed draft on confirm', () => {
    let emitted: string | null = null;
    ci.submitted.subscribe((value) => (emitted = value));

    ci.draft.set('  rename me  ');
    ci.onConfirm();

    expect(emitted).toBe('rename me');
  });

  it('does not emit on confirm when the draft is blank', () => {
    let emittedCount = 0;
    ci.submitted.subscribe(() => (emittedCount += 1));

    ci.draft.set('   ');
    ci.onConfirm();

    expect(emittedCount).toBe(0);
  });

  it('emits cancelled on cancel', () => {
    let cancelledCount = 0;
    ci.cancelled.subscribe(() => (cancelledCount += 1));

    ci.onCancel();

    expect(cancelledCount).toBe(1);
  });

  it('restores focus when the open modal closes', async () => {
    let open = true;
    (fixture.componentInstance as unknown as { isOpen: () => boolean }).isOpen = () => open;
    opener.focus();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const field = fixture.nativeElement.querySelector('.pm-input') as HTMLInputElement | null;
    expect(field).toBeTruthy();
    field!.focus();
    expect(document.activeElement).toBe(field);

    open = false;
    fixture.detectChanges();

    expect(document.activeElement).toBe(opener);
  });

  it('restores focus after Escape requests modal close', async () => {
    let open = true;
    let cancelledCount = 0;
    (fixture.componentInstance as unknown as { isOpen: () => boolean }).isOpen = () => open;
    ci.cancelled.subscribe(() => (cancelledCount += 1));
    opener.focus();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const overlay = fixture.nativeElement.querySelector('.pm-overlay') as HTMLElement | null;
    const field = fixture.nativeElement.querySelector('.pm-input') as HTMLInputElement | null;
    expect(overlay).toBeTruthy();
    expect(field).toBeTruthy();
    field!.focus();

    overlay!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(cancelledCount).toBe(1);

    open = false;
    fixture.detectChanges();

    expect(document.activeElement).toBe(opener);
  });
});
