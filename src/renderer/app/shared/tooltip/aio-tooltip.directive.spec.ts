/**
 * UX1 — the directive must actually put a tooltip in the DOM and wire it to the
 * trigger for assistive technology. `tooltip-policy.spec.ts` proves the rules;
 * this proves they are applied to a real element, because a directive that
 * compiles and a directive that renders are different things.
 */

import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AioTooltipDirective } from './aio-tooltip.directive';
import { TOOLTIP_DELAY_MS, TOUCH_DELAY_MS } from './tooltip-policy';

@Component({
  standalone: true,
  imports: [AioTooltipDirective],
  template: `
    <button
      type="button"
      id="trigger"
      [appTooltip]="tip"
      [appTooltipLabel]="label"
      [attr.aria-expanded]="expanded"
      [attr.aria-describedby]="describedBy"
    >{{ label }}</button>
  `,
})
class HostComponent {
  tip: string | null = 'Stops after this iteration';
  label = 'Pause';
  expanded: string | null = null;
  describedBy: string | null = null;
}

function tooltipEl(): HTMLElement | null {
  return document.querySelector('[role="tooltip"]');
}

function trigger(fixture: ComponentFixture<HostComponent>): HTMLElement {
  return fixture.nativeElement.querySelector('#trigger') as HTMLElement;
}

/**
 * jsdom does not implement `:focus-visible`, so the directive's own modality
 * check can never be true here. Stand in for it rather than asserting a
 * behaviour the environment cannot produce.
 */
function stubFocusVisible(element: HTMLElement, focusVisible: boolean): void {
  const original = element.matches.bind(element);
  const stub = (selector: string): boolean =>
    (selector === ':focus-visible' ? focusVisible : original(selector));
  (element as unknown as { matches: (selector: string) => boolean }).matches = stub;
}

describe('AioTooltipDirective', () => {
  let fixture: ComponentFixture<HostComponent>;

  /**
   * Host inputs are set BEFORE the first change detection: signal inputs bound
   * in a template are not reliably re-read after a post-init field mutation in
   * this vitest config (same constraint the sibling component specs document).
   */
  function render(overrides: Partial<HostComponent> = {}): ComponentFixture<HostComponent> {
    fixture = TestBed.createComponent(HostComponent);
    Object.assign(fixture.componentInstance, overrides);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    render();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    // Nothing may outlive the fixture — a leaked overlay would pollute the next test.
    expect(tooltipEl()).toBeNull();
  });

  it('does not show before the open delay has elapsed', () => {
    trigger(fixture).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);

    expect(tooltipEl()).toBeNull();
  });

  it('renders the tooltip text after the delay', () => {
    trigger(fixture).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    expect(tooltipEl()?.textContent).toContain('Stops after this iteration');
  });

  it('points the trigger at the tooltip for assistive technology, then restores', () => {
    const button = trigger(fixture);
    button.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(tooltipEl()?.id).toBe(describedBy);

    button.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  // A trigger that already owned a description must still own it afterwards.
  it('preserves an existing aria-describedby through open and close', () => {
    fixture.destroy();
    render({ describedBy: 'existing-hint' });
    const button = trigger(fixture);

    button.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(button.getAttribute('aria-describedby')).toContain('existing-hint');

    button.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(button.getAttribute('aria-describedby')).toBe('existing-hint');
  });

  it('hides on mouseleave', () => {
    const button = trigger(fixture);
    button.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(tooltipEl()).not.toBeNull();

    button.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(tooltipEl()).toBeNull();
  });

  it('hides on Escape', () => {
    const button = trigger(fixture);
    button.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(tooltipEl()).toBeNull();
  });

  it('closes on click and does not immediately reopen on hover', () => {
    const button = trigger(fixture);
    button.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(tooltipEl()).not.toBeNull();

    button.dispatchEvent(new MouseEvent('click'));
    fixture.detectChanges();
    expect(tooltipEl()).toBeNull();

    button.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();
    expect(tooltipEl()).toBeNull();
  });

  it('shows nothing when the copy would merely repeat the visible label', () => {
    fixture.destroy();
    render({ tip: 'Pause', label: 'Pause' });

    trigger(fixture).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    expect(tooltipEl()).toBeNull();
  });

  it('shows nothing while the trigger has an open menu', () => {
    fixture.destroy();
    render({ expanded: 'true' });

    trigger(fixture).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    expect(tooltipEl()).toBeNull();
  });

  it('shows nothing when there is no copy', () => {
    fixture.destroy();
    render({ tip: null });

    trigger(fixture).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    fixture.detectChanges();

    expect(tooltipEl()).toBeNull();
  });

  it('opens on a touch long-press and self-dismisses', () => {
    const button = trigger(fixture);
    button.dispatchEvent(new Event('touchstart'));
    vi.advanceTimersByTime(TOUCH_DELAY_MS);
    fixture.detectChanges();
    expect(tooltipEl()).not.toBeNull();

    vi.advanceTimersByTime(2_000);
    fixture.detectChanges();
    expect(tooltipEl()).toBeNull();
  });
});

