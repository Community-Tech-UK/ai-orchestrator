import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHeaderComponent } from './page-header.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(resolve(specDirectory, './page-header.component.ts'), 'utf8');

interface PageHeaderInputOverrides {
  title: () => string;
  subtitle: () => string | null;
  backRoute: () => string | null;
}

function setInputs(component: PageHeaderComponent): void {
  const target = component as unknown as PageHeaderInputOverrides;
  target.title = () => 'Automations';
  target.subtitle = () => 'Scheduled work';
  target.backRoute = () => '/';
}

describe('PageHeaderComponent', () => {
  let fixture: ComponentFixture<PageHeaderComponent>;
  let router: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    router = { navigate: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [PageHeaderComponent],
      providers: [{ provide: Router, useValue: router }],
    }).compileComponents();

    fixture = TestBed.createComponent(PageHeaderComponent);
    setInputs(fixture.componentInstance);
    fixture.detectChanges();
  });

  it('renders title, subtitle, and a visible Back label', () => {
    expect(fixture.nativeElement.textContent).toContain('Automations');
    expect(fixture.nativeElement.textContent).toContain('Scheduled work');
    expect(fixture.nativeElement.textContent).toContain('Back');
  });

  it('keeps an actions projection slot', () => {
    expect(componentSource).toContain('<ng-content select="[actions]"></ng-content>');
  });

  it('navigates to the configured back route', () => {
    const button = fixture.nativeElement.querySelector('.back-btn') as HTMLButtonElement;

    button.click();

    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });
});
