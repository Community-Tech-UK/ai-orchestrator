import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { signal } from '@angular/core';
import { ReviewSettingsTabComponent } from './review-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { UnifiedCatalogStore } from '../models/unified-catalog.store';
import {
  CrossModelReviewIpcService,
  type ReviewerNotice,
} from '../../core/services/ipc/cross-model-review-ipc.service';
import type { SettingMetadata } from '../../../../shared/types/settings-metadata.types';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const reviewProviderSetting: SettingMetadata = {
  key: 'crossModelReviewProviders',
  label: 'Reviewer CLIs',
  description: 'Reviewer priority',
  type: 'multi-select',
  category: 'review',
  options: [],
};

const localReviewSettings: SettingMetadata[] = [
  {
    key: 'crossModelReviewLocalEnabled',
    label: 'Enable local reviewer',
    description: 'Enable local reviewer',
    type: 'boolean',
    category: 'review',
  },
  {
    key: 'crossModelReviewLocalSelectorId',
    label: 'Local reviewer model',
    description: 'Local reviewer model',
    type: 'select',
    category: 'review',
  },
  {
    key: 'crossModelReviewLocalTimeout',
    label: 'Local reviewer timeout (seconds)',
    description: 'Local timeout',
    type: 'number',
    category: 'review',
    min: 10,
    max: 600,
  },
  {
    key: 'crossModelReviewLocalMaxToolRounds',
    label: 'Local reviewer max tool rounds',
    description: 'Local tool rounds',
    type: 'number',
    category: 'review',
    min: 1,
    max: 32,
  },
];

const localSelectorId = 'lm://this-device/ollama/ollama/qwen2.5-coder%3A14b';
const localModels: ModelDisplayInfo[] = [
  {
    id: localSelectorId,
    name: 'Qwen 2.5 Coder 14B on This device',
    tier: 'balanced',
    localModel: {
      source: 'this-device',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen2.5-coder:14b',
      healthy: true,
      loaded: true,
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'verified',
        vision: 'no',
      },
    },
  },
  {
    id: 'lm://worker-node/node-1/ollama/ollama/qwen-worker',
    name: 'Qwen Worker on node-1',
    tier: 'balanced',
    localModel: {
      source: 'worker-node', endpointProvider: 'ollama', endpointId: 'ollama',
      modelId: 'qwen-worker', nodeId: 'node-1', healthy: true, loaded: true,
      capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'no' },
    },
  },
  {
    id: 'lm://this-device/ollama/ollama/qwen-unverified',
    name: 'Qwen Unverified on This device',
    tier: 'balanced',
    localModel: {
      source: 'this-device', endpointProvider: 'ollama', endpointId: 'ollama',
      modelId: 'qwen-unverified', healthy: true, loaded: true,
      capabilities: { streaming: true, multiTurn: true, toolUse: 'none', vision: 'no' },
    },
  },
  {
    id: 'lm://this-device/ollama/ollama/qwen-unhealthy',
    name: 'Qwen Unhealthy on This device',
    tier: 'balanced',
    localModel: {
      source: 'this-device', endpointProvider: 'ollama', endpointId: 'ollama',
      modelId: 'qwen-unhealthy', healthy: false, loaded: false,
      capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'no' },
    },
  },
  {
    id: 'lm://this-device/ollama/ollama/qwen3%3Acloud',
    name: 'Qwen 3 Cloud on This device',
    tier: 'balanced',
    localModel: {
      source: 'this-device',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen3:cloud',
      healthy: true,
      loaded: false,
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'none',
        vision: 'unknown',
      },
    },
  },
  {
    id: 'lm://this-device/ollama/ollama/kimi%3Acloud-preview',
    name: 'Kimi Cloud Preview on This device',
    tier: 'balanced',
    localModel: {
      source: 'this-device',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'kimi:cloud-preview',
      healthy: true,
      loaded: false,
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'none',
        vision: 'unknown',
      },
    },
  },
];