/**
 * UX1's acceptance requires keyboard proof, and this is the one behaviour that
 * cannot be exercised through a real `focus` event here: jsdom does not
 * implement `:focus-visible`, so `element.matches(':focus-visible')` is always
 * false and the directive (correctly, by its own fail-closed rule) never opens.
 *
 * Rather than assert a lie, the modality decision is tested through the seam
 * the directive actually consults, and the wiring is proven by driving that
 * seam directly. `tooltip-policy.spec.ts` covers `shouldOpenOnFocus` itself.
 */
describe('AioTooltipDirective — keyboard focus', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    expect(tooltipEl()).toBeNull();
  });

  it('opens with no delay when the trigger reports keyboard focus', () => {
    const button = trigger(fixture);
    stubFocusVisible(button, true);

    button.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();

    // No timer advance: keyboard focus is deliberately immediate.
    expect(tooltipEl()?.textContent).toContain('Stops after this iteration');
  });

  it('does not open when the focus did not come from the keyboard', () => {
    const button = trigger(fixture);
    stubFocusVisible(button, false);

    button.dispatchEvent(new FocusEvent('focus'));
    vi.advanceTimersByTime(1_000);
    fixture.detectChanges();

    expect(tooltipEl()).toBeNull();
  });

  it('closes again on blur', () => {
    const button = trigger(fixture);
    stubFocusVisible(button, true);

    button.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(tooltipEl()).not.toBeNull();

    button.dispatchEvent(new FocusEvent('blur'));
    fixture.detectChanges();
    expect(tooltipEl()).toBeNull();
  });
});

/**
 * Nesting. `mouseenter` fires on an element AND on each ancestor when the
 * pointer lands inside it, so two nested hosts both opened an overlay and
 * showed two popups over the same few pixels. A native `title` never did this
 * (the browser resolves exactly one), so migrating to a JS directive is what
 * introduced the hazard — it shipped in the instance row, where a status dot
 * sat inside the leading indicator.
 */
@Component({
  standalone: true,
  imports: [AioTooltipDirective],
  template: `
    <span id="outer" appTooltip="Outer label">
      <span id="inner" appTooltip="Inner label"></span>
    </span>
  `,
})
class NestedHostComponent {}

describe('AioTooltipDirective — nested hosts', () => {
  let fixture: ComponentFixture<NestedHostComponent>;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [NestedHostComponent] }).compileComponents();
    fixture = TestBed.createComponent(NestedHostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    expect(tooltipEl()).toBeNull();
  });

  function el(id: string): HTMLElement {
    return fixture.nativeElement.querySelector(`#${id}`) as HTMLElement;
  }

  function openTooltips(): HTMLElement[] {
    return Array.from(document.querySelectorAll('[role="tooltip"]'));
  }

  it('shows only the innermost tooltip when the pointer lands on a nested host', () => {
    // Exactly what the browser does: ancestor first, then descendant.
    el('outer').dispatchEvent(new MouseEvent('mouseenter'));
    el('inner').dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();

    const open = openTooltips();
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent).toContain('Inner label');
  });

  it('replaces an already-open ancestor tooltip rather than stacking on it', () => {
    el('outer').dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    expect(openTooltips()).toHaveLength(1);

    el('inner').dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();

    const open = openTooltips();
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent).toContain('Inner label');
  });

  // The gap gate 8 found: suppressing the ancestor is only half the job. When
  // the inner tooltip closes and the pointer is still inside the outer host,
  // no `mouseenter` fires there (it was never left), so without an explicit
  // hand-back the user is left hovering a control showing nothing at all.
  it('hands the tooltip back to the outer host when the pointer leaves the inner one', () => {
    el('outer').dispatchEvent(new MouseEvent('mouseenter'));
    el('inner').dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    expect(openTooltips()[0]?.textContent).toContain('Inner label');

    // Pointer moves off the dot but stays inside its container.
    el('inner').dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: el('outer') }));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();

    const open = openTooltips();
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent).toContain('Outer label');
  });

  it('shows nothing when the pointer leaves the whole nest', () => {
    el('inner').dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    expect(openTooltips()).toHaveLength(1);

    el('inner').dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: null }));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    expect(openTooltips()).toHaveLength(0);
  });

  it('still shows the outer tooltip when the pointer is only on the outer host', () => {
    el('outer').dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();

    const open = openTooltips();
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent).toContain('Outer label');
  });
});
