import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { NestedMenuComponent } from './nested-menu.component';
import type { MenuItem, MenuModel } from './menu.types';

interface Payload { kind: string; }

function leaf(id: string, overrides: Partial<MenuItem<Payload>> = {}): MenuItem<Payload> {
  return { id, label: id, payload: { kind: id }, ...overrides };
}

function model(items: MenuItem<Payload>[][], emptyStateLabel?: string): MenuModel<Payload> {
  return {
    sections: items.map((sectionItems, idx) => ({
      id: `s${idx}`,
      items: sectionItems,
    })),
    emptyStateLabel,
  };
}

function dispatchKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  target.dispatchEvent(event);
  return event;
}

describe('NestedMenuComponent', () => {
  let fixture: ComponentFixture<NestedMenuComponent<Payload>>;
  let menuRoot: HTMLDivElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [NestedMenuComponent] });
    fixture = TestBed.createComponent<NestedMenuComponent<Payload>>(NestedMenuComponent);
  });

  function attach(m: MenuModel<Payload>): void {
    fixture.componentInstance.model = m;
    fixture.detectChanges();
    menuRoot = fixture.nativeElement.querySelector('.nested-menu') as HTMLDivElement;
  }

  it('renders a role="menu" container with the expected items', () => {
    attach(model([[leaf('a'), leaf('b'), leaf('c')]]));
    expect(menuRoot.getAttribute('role')).toBe('menu');
    const labels = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__label'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(labels).toEqual(['a', 'b', 'c']);
  });

  it('renders the empty state label when the model has no items', () => {
    attach(model([], 'No additional versions available'));
    expect(fixture.nativeElement.textContent).toContain('No additional versions available');
  });

  it('renders dividers between sections', () => {
    attach(model([[leaf('a')], [leaf('b')]]));
    const dividers = fixture.nativeElement.querySelectorAll('hr.nested-menu__divider');
    expect(dividers.length).toBe(1);
  });

  it('renders section labels when provided, omits when not', () => {
    fixture.componentInstance.model = {
      sections: [
        { id: 's0', items: [leaf('a')] },
        { id: 's1', label: 'Other versions', items: [leaf('b')] },
      ],
    };
    fixture.detectChanges();
    const labels = Array.from(fixture.nativeElement.querySelectorAll('.nested-menu__section-label'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(labels).toEqual(['Other versions']);
  });

  it('ArrowDown moves focus through items, wrapping at end', () => {
    attach(model([[leaf('a'), leaf('b')]]));

    dispatchKey(menuRoot, 'ArrowDown');
    fixture.detectChanges();
    let focused = fixture.nativeElement.querySelector('[tabindex="0"]') as HTMLElement;
    expect(focused.textContent).toContain('a');

    dispatchKey(menuRoot, 'ArrowDown');
    fixture.detectChanges();
    focused = fixture.nativeElement.querySelector('[tabindex="0"]') as HTMLElement;
    expect(focused.textContent).toContain('b');

    dispatchKey(menuRoot, 'ArrowDown');
    fixture.detectChanges();
    focused = fixture.nativeElement.querySelector('[tabindex="0"]') as HTMLElement;
    expect(focused.textContent).toContain('a');
  });

  it('ArrowUp wraps from first to last', () => {
    attach(model([[leaf('a'), leaf('b'), leaf('c')]]));

    dispatchKey(menuRoot, 'ArrowDown');
    dispatchKey(menuRoot, 'ArrowUp');
    fixture.detectChanges();
    const focused = fixture.nativeElement.querySelector('[tabindex="0"]') as HTMLElement;
    expect(focused.textContent).toContain('c');
  });

  it('Home/End jump to first and last items across sections', () => {
    attach(model([[leaf('a'), leaf('b')], [leaf('c')]]));

    dispatchKey(menuRoot, 'End');
    fixture.detectChanges();
    let focused = fixture.nativeElement.querySelector('[tabindex="0"]') as HTMLElement;
    expect(focused.textContent).toContain('c');

    dispatchKey(menuRoot, 'Home');
    fixture.detectChanges();
    focused = fixture.nativeElement.querySelector('[tabindex="0"]') as HTMLElement;
    expect(focused.textContent).toContain('a');
  });

  it('Enter on a leaf emits itemSelect', () => {
    attach(model([[leaf('a'), leaf('b')]]));
    let emitted: MenuItem<Payload> | null = null;
    fixture.componentInstance.itemSelect.subscribe((item) => (emitted = item));

    dispatchKey(menuRoot, 'ArrowDown');
    dispatchKey(menuRoot, 'Enter');

    expect(emitted).not.toBeNull();
    expect(emitted!.id).toBe('a');
  });

  it('Enter on a disabled item does not emit', () => {
    attach(model([[leaf('a', { disabledReason: 'nope' })]]));
    let emitted = false;
    fixture.componentInstance.itemSelect.subscribe(() => (emitted = true));

    dispatchKey(menuRoot, 'ArrowDown');
    dispatchKey(menuRoot, 'Enter');

    expect(emitted).toBe(false);
  });

  it('ArrowRight on a parent opens its submenu', () => {
    const parent = leaf('parent', {
      submenu: model([[leaf('child-a')]]),
    });
    attach(model([[parent]]));

    dispatchKey(menuRoot, 'ArrowDown');
    dispatchKey(menuRoot, 'ArrowRight');
    fixture.detectChanges();

    expect(fixture.componentInstance.openSubmenuId()).toBe('parent');
  });

  it('ArrowLeft closes an open submenu, then dismisses the menu when none open', () => {
    const parent = leaf('parent', { submenu: model([[leaf('child')]]) });
    attach(model([[parent]]));
    let dismissed = false;
    fixture.componentInstance.dismiss.subscribe(() => (dismissed = true));

    dispatchKey(menuRoot, 'ArrowDown');
    dispatchKey(menuRoot, 'ArrowRight');
    expect(fixture.componentInstance.openSubmenuId()).toBe('parent');

    dispatchKey(menuRoot, 'ArrowLeft');
    fixture.detectChanges();
    expect(fixture.componentInstance.openSubmenuId()).toBeNull();
    expect(dismissed).toBe(false);

    dispatchKey(menuRoot, 'ArrowLeft');
    expect(dismissed).toBe(true);
  });

  it('Escape and Tab both emit dismiss', () => {
    attach(model([[leaf('a')]]));
    let dismissCount = 0;
    fixture.componentInstance.dismiss.subscribe(() => dismissCount++);

    dispatchKey(menuRoot, 'Escape');
    dispatchKey(menuRoot, 'Tab');

    expect(dismissCount).toBe(2);
  });

  it('Space on a parent opens its submenu', () => {
    const parent = leaf('parent', { submenu: model([[leaf('child')]]) });
    attach(model([[parent]]));

    dispatchKey(menuRoot, 'ArrowDown');
    dispatchKey(menuRoot, ' ');

    expect(fixture.componentInstance.openSubmenuId()).toBe('parent');
  });

  it('autoFocus focuses the first item on mount', async () => {
    fixture.componentInstance.model = model([[leaf('a'), leaf('b')]]);
    fixture.componentInstance.autoFocus = true;
    fixture.detectChanges();
    // Drain the microtask queue so queueMicrotask() inside ngAfterViewInit runs.
    await Promise.resolve();
    fixture.detectChanges();

    const focused = document.activeElement as HTMLElement;
    expect(focused?.textContent).toContain('a');
  });
});
