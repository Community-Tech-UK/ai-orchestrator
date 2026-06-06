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

  it('auxiliaryLlmSlotsJson contains all seven slots', () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
    for (const slot of ALL_SLOTS) {
      expect(slots).toHaveProperty(slot);
    }
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
});
