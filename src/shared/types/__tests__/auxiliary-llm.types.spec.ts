import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.types';
import type { AuxiliaryLlmSlot, AuxiliaryLlmSlotConfigMap } from '../auxiliary-llm.types';

const ALL_SLOTS: AuxiliaryLlmSlot[] = [
  'compression',
  'memoryDistillation',
  'webExtract',
  'titleGeneration',
  'routingClassification',
  'approvalScoring',
  'loopScoring',
  'retrievalHypothesis',
  'branchScoring',
  'subQueryExecution',
  'verifyOutputSummary',
];

describe('DEFAULT_SETTINGS — auxiliary LLM fields', () => {
  it('auxiliaryLlmEnabled defaults to true', () => {
    expect(DEFAULT_SETTINGS.auxiliaryLlmEnabled).toBe(true);
  });

  it('auxiliaryLlmRoutingMode defaults to local-first', () => {
    expect(DEFAULT_SETTINGS.auxiliaryLlmRoutingMode).toBe('local-first');
  });

  it('auxiliaryLlmSlotsJson parses as valid JSON', () => {
    expect(() => JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson)).not.toThrow();
  });

  it('auxiliaryLlmSlotsJson contains all eleven slots', () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
    for (const slot of ALL_SLOTS) {
      expect(slots).toHaveProperty(slot);
    }
  });

  it('retrievalHypothesis defaults to a quick local-only HyDE helper slot', () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;

    expect(slots.retrievalHypothesis).toMatchObject({
      enabled: true,
      provider: 'auto',
      tier: 'quick',
      maxOutputTokens: 300,
      timeoutMs: 2500,
      requireJson: false,
      allowFrontierFallback: false,
    });
  });

  it('branchScoring defaults to a quick JSON scoring slot with frontier fallback', () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;

    expect(slots.branchScoring).toMatchObject({
      enabled: true,
      provider: 'auto',
      tier: 'quick',
      requireJson: true,
      allowFrontierFallback: true,
    });
  });

  it('subQueryExecution defaults to an opt-in (disabled) quality slot with frontier fallback', () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;

    expect(slots.subQueryExecution).toMatchObject({
      enabled: false,
      provider: 'auto',
      tier: 'quality',
      requireJson: false,
      allowFrontierFallback: true,
    });
  });

  it('every slot has positive timeoutMs', () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
    for (const slot of ALL_SLOTS) {
      expect(slots[slot].timeoutMs).toBeGreaterThan(0);
    }
  });

  it('every slot has positive maxInputTokens', () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
    for (const slot of ALL_SLOTS) {
      expect(slots[slot].maxInputTokens).toBeGreaterThan(0);
    }
  });

  it('every slot has positive maxOutputTokens', () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
    for (const slot of ALL_SLOTS) {
      expect(slots[slot].maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('auxiliaryLlmEndpointsJson is a valid empty JSON array', () => {
    const parsed = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmEndpointsJson);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  it('auxiliaryLlmAllowRemoteWorkerModels defaults to true', () => {
    expect(DEFAULT_SETTINGS.auxiliaryLlmAllowRemoteWorkerModels).toBe(true);
  });

  it('auxiliaryLlmRoutingClassificationEnabled defaults to true', () => {
    expect(DEFAULT_SETTINGS.auxiliaryLlmRoutingClassificationEnabled).toBe(true);
  });
});
