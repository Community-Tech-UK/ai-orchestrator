import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeChangeConfirmComponent } from './runtime-change-confirm.component';

describe('RuntimeChangeConfirmComponent', () => {
  let fixture: ComponentFixture<RuntimeChangeConfirmComponent>;
  let opener: HTMLButtonElement;

  const box = () => fixture.nativeElement.querySelector('[data-testid="runtime-change-confirm"]') as HTMLElement;
  const buttons = () => Array.from(box().querySelectorAll('button')) as HTMLButtonElement[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [RuntimeChangeConfirmComponent] }).compileComponents();
    opener = document.createElement('button');
    opener.textContent = 'Choose a model';
    document.body.append(opener);
    opener.focus();
    fixture = TestBed.createComponent(RuntimeChangeConfirmComponent);
    fixture.componentRef.setInput('text', 'Switching provider starts a new session; the rest does not carry over.');
    fixture.detectChanges();
  });

  afterEach(() => { fixture.destroy(); opener.remove(); });

  it('associates the visible consequence with the question and both answers', () => {
    const description = box().querySelector('.runtime-confirm__text') as HTMLElement;
    expect(description.id).not.toBe('');
    expect(box().getAttribute('aria-describedby')).toBe(description.id);
    for (const button of buttons()) expect(button.getAttribute('aria-describedby')).toBe(description.id);
    expect(document.getElementById(description.id)?.textContent).toContain('the rest does not carry over');
  });

  it('focuses the safe answer when the question appears', () => {
    expect(document.activeElement).toBe(buttons()[1]);
  });

  it.each(['confirmed', 'cancelled'] as const)('restores the opener after %s closes the question', outcome => {
    fixture.componentInstance[outcome].subscribe(() => fixture.destroy());
    buttons()[outcome === 'confirmed' ? 0 : 1]!.focus();
    buttons()[outcome === 'confirmed' ? 0 : 1]!.click();
    expect(document.activeElement).toBe(opener);
  });

  it('cancels with Escape without sending the key to session shortcuts', () => {
    const cancelled = vi.fn();
    const outside = vi.fn();
    fixture.componentInstance.cancelled.subscribe(() => { cancelled(); fixture.destroy(); });
    document.addEventListener('keydown', outside);
    try {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      buttons()[1]!.dispatchEvent(escape);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(escape.defaultPrevented).toBe(true);
      expect(outside).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(opener);
    } finally { document.removeEventListener('keydown', outside); }
  });

  it('does not steal focus back after the person has moved to another control', () => {
    const other = document.createElement('button');
    document.body.append(other);
    try {
      other.focus();
      fixture.destroy();
      expect(document.activeElement).toBe(other);
    } finally { other.remove(); }
  });

  it('shows the sentence that explains why the change is held, as an alert dialog', () => {
    expect(box().getAttribute('role')).toBe('alertdialog');
    expect(box().textContent).toContain('Switching provider starts a new session; the rest does not carry over.');
  });

  it('offers the two plain answers by default', () => {
    expect(buttons().map((button) => button.textContent?.trim())).toEqual(['Switch anyway', 'Keep current']);
  });

  it('can be worded for another question', () => {
    fixture.componentRef.setInput('confirmLabel', 'Turn off');
    fixture.componentRef.setInput('cancelLabel', 'Leave on');
    fixture.detectChanges();
    expect(buttons().map((button) => button.textContent?.trim())).toEqual(['Turn off', 'Leave on']);
  });

  it('says yes and no through its two outputs, once per click', () => {
    const confirmed = vi.fn();
    const cancelled = vi.fn();
    fixture.componentInstance.confirmed.subscribe(confirmed);
    fixture.componentInstance.cancelled.subscribe(cancelled);

    buttons()[0]!.click();
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();

    buttons()[1]!.click();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });
});
