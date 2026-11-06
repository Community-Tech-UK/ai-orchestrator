import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { MenuItemComponent } from './menu-item.component';
import type { MenuItem } from './menu.types';

interface Payload { kind: string; }

function leaf(id: string, overrides: Partial<MenuItem<Payload>> = {}): MenuItem<Payload> {
  return {
    id,
    label: id,
    payload: { kind: id },
    ...overrides,
  };
}

const submenuModel = (id: string) => ({
  sections: [{ id: 's', items: [leaf(id)] }],
});

describe('MenuItemComponent', () => {
  let fixture: ComponentFixture<MenuItemComponent<Payload>>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MenuItemComponent] });
    fixture = TestBed.createComponent<MenuItemComponent<Payload>>(MenuItemComponent);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setItem(item: MenuItem<Payload>): void {
    fixture.componentRef.setInput('item', item);
    fixture.detectChanges();
  }

  it('emits itemSelect when the row is clicked', () => {
    setItem(leaf('opus'));
    let emitted: MenuItem<Payload> | null = null;
    fixture.componentInstance.itemSelect.subscribe((item) => (emitted = item));

    rowButton(fixture).click();

    expect(emitted).not.toBeNull();
    expect(emitted!.id).toBe('opus');
  });

  it('renders aria-checked="true" and a check glyph when selected', () => {
    setItem(leaf('opus', { selected: true }));

    expect(rowButton(fixture).getAttribute('aria-checked')).toBe('true');
    expect(fixture.nativeElement.textContent).toContain('✓');
  });

  it('keeps disabled items focusable and explains the reason on keyboard focus', () => {
    setItem(leaf('locked', { disabledReason: 'Pick a provider first' }));

    const row = rowButton(fixture);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.disabled).toBe(false);
    expect(row.hasAttribute('title')).toBe(false);
    fixture.componentRef.setInput('focused', true);
    fixture.detectChanges();
    vi.spyOn(row, 'matches').mockImplementation(selector => selector === ':focus-visible');
    row.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(row);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Pick a provider first');
    const selected = vi.fn();
    fixture.componentInstance.itemSelect.subscribe(selected);
    row.click();
    expect(selected).not.toHaveBeenCalled();
    setItem(leaf('locked'));
    expect(row.hasAttribute('aria-disabled')).toBe(false);
    row.click();
    expect(selected).toHaveBeenCalledOnce();
  });

  it('disabled row click does not emit', () => {
    setItem(leaf('locked', { disabledReason: 'no' }));
    let emitted = false;
    fixture.componentInstance.itemSelect.subscribe(() => (emitted = true));

    rowButton(fixture).click();

    expect(emitted).toBe(false);
  });

  it('explains a disabled row on keyboard focus and re-enables it when the reason clears', () => {
    fixture.componentRef.setInput('focused', true);
    setItem(leaf('locked', { disabledReason: 'Pick a provider first' }));
    const row = rowButton(fixture);
    const matches = row.matches.bind(row);
    vi.spyOn(row, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    row.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Pick a provider first');
    expect(row.hasAttribute('title')).toBe(false);
    setItem(leaf('locked'));
    expect(row.hasAttribute('aria-disabled')).toBe(false);
    const selected = vi.fn();
    fixture.componentInstance.itemSelect.subscribe(selected);
    row.click();
    expect(selected).toHaveBeenCalledOnce();
  });

  it('renders the chevron only when item has a submenu', () => {
    setItem(leaf('plain'));
    expect(chevronButton(fixture)).toBeNull();

    setItem(leaf('parent', { submenu: submenuModel('child') }));
    expect(chevronButton(fixture)).not.toBeNull();
  });

  it('chevron click emits openSubmenu, not itemSelect', () => {
    setItem(leaf('parent', { submenu: submenuModel('child') }));
    let openEmitted = false;
    let selectEmitted = false;
    fixture.componentInstance.openSubmenu.subscribe(() => (openEmitted = true));
    fixture.componentInstance.itemSelect.subscribe(() => (selectEmitted = true));

    chevronButton(fixture)!.click();

    expect(openEmitted).toBe(true);
    expect(selectEmitted).toBe(false);
  });

  it('hovering an item with submenu emits openSubmenu after the delay', () => {
    vi.useFakeTimers();
    setItem(leaf('parent', { submenu: submenuModel('child') }));
    let opened = false;
    fixture.componentInstance.openSubmenu.subscribe(() => (opened = true));

    rowEl(fixture).dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(50);
    expect(opened).toBe(false);
    vi.advanceTimersByTime(80);
    expect(opened).toBe(true);
  });

  it('mouseleave cancels the hover-open timer', () => {
    vi.useFakeTimers();
    setItem(leaf('parent', { submenu: submenuModel('child') }));
    let opened = false;
    fixture.componentInstance.openSubmenu.subscribe(() => (opened = true));

    rowEl(fixture).dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(50);
    rowEl(fixture).dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(200);

    expect(opened).toBe(false);
  });

  it('hover on an item without submenu never emits', () => {
    vi.useFakeTimers();
    setItem(leaf('plain'));
    let opened = false;
    fixture.componentInstance.openSubmenu.subscribe(() => (opened = true));

    rowEl(fixture).dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(500);

    expect(opened).toBe(false);
  });
});

function rowButton(fixture: ComponentFixture<MenuItemComponent<Payload>>): HTMLButtonElement {
  return fixture.nativeElement.querySelector('.menu-item-row__body') as HTMLButtonElement;
}

function chevronButton(fixture: ComponentFixture<MenuItemComponent<Payload>>): HTMLButtonElement | null {
  return fixture.nativeElement.querySelector('.menu-item-row__chevron') as HTMLButtonElement | null;
}

function rowEl(fixture: ComponentFixture<MenuItemComponent<Payload>>): HTMLElement {
  return fixture.nativeElement.querySelector('.menu-item-row') as HTMLElement;
}
