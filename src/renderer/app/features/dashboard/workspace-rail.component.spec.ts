import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { AutomationStore } from '../../core/state/automation.store';
import { WorkspaceRailComponent } from './workspace-rail.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './workspace-rail.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('workspace-rail.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('WorkspaceRailComponent', () => {
  let fixture: ComponentFixture<WorkspaceRailComponent>;
  const unreadCount = signal(2);
  const markAllSeen = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    unreadCount.set(2);
    markAllSeen.mockClear();
    await TestBed.configureTestingModule({
      imports: [WorkspaceRailComponent, RouterTestingModule.withRoutes([])],
      providers: [
        {
          provide: AutomationStore,
          useValue: {
            unreadCount: unreadCount.asReadonly(),
            markAllSeen,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkspaceRailComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((node) => node.remove());
  });

  function automationsLink(): HTMLAnchorElement {
    return fixture.nativeElement.querySelector('a[aria-label="Automations"]') as HTMLAnchorElement;
  }

  function renderedMenu(): HTMLElement | null {
    return document.body.querySelector('.context-menu');
  }

  it('shows the unread automations badge on the rail destination', () => {
    expect(automationsLink().querySelector('.rail-badge')?.textContent).toBe('2');
    expect(automationsLink().getAttribute('aria-haspopup')).toBe('menu');
    expect(automationsLink().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a clear-notifications menu on right-click and marks every run seen', () => {
    automationsLink().dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 18,
      clientY: 42,
    }));
    fixture.detectChanges();

    expect(automationsLink().getAttribute('aria-expanded')).toBe('true');

    const item = renderedMenu()?.querySelector('button[role="menuitem"]') as HTMLButtonElement;
    expect(item?.textContent).toContain('Clear notifications');
    expect(item.disabled).toBe(false);

    item.click();
    fixture.detectChanges();

    expect(markAllSeen).toHaveBeenCalledTimes(1);
  });

  it('disables clear-notifications when nothing is unread', () => {
    unreadCount.set(0);
    fixture.detectChanges();

    automationsLink().dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 18,
      clientY: 42,
    }));
    fixture.detectChanges();

    const item = renderedMenu()?.querySelector('button[role="menuitem"]') as HTMLButtonElement;
    expect(item.disabled).toBe(true);

    item.click();
    expect(markAllSeen).not.toHaveBeenCalled();
  });
});
