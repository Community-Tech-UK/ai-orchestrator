import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AioTooltipDirective } from './aio-tooltip.directive';

@Component({
  standalone: true,
  imports: [AioTooltipDirective],
  template: `
    <button
      type="button"
      aria-label="Run action"
      [attr.aria-disabled]="ownDisabled()"
      appTooltip="Run action"
      [appTooltipDisabledReason]="reason()"
      (click)="activations = activations + 1"
    ></button>
  `,
})
class HostComponent {
  readonly ownDisabled = signal<string | null>(null);
  readonly reason = signal<string | null>(null);
  activations = 0;
}

describe('tooltip disabled reasons and host-owned accessibility state', () => {
  let fixture: ComponentFixture<HostComponent>;
  let button: HTMLButtonElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    button = fixture.nativeElement.querySelector('button');
  });

  afterEach(() => fixture.destroy());

  it.each(['true', 'false'])('preserves the host aria-disabled=%s on an ordinary tooltip', (value) => {
    fixture.componentInstance.ownDisabled.set(value);
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe(value);
  });

  it('keeps a disabled-reason control focusable and prevents activation until the reason clears', () => {
    fixture.componentInstance.reason.set('Choose a working folder first');
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    expect(fixture.componentInstance.activations).toBe(0);

    fixture.componentInstance.reason.set(null);
    fixture.detectChanges();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    button.click();
    expect(fixture.componentInstance.activations).toBe(1);
  });

  it.each(['true', 'false'])('restores a pre-existing host aria-disabled=%s after the reason clears', (value) => {
    fixture.componentInstance.ownDisabled.set(value);
    fixture.componentInstance.reason.set('Choose a working folder first');
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fixture.componentInstance.reason.set(null);
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe(value);
  });

  it('does not restore stale disabled state when the host and reason become enabled together', () => {
    fixture.componentInstance.ownDisabled.set('true');
    fixture.componentInstance.reason.set('Choose a working folder first');
    fixture.detectChanges();
    fixture.componentInstance.ownDisabled.set(null);
    fixture.componentInstance.reason.set(null);
    fixture.detectChanges();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    button.click();
    expect(fixture.componentInstance.activations).toBe(1);
  });

  it.each([['true', null], ['false', 'true']])(
    'restores the latest host state when it changes from %s to %s during an active reason',
    async (initial, updated) => {
      fixture.componentInstance.ownDisabled.set(initial);
      fixture.componentInstance.reason.set('Choose a working folder first');
      fixture.detectChanges();
      fixture.componentInstance.ownDisabled.set(updated);
      fixture.detectChanges();
      await Promise.resolve();
      expect(button.getAttribute('aria-disabled')).toBe('true');

      fixture.componentInstance.reason.set(null);
      fixture.detectChanges();
      expect(button.getAttribute('aria-disabled')).toBe(updated);
    },
  );

  it('keeps the reason announced when another directive changes the attribute outside a render', async () => {
    fixture.componentInstance.reason.set('Choose a working folder first');
    fixture.detectChanges();
    button.setAttribute('aria-disabled', 'false');
    await Promise.resolve();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fixture.componentInstance.reason.set(null);
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe('false');
  });

  it.each([null, 'false', 'true'])('restores host state %s when destroyed with an active reason', (value) => {
    fixture.componentInstance.ownDisabled.set(value);
    fixture.componentInstance.reason.set('Choose a working folder first');
    fixture.detectChanges();
    fixture.destroy();
    expect(button.getAttribute('aria-disabled')).toBe(value);
  });
});
