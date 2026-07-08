import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ReviewSettingsTabComponent } from './review-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { UnifiedCatalogStore } from '../models/unified-catalog.store';
import type { SettingMetadata } from '../../../../shared/types/settings-metadata.types';

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

class FakeSettingsStore {
  private values: Record<string, unknown> = {
    crossModelReviewProviders: ['antigravity'],
    crossModelReviewMaxReviewers: 2,
    crossModelReviewModelByProvider: {},
  };

  readonly reviewSettings = vi.fn(() => [reviewProviderSetting]);
  readonly get = vi.fn((key: string) => this.values[key]);
  readonly set = vi.fn(async (key: string, value: unknown) => {
    this.values[key] = value;
  });

  setValue(key: string, value: unknown): void {
    this.values[key] = value;
  }
}

class FakeUnifiedCatalogStore {
  readonly ensureLoaded = vi.fn();
  readonly displayModelsForProvider = vi.fn(() => []);
}

describe('ReviewSettingsTabComponent', () => {
  let fixture: ComponentFixture<ReviewSettingsTabComponent>;
  let store: FakeSettingsStore;

  beforeEach(async () => {
    store = new FakeSettingsStore();
    await TestBed.configureTestingModule({
      imports: [ReviewSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: UnifiedCatalogStore, useClass: FakeUnifiedCatalogStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ReviewSettingsTabComponent);
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
});
