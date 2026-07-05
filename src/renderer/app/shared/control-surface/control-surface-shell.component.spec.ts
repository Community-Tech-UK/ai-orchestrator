import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ControlSurfaceShellComponent } from './control-surface-shell.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './control-surface-shell.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './control-surface-shell.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('control-surface-shell.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('control-surface-shell.component.scss')) {
    return Promise.resolve(styles);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('ControlSurfaceShellComponent', () => {
  let fixture: ComponentFixture<ControlSurfaceShellComponent>;
  let router: Router;

  beforeEach(async () => {
    const route = {
      snapshot: { data: {} },
      firstChild: {
        snapshot: { data: { controlSurfaceId: 'automations' } },
        firstChild: null,
      },
    };

    await TestBed.configureTestingModule({
      imports: [ControlSurfaceShellComponent, RouterTestingModule.withRoutes([])],
      providers: [
        { provide: ActivatedRoute, useValue: route },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    fixture = TestBed.createComponent(ControlSurfaceShellComponent);
    fixture.detectChanges();
  });

  it('renders a visible text Back button', () => {
    const button = fixture.nativeElement.querySelector('.control-back') as HTMLButtonElement | null;

    expect(button?.textContent?.trim()).toContain('Back');
  });

  it('navigates to the active surface back route or dashboard', () => {
    const button = fixture.nativeElement.querySelector('.control-back') as HTMLButtonElement;

    button.click();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('renders title and grouped Control Center navigation from the registry', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Control Center');
    expect(text).toContain('Automations');
    expect(text).toContain('Settings');
    expect(text).toContain('Browser Gateway');
  });
});