class FakeSettingsStore {
  private values: Record<string, unknown> = {
    crossModelReviewProviders: ['antigravity'],
    crossModelReviewMaxReviewers: 2,
    crossModelReviewModelByProvider: {},
    crossModelReviewLocalEnabled: true,
    crossModelReviewLocalSelectorId: '',
    crossModelReviewLocalTimeout: 120,
    crossModelReviewLocalMaxToolRounds: 12,
  };

  readonly reviewSettings = vi.fn(() => [reviewProviderSetting, ...localReviewSettings]);
  readonly get = vi.fn((key: string) => this.values[key]);
  readonly set = vi.fn(async (key: string, value: unknown) => {
    this.values[key] = value;
  });

  setValue(key: string, value: unknown): void {
    this.values[key] = value;
  }
}

class FakeUnifiedCatalogStore {
  private readonly models = signal<ModelDisplayInfo[]>(structuredClone(localModels));
  readonly ensureLoaded = vi.fn();
  readonly refresh = vi.fn(async () => {
    this.models.update((models) => models.map((model) =>
      model.id.includes('qwen-unverified') && model.localModel
        ? {
            ...model,
            localModel: {
              ...model.localModel,
              capabilities: { ...model.localModel.capabilities, toolUse: 'verified' },
            },
          }
        : model));
  });
  readonly displayModelsForProvider = vi.fn((provider: string) =>
    provider === 'local-model' ? this.models() : []);
}

class FakeProviderIpc {
  readonly qualifyLocalReviewer = vi.fn().mockResolvedValue({
    success: true,
    data: { status: 'verified' },
  });
}

class FakeReviewHealth {
  private notices = new Map<string, ReviewerNotice>();
  getReviewerNotice = (cliType: string): ReviewerNotice | undefined => this.notices.get(cliType);
  setNotice(notice: ReviewerNotice): void {
    this.notices.set(notice.cliType, notice);
  }
}

