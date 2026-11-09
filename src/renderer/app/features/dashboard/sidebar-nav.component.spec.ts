import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { AutomationStore } from '../../core/state/automation.store';
import { DocReviewStore } from '../doc-review/doc-review.store';
import { SidebarNavComponent } from './sidebar-nav.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './sidebar-nav.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('sidebar-nav.component.scss')) {
    return Promise.resolve(styles);
  }
  // Angular's resource resolver is global within the shared Vitest worker.
  // Neighboring specs can leave unrelated component resources pending, so this
  // spec only owns the sidebar stylesheet and harmlessly resolves the rest.
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('SidebarNavComponent', () => {
  let fixture: ComponentFixture<SidebarNavComponent>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [SidebarNavComponent, RouterTestingModule.withRoutes([{ path: '**', children: [] }])],
      providers: [
        {
          provide: AutomationStore,
          useValue: {
            unreadCount: signal(2).asReadonly(),
          },
        },
        { provide: DocReviewStore, useValue: { pendingCount: signal(3).asReadonly() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SidebarNavComponent);
    fixture.detectChanges();
  });

  it('lists one entry per hub instead of every tool', () => {
    const links = [...fixture.nativeElement.querySelectorAll('a.nav-item')] as HTMLAnchorElement[];
    const names = links.map(link => link.querySelector('.nav-label')?.textContent?.trim());

    expect(names).toEqual([
      'Work', 'Automations', 'Reviews', 'Agents & models', 'Memory & knowledge', 'Code', 'Search',
      'Usage & health', 'Browser', 'Connections', 'Storage',
    ]);
    expect(fixture.nativeElement.textContent).not.toContain('More tools');
  });

  it('opens each hub on its first dashboard page', () => {
    const links = [...fixture.nativeElement.querySelectorAll('a.nav-item')] as HTMLAnchorElement[];
    const href = (label: string) => links.find(link => link.getAttribute('aria-label') === label)?.getAttribute('href');

    expect(href('Work')).toBe('/work');
    expect(href('Agents & models')).toBe('/models');
    expect(href('Browser')).toBe('/browser');
  });

  it('shows the unread automation count on the Automations hub, and says it in the hub name', () => {
    const link = fixture.nativeElement.querySelector('a[aria-label="Automations, 2 waiting"]');

    expect(link?.querySelector('.nav-badge')?.textContent?.trim()).toBe('2');
    expect(fixture.nativeElement.querySelector('a[aria-label="Work"]')).not.toBeNull();
  });

  it('says the pending doc review count in the Reviews hub name', () => {
    const link = fixture.nativeElement.querySelector('a[aria-label="Reviews, 3 waiting"]');

    expect(link?.querySelector('.nav-badge')?.textContent?.trim()).toBe('3');
  });

  it('marks the hub of any open page, not only the page it opens on', async () => {
    const active = () => [...fixture.nativeElement.querySelectorAll('a.nav-item[aria-current="true"]')]
      .map(link => (link as HTMLAnchorElement).getAttribute('aria-label'));
    expect(active()).toEqual([]);

    await TestBed.inject(Router).navigateByUrl('/plan-queue');
    fixture.detectChanges();
    expect(active()).toEqual(['Work']);
    expect(fixture.nativeElement.querySelector('a.nav-item.active')?.getAttribute('aria-label')).toBe('Work');

    await TestBed.inject(Router).navigateByUrl('/memory/stats?tab=1');
    fixture.detectChanges();
    expect(active()).toEqual(['Memory & knowledge']);
  });

  it('does not render the Control Center Settings route in dashboard Tools & Views', () => {
    const settingsLink = fixture.nativeElement.querySelector('a[href="/settings"]') as HTMLAnchorElement | null;

    expect(settingsLink).toBeNull();
  });
});
