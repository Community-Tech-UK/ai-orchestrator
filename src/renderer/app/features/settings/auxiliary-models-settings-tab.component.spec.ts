import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { AuxiliaryModelsSettingsTabComponent } from './auxiliary-models-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { AuxiliaryLlmIpcService } from '../../core/services/ipc/auxiliary-llm-ipc.service';

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('AuxiliaryModelsSettingsTabComponent', () => {
  const mockCandidates = [
    {
      endpoint: {
        id: 'ollama-localhost',
        label: 'Ollama (localhost)',
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        source: 'localhost',
        enabled: true,
      },
      models: [],
      healthy: true,
    },
  ];

  const store = {
    get: vi.fn((key: string) => {
      if (key === 'auxiliaryLlmEnabled') return true;
      if (key === 'auxiliaryLlmRoutingMode') return 'local-first';
      return undefined;
    }),
    set: vi.fn(),
  };

  const ipc = {
    listCandidates: vi.fn(async () => ({ success: true, data: mockCandidates })),
    probeEndpoint: vi.fn(async () => ({ success: true, data: { healthy: true } })),
    testGenerate: vi.fn(async () => ({
      success: true,
      data: {
        text: 'Hello!',
        decision: {
          slot: 'titleGeneration',
          provider: 'ollama',
          source: 'local',
          reason: 'local-first',
        },
      },
    })),
    saveSettings: vi.fn(async () => ({ success: true, data: { ok: true } })),
  };

  let fixture: ComponentFixture<AuxiliaryModelsSettingsTabComponent>;

  beforeEach(async () => {
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [AuxiliaryModelsSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: AuxiliaryLlmIpcService, useValue: ipc },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AuxiliaryModelsSettingsTabComponent);
  });

  it('renders without error', () => {
    expect(() => fixture.detectChanges()).not.toThrow();
    expect(fixture.nativeElement).toBeTruthy();
  });

  it('calls listCandidates on init', async () => {
    fixture.detectChanges();
    // Wait for the async ngOnInit to settle
    await fixture.whenStable();
    expect(ipc.listCandidates).toHaveBeenCalledOnce();
  });

  it('displays routing mode selector', () => {
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
  });
});