describe('ReviewSettingsTabComponent', () => {
  let fixture: ComponentFixture<ReviewSettingsTabComponent>;
  let store: FakeSettingsStore;
  let reviewHealth: FakeReviewHealth;

  beforeEach(async () => {
    store = new FakeSettingsStore();
    reviewHealth = new FakeReviewHealth();
    await TestBed.configureTestingModule({
      imports: [ReviewSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: UnifiedCatalogStore, useClass: FakeUnifiedCatalogStore },
        { provide: ProviderIpcService, useClass: FakeProviderIpc },
        { provide: CrossModelReviewIpcService, useValue: reviewHealth },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ReviewSettingsTabComponent);
  });

  it('shows the configured reviewer model instead of falsely reporting Auto', () => {
    store.setValue('crossModelReviewProviders', ['codex']);
    store.setValue('crossModelReviewModelByProvider', { codex: 'gpt-5.6-terra' });

    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector(
      'select[aria-label="OpenAI Codex CLI model"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe('gpt-5.6-terra');
  });

  it('renders Antigravity as a reviewer instead of the retired Gemini CLI', () => {
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('Antigravity');
    expect(text).not.toContain('Gemini CLI');
  });

  it('deduplicates legacy Gemini and canonical Antigravity from persisted reviewer settings', () => {
    store.setValue('crossModelReviewProviders', ['gemini', 'antigravity', 'codex']);

    fixture.detectChanges();

    const names = Array.from(
      fixture.nativeElement.querySelectorAll('.reviewer-list__name'),
      (element: Element) => element.textContent?.trim(),
    );
    expect(names).toEqual(['Antigravity', 'OpenAI Codex CLI']);
  });

  it('offers all six canonical remote reviewer providers', () => {
    store.setValue('crossModelReviewProviders', []);

    fixture.detectChanges();

    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('Claude Code');
    expect(text).toContain('OpenAI Codex CLI');
    expect(text).toContain('Antigravity');
    expect(text).toContain('GitHub Copilot');
    expect(text).toContain('Cursor CLI');
    expect(text).toContain('Grok Build');
  });

  it('sources the local reviewer selector from local-model catalog rows', () => {
    fixture.detectChanges();

    const catalog = TestBed.inject(UnifiedCatalogStore) as unknown as FakeUnifiedCatalogStore;
    const select = fixture.nativeElement.querySelector(
      'select[aria-label="Local reviewer model"]',
    ) as HTMLSelectElement;
    const optionText = Array.from(select.options, (option) => option.textContent?.trim());

    expect(catalog.displayModelsForProvider).toHaveBeenCalledWith('local-model');
    expect(optionText).toContain('Qwen 2.5 Coder 14B on This device');
  });

  it('only enables healthy verified models on this device while retaining ineligible choices visibly', () => {
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector(
      'select[aria-label="Local reviewer model"]',
    ) as HTMLSelectElement;
    const options = new Map(Array.from(select.options, (option) => [option.value, option]));

    expect(options.get(localSelectorId)?.disabled).toBe(false);
    expect(options.get('lm://worker-node/node-1/ollama/ollama/qwen-worker')?.disabled).toBe(true);
    expect(options.get('lm://this-device/ollama/ollama/qwen-unverified')?.disabled).toBe(true);
    expect(options.get('lm://this-device/ollama/ollama/qwen-unhealthy')?.disabled).toBe(true);
    expect(options.get('lm://worker-node/node-1/ollama/ollama/qwen-worker')?.textContent).toContain('This-device models only');
  });

  it('verifies an unqualified healthy model and then allows first-time selection', async () => {
    const unverified = 'lm://this-device/ollama/ollama/qwen-unverified';
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      `button[data-qualify-selector="${unverified}"]`,
    ) as HTMLButtonElement;

    expect(button).not.toBeNull();
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const provider = TestBed.inject(ProviderIpcService) as unknown as FakeProviderIpc;
    expect(provider.qualifyLocalReviewer).toHaveBeenCalledWith(unverified);
    const select = fixture.nativeElement.querySelector(
      'select[aria-label="Local reviewer model"]',
    ) as HTMLSelectElement;
    expect(Array.from(select.options).find((option) => option.value === unverified)?.disabled)
      .toBe(false);
    select.value = unverified;
    select.dispatchEvent(new Event('change'));
    expect(store.set).toHaveBeenCalledWith('crossModelReviewLocalSelectorId', unverified);
  });

  it('shows qualification failure and retries without enabling the model optimistically', async () => {
    const unverified = 'lm://this-device/ollama/ollama/qwen-unverified';
    const provider = TestBed.inject(ProviderIpcService) as unknown as FakeProviderIpc;
    provider.qualifyLocalReviewer
      .mockResolvedValueOnce({ success: true, data: { status: 'unverified', reason: 'probe failed' } })
      .mockResolvedValueOnce({ success: false, error: { message: 'endpoint unavailable' } });
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector(
      `button[data-qualify-selector="${unverified}"]`,
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('probe failed');
    expect(button.disabled).toBe(false);

    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(provider.qualifyLocalReviewer).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.textContent).toContain('endpoint unavailable');
    const select = fixture.nativeElement.querySelector(
      'select[aria-label="Local reviewer model"]',
    ) as HTMLSelectElement;
    expect(Array.from(select.options).find((option) => option.value === unverified)?.disabled)
      .toBe(true);
  });

  it('does not update destroyed settings UI after a qualification settles', async () => {
    const unverified = 'lm://this-device/ollama/ollama/qwen-unverified';
    let resolve!: (value: { success: true; data: { status: 'verified' } }) => void;
    const pending = new Promise<{ success: true; data: { status: 'verified' } }>((next) => {
      resolve = next;
    });
    const provider = TestBed.inject(ProviderIpcService) as unknown as FakeProviderIpc;
    provider.qualifyLocalReviewer.mockReturnValueOnce(pending);
    const catalog = TestBed.inject(UnifiedCatalogStore) as unknown as FakeUnifiedCatalogStore;
    fixture.detectChanges();
    const component = fixture.componentInstance;

    const request = component.qualifyLocalReviewer(
      component.localReviewerModels().find((model) => model.id === unverified)!,
    );
    fixture.destroy();
    resolve({ success: true, data: { status: 'verified' } });
    await request;

    expect(catalog.refresh).not.toHaveBeenCalled();
    expect(component.qualificationState(unverified)).toEqual({ status: 'verifying' });
  });

  it('keeps a saved ineligible non-cloud target visible but rejects new ineligible selections', () => {
    const unverified = 'lm://this-device/ollama/ollama/qwen-unverified';
    store.setValue('crossModelReviewLocalSelectorId', unverified);
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector(
      'select[aria-label="Local reviewer model"]',
    ) as HTMLSelectElement;

    expect(select.value).toBe(unverified);
    expect(select.selectedOptions[0]?.disabled).toBe(true);
    fixture.componentInstance.onLocalModelChange(
      { target: { value: unverified } } as unknown as Event,
    );
    expect(store.set).not.toHaveBeenCalledWith('crossModelReviewLocalSelectorId', unverified);
  });

  it('filters cloud-only local model IDs out of the local reviewer selector', () => {
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector(
      'select[aria-label="Local reviewer model"]',
    ) as HTMLSelectElement;
    const optionValues = Array.from(select.options, (option) => option.value);

    expect(optionValues).not.toContain('lm://this-device/ollama/ollama/qwen3%3Acloud');
    expect(optionValues).not.toContain('lm://this-device/ollama/ollama/kimi%3Acloud-preview');
  });

  it('persists only exact integer local-review limits', () => {
    const component = fixture.componentInstance;

    component.onLocalNumberChange(
      'crossModelReviewLocalTimeout',
      { target: { value: '120.5' } } as unknown as Event,
    );
    component.onLocalNumberChange(
      'crossModelReviewLocalMaxToolRounds',
      { target: { value: '12' } } as unknown as Event,
    );

    expect(store.set).not.toHaveBeenCalledWith('crossModelReviewLocalTimeout', expect.anything());
    expect(store.set).toHaveBeenCalledWith('crossModelReviewLocalMaxToolRounds', 12);
  });

  it('persists the selected local catalog row selector ID', () => {
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector(
      'select[aria-label="Local reviewer model"]',
    ) as HTMLSelectElement;
    select.value = localSelectorId;
    select.dispatchEvent(new Event('change'));

    expect(store.set).toHaveBeenCalledWith('crossModelReviewLocalSelectorId', localSelectorId);
  });

  it('shows an Unavailable badge on a reviewer that dropped out of the pool', () => {
    store.setValue('crossModelReviewProviders', ['antigravity', 'codex']);
    reviewHealth.setNotice({
      cliType: 'antigravity',
      kind: 'unavailable',
      at: Date.now(),
      reason: 'not detected on PATH',
    });

    fixture.detectChanges();

    const health = fixture.nativeElement.querySelector('.reviewer-list__health') as HTMLElement;
    expect(health).not.toBeNull();
    expect(health.textContent?.trim()).toBe('Unavailable');
    expect(health.classList.contains('is-ratelimited')).toBe(false);
  });

  it('shows a Rate-limited badge when a reviewer hit its usage cap', () => {
    store.setValue('crossModelReviewProviders', ['copilot', 'codex']);
    reviewHealth.setNotice({ cliType: 'copilot', kind: 'rate-limited', at: Date.now() });

    fixture.detectChanges();

    const health = fixture.nativeElement.querySelector('.reviewer-list__health') as HTMLElement;
    expect(health).not.toBeNull();
    expect(health.textContent?.trim()).toBe('Rate-limited');
    expect(health.classList.contains('is-ratelimited')).toBe(true);
  });

  it('shows no health badge when all reviewers are healthy', () => {
    store.setValue('crossModelReviewProviders', ['antigravity', 'codex']);

    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.reviewer-list__health')).toBeNull();
  });
});
