import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { CdkConnectedOverlay } from '@angular/cdk/overlay';
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

  function renderedMenu(): HTMLElement | null {
    return document.body.querySelector('.context-menu');
  }

  function connectedOverlay(): CdkConnectedOverlay {
    const debugNode = fixture.debugElement.queryAllNodes(By.directive(CdkConnectedOverlay))[0];
    return debugNode.injector.get(CdkConnectedOverlay);
  }

  it('renders dividers before divided actions without adding extra menu items', () => {
    render([
      { id: 'copy', label: 'Copy', action: vi.fn() },
      { id: 'fork', label: 'Fork from here', divider: true, action: vi.fn() },
    ]);

    const menu = renderedMenu();
    expect(menu?.querySelectorAll('.context-menu-divider')).toHaveLength(1);
    expect(menu?.querySelectorAll('button[role="menuitem"]')).toHaveLength(2);
  });

  it('mounts the menu in the document overlay so clipping ancestors cannot cover it', () => {
    render([{ id: 'copy', label: 'Copy', action: vi.fn() }]);

    const fixtureHost = fixture.nativeElement as HTMLElement;
    const menu = renderedMenu();
    expect(fixtureHost.querySelector('.context-menu')).toBeNull();
    expect(menu).not.toBeNull();
    expect(menu!.closest('.cdk-overlay-container')).not.toBeNull();
  });

  it('closes and runs the selected action', () => {
    const action = vi.fn();
    render([{ id: 'copy', label: 'Copy', action }]);

    const button = renderedMenu()?.querySelector('button') as HTMLButtonElement;
    button.click();

    expect(fixture.componentInstance.closed).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not run disabled actions', () => {
    const action = vi.fn();
    render([{ id: 'copy', label: 'Copy', disabled: true, action }]);

    const button = renderedMenu()?.querySelector('button') as HTMLButtonElement;
    button.click();

    expect(fixture.componentInstance.closed).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('pushes the point-anchored menu inside an eight-pixel viewport margin', () => {
    render([{ id: 'copy', label: 'Copy', action: vi.fn() }], { x: 280, y: 190 });

    const overlay = connectedOverlay();
    expect(overlay.origin).toEqual({ x: 280, y: 190 });
    expect(overlay.viewportMargin).toBe(8);
    expect(overlay.flexibleDimensions).toBe(false);
    expect(overlay.push).toBe(true);
  });
});
