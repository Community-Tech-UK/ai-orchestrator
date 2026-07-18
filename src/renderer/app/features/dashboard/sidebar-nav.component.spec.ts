import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { AutomationStore } from '../../core/state/automation.store';
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
    await TestBed.configureTestingModule({
      imports: [SidebarNavComponent, RouterTestingModule.withRoutes([])],
      providers: [
        {
          provide: AutomationStore,
          useValue: {
            unreadCount: signal(2).asReadonly(),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SidebarNavComponent);
    fixture.detectChanges();
  });

  it('renders dashboard tools from the Control Surface registry', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Automations');
    expect(text).toContain('Browser Gateway');
    expect(text).toContain('Models');
    expect(text).toContain('Background Jobs');
    expect(text).toContain('Workboard');
  });

  it('does not render the Control Center Settings route in dashboard Tools & Views', () => {
    const settingsLink = fixture.nativeElement.querySelector('a[href="/settings"]') as HTMLAnchorElement | null;

    expect(settingsLink).toBeNull();
  });
});
