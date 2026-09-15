import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLockService } from '../core/app-lock.service';
import { MobileSheetComponent } from './mobile-sheet.component';

describe('MobileSheetComponent', () => {
  const locked = signal(false);
  beforeEach(() => {
    locked.set(false);
    // jsdom has no top layer. Real focus/inert behavior is verified in Chromium.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
      value: function (this: HTMLDialogElement) { this.open = false; } });
    TestBed.configureTestingModule({ providers: [{ provide: AppLockService, useValue: { locked } }] });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  });

  async function setup() {
    const fixture = TestBed.createComponent(MobileSheetComponent);
    Object.defineProperty(fixture.componentInstance, 'label', { value: signal('Request details') });
    await fixture.whenStable();
    return fixture;
  }

  it('opens a labelled modal with an explicit close action', async () => {
    const fixture = await setup();
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    expect(dialog?.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('Request details');
    const dismiss = vi.fn();
    fixture.componentInstance.dismiss.subscribe(dismiss);
    fixture.nativeElement.querySelector('.mobile-sheet__close').click();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('keeps Escape and backdrop dismissal disabled while a decision is pending', async () => {
    const fixture = await setup();
    Object.defineProperty(fixture.componentInstance, 'dismissible', { value: signal(false) });
    fixture.changeDetectorRef.markForCheck();
    await fixture.whenStable();
    const dismiss = vi.fn();
    fixture.componentInstance.dismiss.subscribe(dismiss);
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    dialog.click();
    expect(cancel.defaultPrevented).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });

  it('yields the native top layer to app lock, then restores the sheet', async () => {
    const fixture = await setup();
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    locked.set(true);
    await fixture.whenStable();
    expect(dialog.open).toBe(false);
    locked.set(false);
    await fixture.whenStable();
    expect(dialog.open).toBe(true);
  });

  it('returns focus to an explicit opener that lost focus before the sheet mounted', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const fixture = TestBed.createComponent(MobileSheetComponent);
    Object.defineProperty(fixture.componentInstance, 'label', { value: signal('Folders') });
    Object.defineProperty(fixture.componentInstance, 'returnFocusTo', { value: signal(opener) });
    await fixture.whenStable();
    fixture.destroy();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
