import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackdropEscapeDirective } from './backdrop-escape.directive';

@Component({
  imports: [BackdropEscapeDirective],
  template: `
    @if (first()) { <button aria-label="Dismiss first overlay" appBackdropEscape (appBackdropEscape)="first.set(false)">Dismiss first overlay</button> }
    @if (second()) { <button aria-label="Dismiss second overlay" appBackdropEscape (appBackdropEscape)="second.set(false)">Dismiss second overlay</button> }
  `,
})
class Harness {
  first = signal(true);
  second = signal(true);
}

describe('BackdropEscapeDirective', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('dismisses only the latest open overlay and releases Escape after all close', () => {
    const fixture = TestBed.createComponent(Harness);
    fixture.detectChanges();
    const cancelled = vi.fn();
    document.addEventListener('keydown', cancelled);
    const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    try {
      escape();
      fixture.detectChanges();
      expect(fixture.componentInstance.second()).toBe(false);
      expect(fixture.componentInstance.first()).toBe(true);
      expect(cancelled).not.toHaveBeenCalled();
      escape();
      fixture.detectChanges();
      expect(fixture.componentInstance.first()).toBe(false);
      expect(cancelled).not.toHaveBeenCalled();
      escape();
      expect(cancelled).toHaveBeenCalledOnce();
    } finally { document.removeEventListener('keydown', cancelled); }
  });
  it('removes capture listeners when its view is destroyed and leaves other keys alone', () => {
    const fixture = TestBed.createComponent(Harness);
    fixture.detectChanges();
    const cancelled = vi.fn();
    document.addEventListener('keydown', cancelled);
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(fixture.componentInstance.first()).toBe(true);
      expect(fixture.componentInstance.second()).toBe(true);
      fixture.destroy();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(cancelled).toHaveBeenCalledTimes(2);
    } finally { document.removeEventListener('keydown', cancelled); }
  });
});
