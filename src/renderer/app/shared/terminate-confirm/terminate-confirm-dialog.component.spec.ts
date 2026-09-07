/**
 * Decision 16(b) — the dialog, actually rendered.
 *
 * `terminate-confirm.spec.ts` pins the *call sites* by reading source, which is
 * the only way to prove no fourth path exists but proves nothing about
 * behaviour. These drive the real component: click the real buttons, press a
 * real Escape, and check what a user would get.
 */
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminateConfirmDialogComponent } from './terminate-confirm-dialog.component';
import { TerminateConfirmStore } from './terminate-confirm.store';
import { InstanceStore } from '../../core/state/instance.store';

await resolveComponentResources(() => Promise.resolve(''));

const terminateInstance = vi.fn();

function mount(): { fixture: ComponentFixture<TerminateConfirmDialogComponent>; store: TerminateConfirmStore } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TerminateConfirmDialogComponent],
    providers: [
      {
        provide: InstanceStore,
        useValue: {
          instances: () => [{ id: 'i1', displayName: 'Refactor the parser' }],
          terminateInstance,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(TerminateConfirmDialogComponent);
  fixture.detectChanges();
  return { fixture, store: TestBed.inject(TerminateConfirmStore) };
}

function overlay(fixture: ComponentFixture<TerminateConfirmDialogComponent>): HTMLElement | null {
  return fixture.nativeElement.querySelector('.confirm-overlay');
}

function button(fixture: ComponentFixture<TerminateConfirmDialogComponent>, cls: string): HTMLButtonElement {
  const el = fixture.nativeElement.querySelector(cls) as HTMLButtonElement | null;
  expect(el, `expected ${cls} to render`).toBeTruthy();
  return el as HTMLButtonElement;
}

describe('TerminateConfirmDialogComponent (Decision 16b)', () => {
  beforeEach(() => terminateInstance.mockClear());

  it('renders nothing until a terminate is requested', () => {
    expect(overlay(mount().fixture)).toBeNull();
  });

  it('names the session being ended, not its id', () => {
    const { fixture, store } = mount();
    store.request('i1');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('h3').textContent)
      .toContain('Terminate Refactor the parser?');
  });

  it('falls back to "this session" for an instance it cannot name', () => {
    const { fixture, store } = mount();
    store.request('gone');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('h3').textContent).toContain('this session');
  });

  it('does not terminate anything merely by asking', () => {
    const { fixture, store } = mount();
    store.request('i1');
    fixture.detectChanges();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('terminates only after the destructive button is pressed', () => {
    const { fixture, store } = mount();
    store.request('i1');
    fixture.detectChanges();
    button(fixture, '.btn-confirm').click();
    fixture.detectChanges();
    expect(terminateInstance).toHaveBeenCalledWith('i1');
    expect(overlay(fixture)).toBeNull();
  });

  it('"Keep running" closes without terminating', () => {
    const { fixture, store } = mount();
    store.request('i1');
    fixture.detectChanges();
    button(fixture, '.btn-cancel').click();
    fixture.detectChanges();
    expect(terminateInstance).not.toHaveBeenCalled();
    expect(overlay(fixture)).toBeNull();
  });

  /** The original defect: Escape did nothing, because nothing focused the overlay. */
  it('Escape dismisses without terminating', () => {
    const { fixture, store } = mount();
    store.request('i1');
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(overlay(fixture)).toBeNull();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog so keyboard users land on the question', () => {
    const { fixture, store } = mount();
    store.request('i1');
    fixture.detectChanges();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.confirm-dialog'));
  });

  it('a click on the backdrop dismisses', () => {
    const { fixture, store } = mount();
    store.request('i1');
    fixture.detectChanges();
    overlay(fixture)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(overlay(fixture)).toBeNull();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('a click inside the dialog does NOT dismiss it', () => {
    const { fixture, store } = mount();
    store.request('i1');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.confirm-dialog') as HTMLElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(overlay(fixture)).not.toBeNull();
  });
});
