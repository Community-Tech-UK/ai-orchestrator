import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import {
  resolveComputerUsePresentation,
  SessionComputerUseControlComponent,
} from './session-computer-use-control.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const resources: Record<string, string> = {
  'session-computer-use-control.component.html': readFileSync(
    resolve(specDirectory, './session-computer-use-control.component.html'),
    'utf8',
  ),
  'session-computer-use-control.component.scss': readFileSync(
    resolve(specDirectory, './session-computer-use-control.component.scss'),
    'utf8',
  ),
};

await resolveComponentResources((url) => {
  const resource = Object.entries(resources).find(([name]) => url.endsWith(name));
  return resource
    ? Promise.resolve(resource[1])
    : Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('SessionComputerUseControlComponent', () => {
  const setComputerUseMode = vi.fn().mockResolvedValue({ success: true });

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [SessionComputerUseControlComponent],
      providers: [
        {
          provide: ElectronIpcService,
          useValue: { getApi: () => ({ setComputerUseMode }) },
        },
        {
          provide: SettingsStore,
          useValue: { settings: signal({ computerUseAutonomyLevel: 'trusted' }) },
        },
      ],
    }).compileComponents();
  });

  it('distinguishes global, elevated, and lowered states', () => {
    expect(resolveComputerUsePresentation(undefined, 'trusted').relation).toBe('global');
    expect(resolveComputerUsePresentation('unrestricted', 'trusted').relation).toBe('elevated');
    expect(resolveComputerUsePresentation('guarded', 'trusted').relation).toBe('lowered');
    expect(resolveComputerUsePresentation('trusted', 'trusted').relation).toBe('session');
  });

  it('sends one preload request for a changed selection', async () => {
    const fixture = TestBed.createComponent(SessionComputerUseControlComponent);
    fixture.componentRef.setInput('instance', { id: 'instance-1' });
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'unrestricted';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(setComputerUseMode).toHaveBeenCalledOnce();
    expect(setComputerUseMode).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      mode: 'unrestricted',
    });
    expect(fixture.nativeElement.textContent).toContain('next call · no restart · session only');
  });

  it('maps the Global option to a null override', async () => {
    const fixture = TestBed.createComponent(SessionComputerUseControlComponent);
    fixture.componentRef.setInput('instance', {
      id: 'instance-1',
      computerUseMode: 'guarded',
    });
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'global';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(setComputerUseMode).toHaveBeenCalledWith({ instanceId: 'instance-1', mode: null });
  });
});
