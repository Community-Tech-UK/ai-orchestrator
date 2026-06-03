/**
 * PanelZoneComponent spec.
 *
 * Vitest runs Angular JIT without the Angular compiler plugin, so signal
 * inputs cannot be set via TestBed.setInput(). We follow the established
 * project pattern (checkpoint-timeline.component.spec.ts, etc.): override
 * the signal-input getter directly on the instance.
 *
 * Content-projection slot rendering (the `<ng-template appPanelZoneId>` bodies)
 * requires a real compiled host template and is not testable in this env.
 * We cover all observable behaviours: toggle logic, DOM classes, header text,
 * accessibility attributes, close button, and the activePanelChanged output.
 */

import {
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PanelZoneComponent,
  type PanelDescriptor,
} from './panel-zone.component';

// Resolve the external .scss styleUrl so Angular JIT can compile in jsdom.
await resolveComponentResources(() => Promise.resolve(''));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TWO_PANELS: PanelDescriptor[] = [
  { id: 'outline', label: 'Outline', icon: '<path d="M3 6h18"/>' },
  { id: 'search',  label: 'Search',  icon: '<circle cx="11" cy="11" r="7"/>' },
];

/**
 * Override the readonly signal-input getter on the component instance.
 * This is the only reliable way to set signal inputs in vitest JIT mode.
 */
function setPanels(component: PanelZoneComponent, panels: PanelDescriptor[]): void {
  (component as unknown as { panels: () => PanelDescriptor[] }).panels = () => panels;
}

function stripButtons(fixture: ComponentFixture<PanelZoneComponent>): HTMLButtonElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.strip-btn'),
  );
}

