import { describe, expect, it } from 'vitest';
import { computeAutomationModelPreview } from './automation-model-preview';
import type { AutomationModelDefaults } from '../../../../shared/automations/automation-model-resolution';

const NO_DEFAULTS: AutomationModelDefaults = {
  automationDefaultCli: 'auto',
  automationDefaultModel: '',
  modelPickerFavorites: [],
};

describe('computeAutomationModelPreview', () => {
  it('labels a pinned model as pinned with its catalog display name', () => {
    const preview = computeAutomationModelPreview(
      { provider: 'claude', model: 'opus[1m]' },
      NO_DEFAULTS,
    );
    expect(preview.source).toBe('pinned');
    expect(preview.label).toBe('Opus latest, 1M');
  });

  it('labels the automation default as "automation default"', () => {
    const preview = computeAutomationModelPreview(
      { provider: 'auto', model: '' },
      { ...NO_DEFAULTS, automationDefaultCli: 'claude', automationDefaultModel: 'opus[1m]' },
    );
    expect(preview.source).toBe('automation default');
    expect(preview.label).toBe('Opus latest, 1M');
  });

  it('labels a favourite fallback as "favourite"', () => {
    const preview = computeAutomationModelPreview(
      { provider: 'claude', model: '' },
      { ...NO_DEFAULTS, modelPickerFavorites: ['claude:opus[1m]'] },
    );
    expect(preview.source).toBe('favourite');
    expect(preview.label).toBe('Opus latest, 1M');
  });

  it('D1: adopts the top favourite for a fully-auto automation', () => {
    const preview = computeAutomationModelPreview(
      { provider: 'auto', model: '' },
      { ...NO_DEFAULTS, modelPickerFavorites: ['claude:opus[1m]'] },
    );
    expect(preview.source).toBe('favourite');
    expect(preview.label).toBe('Opus latest, 1M');
  });

  it('labels a provider default when nothing else resolves the model', () => {
    const preview = computeAutomationModelPreview(
      { provider: 'claude', model: '' },
      NO_DEFAULTS,
    );
    expect(preview.source).toBe('provider default');
    // The provider default is the provider's primary catalog model.
    expect(preview.label).toBe('Opus latest, 1M');
  });
});
