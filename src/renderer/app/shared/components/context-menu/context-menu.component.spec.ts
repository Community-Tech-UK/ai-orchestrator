import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ContextMenuComponent, type ContextMenuItem } from './context-menu.component';

@Component({
  standalone: true,
  imports: [ContextMenuComponent],
  template: `
    <app-context-menu
      [items]="items"
      [x]="x"
      [y]="y"
      [visible]="visible"
      (closed)="closed()"
    />
  `,
})
class ContextMenuHostComponent {
  items: ContextMenuItem[] = [];
  x = 12;
  y = 16;
  visible = true;
  closed = vi.fn();
}

describe('ContextMenuComponent', () => {
  let fixture: ComponentFixture<ContextMenuHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ContextMenuHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ContextMenuHostComponent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function render(items: ContextMenuItem[], options: { x?: number; y?: number; visible?: boolean } = {}): void {
    fixture.componentInstance.items = items;
    fixture.componentInstance.x = options.x ?? 12;
    fixture.componentInstance.y = options.y ?? 16;
    fixture.componentInstance.visible = options.visible ?? true;
    fixture.detectChanges();
  }

  function menuComponent(): ContextMenuComponent {
    return fixture.debugElement.query(By.directive(ContextMenuComponent)).componentInstance as ContextMenuComponent;
  }

  it('renders dividers before divided actions without adding extra menu items', () => {
    render([
      { id: 'copy', label: 'Copy', action: vi.fn() },
      { id: 'fork', label: 'Fork from here', divider: true, action: vi.fn() },
    ]);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.context-menu-divider')).toHaveLength(1);
    expect(host.querySelectorAll('button[role="menuitem"]')).toHaveLength(2);
  });

  it('closes and runs the selected action', () => {
    const action = vi.fn();
    render([{ id: 'copy', label: 'Copy', action }]);

    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    button.click();

    expect(fixture.componentInstance.closed).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not run disabled actions', () => {
    const action = vi.fn();
    render([{ id: 'copy', label: 'Copy', disabled: true, action }]);

    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    button.click();

    expect(fixture.componentInstance.closed).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps the menu inside the viewport when repositioned', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 160,
      width: 200,
      height: 160,
      toJSON: () => ({}),
    } as DOMRect);

    render([{ id: 'copy', label: 'Copy', action: vi.fn() }], { x: 280, y: 190 });
    menuComponent().onWindowResize();
    fixture.detectChanges();

    const menu = (fixture.nativeElement as HTMLElement).querySelector('.context-menu') as HTMLElement;
    expect(menu.style.left).toBe('92px');
    expect(menu.style.top).toBe('32px');
  });
});
