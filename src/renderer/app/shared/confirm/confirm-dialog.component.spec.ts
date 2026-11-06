import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmService } from './confirm.service';
import { ConfirmDialogComponent } from './confirm-dialog.component';

describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;
  let service: ConfirmService;
  let opener: HTMLButtonElement;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ConfirmDialogComponent] });
    service = TestBed.inject(ConfirmService);
    fixture = TestBed.createComponent(ConfirmDialogComponent);
    opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
  });
  afterEach(() => { fixture.destroy(); opener.remove(); });

  function key(value: string, shiftKey = false): void {
    (document.activeElement ?? fixture.nativeElement.querySelector('[role="dialog"]'))
      .dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
    fixture.detectChanges();
  }

  it('labels and describes the modal, confirms on Enter, and restores focus', async () => {
    const result = service.confirm({ title: 'Clear recents', message: 'Pinned items stay.', confirmLabel: 'Clear' });
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toContain('Clear recents');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('Pinned items stay.');
    key('Enter');
    await expect(result).resolves.toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('focuses Cancel for danger and blocks Enter on the action button', async () => {
    const result = service.confirm({ message: 'Cannot undo.', confirmLabel: 'Delete', danger: true });
    fixture.detectChanges();
    const cancel = fixture.nativeElement.querySelector('[data-cancel]') as HTMLButtonElement;
    const action = fixture.nativeElement.querySelector('[data-confirm]') as HTMLButtonElement;
    expect(document.activeElement).toBe(cancel);
    action.focus();
    key('Enter');
    expect(service.pending()).not.toBeNull();
    action.click();
    fixture.detectChanges();
    await expect(result).resolves.toBe(true);
  });

  it('cancels when Enter is pressed on the focused Cancel button of a non-danger dialog', async () => {
    const result = service.confirm({ title: 'Clear recents', message: 'Pinned items stay.', confirmLabel: 'Clear' });
    fixture.detectChanges();
    const cancel = fixture.nativeElement.querySelector('[data-cancel]') as HTMLButtonElement;
    cancel.focus();
    key('Enter');
    await expect(result).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('cancels when Enter is pressed on the focused Cancel button of a danger dialog', async () => {
    const result = service.confirm({ message: 'Cannot undo.', confirmLabel: 'Delete', danger: true });
    fixture.detectChanges();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('[data-cancel]'));
    key('Enter');
    await expect(result).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('traps Tab both ways, cancels with Escape, and returns focus', async () => {
    const result = service.confirm({ message: 'Delete?', confirmLabel: 'Delete', danger: true });
    fixture.detectChanges();
    const cancel = fixture.nativeElement.querySelector('[data-cancel]') as HTMLButtonElement;
    const action = fixture.nativeElement.querySelector('[data-confirm]') as HTMLButtonElement;
    key('Tab', true);
    expect(document.activeElement).toBe(action);
    key('Tab');
    expect(document.activeElement).toBe(cancel);
    key('Escape');
    await expect(result).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('resets focus and keyboard policy between queued requests', async () => {
    const first = service.confirm({ message: 'First', confirmLabel: 'Proceed' });
    const second = service.confirm({ message: 'Second', confirmLabel: 'Delete', danger: true });
    fixture.detectChanges();
    key('Enter');
    await expect(first).resolves.toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Second');
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('[data-cancel]'));
    key('Escape');
    await expect(second).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('cancels with Escape after focus leaves the dialog', async () => {
    const result = service.confirm({ message: 'Delete?', confirmLabel: 'Delete', danger: true });
    fixture.detectChanges();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    key('Escape');
    expect(service.pending()).toBeNull();
    await expect(result).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('prevents backdrop pointer input from taking focus away from Cancel', async () => {
    const result = service.confirm({ message: 'Delete?', confirmLabel: 'Delete', danger: true });
    fixture.detectChanges();
    const cancel = fixture.nativeElement.querySelector('[data-cancel]');
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    fixture.nativeElement.querySelector('.confirm-overlay').dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    expect(service.pending()).not.toBeNull();
    key('Escape');
    await expect(result).resolves.toBe(false);
  });

  it('keeps danger Enter and background shortcuts blocked after focus loss, then releases keyboard ownership', async () => {
    const result = service.confirm({ message: 'Delete?', confirmLabel: 'Delete', danger: true });
    fixture.detectChanges();
    const backgroundShortcut = vi.fn();
    document.addEventListener('keydown', backgroundShortcut);
    try {
      (document.activeElement as HTMLElement).blur();
      key('Enter');
      expect(service.pending()).not.toBeNull();
      for (const modifier of ['ctrlKey', 'metaKey']) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'z', [modifier]: true, bubbles: true, cancelable: true,
        }));
      }
      expect(backgroundShortcut).not.toHaveBeenCalled();
      key('Escape');
      await expect(result).resolves.toBe(false);
      key('z');
      expect(backgroundShortcut).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener('keydown', backgroundShortcut);
    }
  });

  it.each(['ctrlKey', 'metaKey'] as const)('keeps %s+Z inside the confirmation box', async (modifier) => {
    const backgroundShortcut = vi.fn();
    const result = service.confirm({ message: 'Delete?', confirmLabel: 'Delete', danger: true });
    fixture.detectChanges();
    document.addEventListener('keydown', backgroundShortcut);
    try {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'z', [modifier]: true, bubbles: true, cancelable: true,
      }));
      expect(backgroundShortcut).not.toHaveBeenCalled();
      expect(service.pending()).not.toBeNull();
    } finally {
      document.removeEventListener('keydown', backgroundShortcut);
      key('Escape');
      await expect(result).resolves.toBe(false);
    }
  });
});
