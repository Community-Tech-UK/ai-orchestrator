import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelIpcService } from '../../core/services/ipc/model-ipc.service';
import { ModelsPageComponent } from './models-page.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './models-page.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('models-page.component.scss')) {
    return Promise.resolve(styles);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('ModelsPageComponent', () => {
  let component: ModelsPageComponent;
  let fixture: ComponentFixture<ModelsPageComponent>;
  let modelIpc: {
    discoverModels: ReturnType<typeof vi.fn>;
    verifyModel: ReturnType<typeof vi.fn>;
    listProviderModels: ReturnType<typeof vi.fn>;
    listCopilotModels: ReturnType<typeof vi.fn>;
    setOverride: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    modelIpc = {
      discoverModels: vi.fn().mockResolvedValue({ success: true, data: [] }),
      verifyModel: vi.fn(),
      listProviderModels: vi.fn(),
      listCopilotModels: vi.fn(),
      setOverride: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [ModelsPageComponent],
      providers: [
        { provide: ModelIpcService, useValue: modelIpc },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ModelsPageComponent);
    component = fixture.componentInstance;
  });

  it('renders a Verify all button for the active provider list', async () => {
    modelIpc.discoverModels.mockResolvedValueOnce({
      success: true,
      data: [{ id: 'opus', name: 'Opus', provider: 'claude' }],
    });

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const verifyAllButton = fixture.nativeElement.querySelector('.verify-all-btn');

    expect(verifyAllButton?.textContent).toContain('Verify all');
  });

  it('verifies visible models and lists the ones that do not pass', async () => {
    component.activeProvider.set('claude');
    component.models.set([
      { id: 'opus', name: 'Opus', provider: 'claude', status: 'available' },
      { id: 'sonnet', name: 'Sonnet', provider: 'claude', status: 'available' },
      { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'codex', status: 'available' },
    ]);
    modelIpc.verifyModel.mockImplementation((modelId: string) =>
      Promise.resolve(
        modelId === 'sonnet'
          ? { success: false, error: { message: 'not authorized' } }
          : { success: true, data: true },
      ),
    );

    await component.verifyAllVisibleModels();

    expect(modelIpc.verifyModel).toHaveBeenCalledTimes(2);
    expect(modelIpc.verifyModel).toHaveBeenNthCalledWith(1, 'opus');
    expect(modelIpc.verifyModel).toHaveBeenNthCalledWith(2, 'sonnet');
    expect(component.models()).toEqual([
      { id: 'opus', name: 'Opus', provider: 'claude', status: 'verified' },
      { id: 'sonnet', name: 'Sonnet', provider: 'claude', status: 'error' },
      { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'codex', status: 'available' },
    ]);
    expect(component.verificationFailures()).toEqual([
      { id: 'sonnet', name: 'Sonnet', provider: 'claude', message: 'not authorized' },
    ]);
  });
});