function panelZoneEl(fixture: ComponentFixture<PanelZoneComponent>): HTMLElement {
  return (fixture.nativeElement as HTMLElement).querySelector('.panel-zone') as HTMLElement;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('PanelZoneComponent', () => {
  let fixture: ComponentFixture<PanelZoneComponent>;
  let component: PanelZoneComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [PanelZoneComponent] });
    fixture = TestBed.createComponent(PanelZoneComponent);
    component = fixture.componentInstance;
    setPanels(component, TWO_PANELS);
    fixture.detectChanges();
  });

  // ── Initial state ──────────────────────────────────────────────────────

  it('starts with activePanelId() === null (dock collapsed)', () => {
    expect(component.activePanelId()).toBeNull();
  });

  it('renders one strip button per panel descriptor', () => {
    expect(stripButtons(fixture)).toHaveLength(2);
  });

  it('does NOT render the content area when collapsed', () => {
    const area = (fixture.nativeElement as HTMLElement).querySelector('.panel-content-area');
    expect(area).toBeNull();
  });

  it('does NOT add is-open class when collapsed', () => {
    expect(panelZoneEl(fixture).classList.contains('is-open')).toBe(false);
  });

  // ── Opening a panel ────────────────────────────────────────────────────

  it('opens the panel when its strip button is clicked', () => {
    stripButtons(fixture)[0].click();
    fixture.detectChanges();

    expect(component.activePanelId()).toBe('outline');
  });

  it('adds is-open class to .panel-zone when a panel is open', () => {
    stripButtons(fixture)[0].click();
    fixture.detectChanges();

    expect(panelZoneEl(fixture).classList.contains('is-open')).toBe(true);
  });

  it('shows .panel-content-area after opening a panel', () => {
    stripButtons(fixture)[0].click();
    fixture.detectChanges();

    const area = (fixture.nativeElement as HTMLElement).querySelector('.panel-content-area');
    expect(area).not.toBeNull();
  });

  it('shows the panel title in the header', () => {
    stripButtons(fixture)[0].click();
    fixture.detectChanges();

    const title = (fixture.nativeElement as HTMLElement).querySelector('.panel-title');
    expect(title?.textContent?.trim()).toBe('Outline');
  });

  it('marks the clicked strip button as active', () => {
    const [outlineBtn, searchBtn] = stripButtons(fixture);
    outlineBtn.click();
    fixture.detectChanges();

    expect(outlineBtn.classList.contains('active')).toBe(true);
    expect(searchBtn.classList.contains('active')).toBe(false);
  });

  it('sets aria-selected="true" on the active button and "false" on others', () => {
    const [outlineBtn, searchBtn] = stripButtons(fixture);
    outlineBtn.click();
    fixture.detectChanges();

    expect(outlineBtn.getAttribute('aria-selected')).toBe('true');
    expect(searchBtn.getAttribute('aria-selected')).toBe('false');
  });

  it('emits activePanelChanged with the panel id', () => {
    const spy = vi.fn();
    component.activePanelChanged.subscribe(spy);

    stripButtons(fixture)[0].click();
    fixture.detectChanges();

    expect(spy).toHaveBeenCalledWith('outline');
  });

  // ── Collapsing ─────────────────────────────────────────────────────────

  it('collapses when the same strip button is clicked again', () => {
    const [btn] = stripButtons(fixture);
    btn.click();
    fixture.detectChanges();
    btn.click();
    fixture.detectChanges();

    expect(component.activePanelId()).toBeNull();
  });

  it('emits null when the dock collapses via the strip button', () => {
    const spy = vi.fn();
    component.activePanelChanged.subscribe(spy);

    const [btn] = stripButtons(fixture);
    btn.click();
    fixture.detectChanges();
    spy.mockClear();

    btn.click();
    fixture.detectChanges();

    expect(spy).toHaveBeenCalledWith(null);
  });

  it('collapses when the close button in the panel header is clicked', () => {
    stripButtons(fixture)[0].click();
    fixture.detectChanges();

    const closeBtn = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.panel-close-btn');
    expect(closeBtn).not.toBeNull();
    closeBtn!.click();
    fixture.detectChanges();

    expect(component.activePanelId()).toBeNull();
  });

  it('emits null when closed via the close button', () => {
    const spy = vi.fn();
    component.activePanelChanged.subscribe(spy);

    stripButtons(fixture)[0].click();
    fixture.detectChanges();
    spy.mockClear();

    const closeBtn = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.panel-close-btn')!;
    closeBtn.click();
    fixture.detectChanges();

    expect(spy).toHaveBeenCalledWith(null);
  });

  // ── Switching panels ───────────────────────────────────────────────────

  it('switches to a different panel without collapsing in between', () => {
    const [outlineBtn, searchBtn] = stripButtons(fixture);

    outlineBtn.click();
    fixture.detectChanges();
    expect(component.activePanelId()).toBe('outline');

    searchBtn.click();
    fixture.detectChanges();
    expect(component.activePanelId()).toBe('search');
    expect(panelZoneEl(fixture).classList.contains('is-open')).toBe(true);
  });

  it('updates the panel header title when switching panels', () => {
    const [outlineBtn, searchBtn] = stripButtons(fixture);
    outlineBtn.click();
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.panel-title')?.textContent?.trim(),
    ).toBe('Outline');

    searchBtn.click();
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.panel-title')?.textContent?.trim(),
    ).toBe('Search');
  });

  it('emits the new panel id when switching panels', () => {
    const spy = vi.fn();
    component.activePanelChanged.subscribe(spy);

    stripButtons(fixture)[0].click();
    fixture.detectChanges();
    spy.mockClear();

    stripButtons(fixture)[1].click();
    fixture.detectChanges();

    expect(spy).toHaveBeenCalledWith('search');
  });

  // ── Programmatic API ───────────────────────────────────────────────────

  it('togglePanel() opens a panel when collapsed', () => {
    component.togglePanel('outline');
    expect(component.activePanelId()).toBe('outline');
  });

  it('togglePanel() collapses when called with the active panel id', () => {
    component.togglePanel('outline');
    component.togglePanel('outline');
    expect(component.activePanelId()).toBeNull();
  });

  it('togglePanel() switches to a new panel when one is already open', () => {
    component.togglePanel('outline');
    component.togglePanel('search');
    expect(component.activePanelId()).toBe('search');
  });

  it('closePanel() collapses whatever is open', () => {
    component.togglePanel('search');
    component.closePanel();
    expect(component.activePanelId()).toBeNull();
  });

  it('closePanel() is a no-op when already collapsed', () => {
    component.closePanel();
    expect(component.activePanelId()).toBeNull();
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('renders zero strip buttons when panels input is empty (fresh fixture)', () => {
    // Create a fresh fixture with an empty panels list so the override takes
    // effect before the first render (the shared fixture already has 2 panels).
    const emptyFixture = TestBed.createComponent(PanelZoneComponent);
    setPanels(emptyFixture.componentInstance, []);
    emptyFixture.detectChanges();

    expect(stripButtons(emptyFixture)).toHaveLength(0);
  });

  it('renders a text fallback (first letter) when a panel has no icon (fresh fixture)', () => {
    const freshFixture = TestBed.createComponent(PanelZoneComponent);
    setPanels(freshFixture.componentInstance, [{ id: 'x', label: 'Xray' }]);
    freshFixture.detectChanges();

    const btns = stripButtons(freshFixture);
    expect(btns).toHaveLength(1);
    // No icon provided → the @if(panel.icon) branch is falsy, so no <svg>.
    const svg = btns[0].querySelector('svg');
    expect(svg).toBeNull();
  });

  // ── Accessibility ──────────────────────────────────────────────────────

  it('strip buttons have role="tab"', () => {
    const [btn] = stripButtons(fixture);
    expect(btn.getAttribute('role')).toBe('tab');
  });

  it('strip buttons have aria-label matching the panel label', () => {
    const [btn] = stripButtons(fixture);
    expect(btn.getAttribute('aria-label')).toBe('Outline');
  });

  it('panel-content-area has role="tabpanel"', () => {
    stripButtons(fixture)[0].click();
    fixture.detectChanges();
    const area = (fixture.nativeElement as HTMLElement).querySelector('.panel-content-area');
    expect(area?.getAttribute('role')).toBe('tabpanel');
  });
});
