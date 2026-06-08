import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupCapabilityReport } from '../../../../shared/types/startup-capability.types';
import { ElectronIpcService } from '../../core/services/ipc';
import { FirstRunService } from '../../core/services/first-run.service';
import { SetupCenterComponent } from './setup-center.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './setup-center.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './setup-center.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('setup-center.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('setup-center.component.scss')) {
    return Promise.resolve(styles);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const readyReport: StartupCapabilityReport = {
  status: 'ready',
  generatedAt: 1710000000000,
  checks: [
    {
      id: 'provider.codex',
      label: 'Codex CLI',
      category: 'provider',
      status: 'ready',
      critical: false,
      summary: 'Codex is ready.',
    },
  ],
};

describe('SetupCenterComponent', () => {
  let fixture: ComponentFixture<SetupCenterComponent>;
  let router: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    router = { navigate: vi.fn().mockResolvedValue(true) };

    TestBed.overrideComponent(SetupCenterComponent, {
      set: {
        template,
        templateUrl: undefined,
        styles: [styles],
        styleUrl: undefined,
        styleUrls: [],
      },
    });

    await TestBed.configureTestingModule({
      imports: [SetupCenterComponent],
      providers: [
        { provide: Router, useValue: router },
        {
          provide: ElectronIpcService,
          useValue: {
            getStartupCapabilities: vi.fn(async () => readyReport),
          },
        },
        { provide: FirstRunService, useValue: { markCompleted: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SetupCenterComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders a back arrow that returns to the workspace', () => {
    const backButton = fixture.nativeElement.querySelector('.setup-back-btn') as HTMLButtonElement | null;

    expect(backButton).not.toBeNull();
    expect(backButton?.getAttribute('aria-label')).toBe('Back to workspace');

    backButton?.click();

    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });
});
