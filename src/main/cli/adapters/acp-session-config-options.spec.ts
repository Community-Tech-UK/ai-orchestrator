import { describe, expect, it, vi } from 'vitest';
import {
  applyAcpSessionConfig,
  mapAcpEffort,
  parseAcpConfigOptions,
  planConfigOptionWrites,
} from './acp-session-config-options';

/** Shapes observed from OpenCode 1.18 (`session/new` and `set_config_option`). */
const FREE_MODEL_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'opencode/mimo-v2.6-flash-free',
    options: [
      { value: 'opencode/mimo-v2.6-flash-free', name: 'OpenCode Zen/MiMo-V2.6-Flash Free' },
      { value: 'xiaomi-token-plan-ams/mimo-v2.6-pro', name: 'Xiaomi Token Plan (Europe)/MiMo-V2.6-Pro' },
    ],
  },
  { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build' }, { value: 'plan' }] },
];

const PRO_MODEL_OPTIONS = [
  { ...FREE_MODEL_OPTIONS[0], currentValue: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'low',
    options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
  },
  FREE_MODEL_OPTIONS[1],
];

describe('parseAcpConfigOptions', () => {
  it('keeps id, category, current value and the offered values', () => {
    expect(parseAcpConfigOptions(PRO_MODEL_OPTIONS)[1]).toEqual({
      id: 'effort',
      category: 'thought_level',
      currentValue: 'low',
      values: ['low', 'medium', 'high'],
    });
  });

  it('drops malformed entries and flattens grouped options', () => {
    const parsed = parseAcpConfigOptions([
      null,
      'model',
      { name: 'no id' },
      { id: '  ' },
      { id: 'model', options: [{ group: 'zen', options: [{ value: 'a/b' }, { value: 7 }] }, { value: 'c/d' }] },
    ]);
    expect(parsed).toEqual([{ id: 'model', values: ['a/b', 'c/d'] }]);
    expect(parseAcpConfigOptions(undefined)).toEqual([]);
    expect(parseAcpConfigOptions({ id: 'model' })).toEqual([]);
  });
});

describe('planConfigOptionWrites', () => {
  it('orders model before effort', () => {
    const plan = planConfigOptionWrites(parseAcpConfigOptions(PRO_MODEL_OPTIONS), {
      effort: 'high',
      model: 'opencode/mimo-v2.6-flash-free',
    });
    expect(plan.map((entry) => entry.key)).toEqual(['model', 'effort']);
  });

  it('skips a value the agent does not offer, and an already-selected value', () => {
    const advertised = parseAcpConfigOptions(FREE_MODEL_OPTIONS);
    expect(planConfigOptionWrites(advertised, { model: 'nope/not-a-model' })[0]).toMatchObject({
      kind: 'skip',
      reason: 'the agent does not offer model "nope/not-a-model"',
    });
    expect(planConfigOptionWrites(advertised, { model: 'opencode/mimo-v2.6-flash-free' })[0]).toMatchObject({
      kind: 'skip',
      reason: 'already selected',
    });
    expect(planConfigOptionWrites(advertised, { effort: 'high' })[0]).toMatchObject({
      kind: 'skip',
      reason: 'the agent offers no effort option for this session',
    });
  });

  it('matches options by ACP category before id', () => {
    const advertised = parseAcpConfigOptions([
      { id: 'reasoning_effort', category: 'thought_level', options: [{ value: 'high' }] },
    ]);
    expect(planConfigOptionWrites(advertised, { effort: 'high' })[0]).toEqual({
      kind: 'write',
      key: 'effort',
      configId: 'reasoning_effort',
      value: 'high',
    });
  });

  it('sends unvalidated writes when the agent returned no option list', () => {
    expect(planConfigOptionWrites(null, { model: 'x/y' })[0]).toEqual({
      kind: 'write',
      key: 'model',
      configId: 'model',
      value: 'x/y',
    });
  });
});

describe('mapAcpEffort', () => {
  it('maps AIO effort onto the low/medium/high scale', () => {
    expect(mapAcpEffort('minimal')).toBe('low');
    expect(mapAcpEffort('low')).toBe('low');
    expect(mapAcpEffort('medium')).toBe('medium');
    expect(mapAcpEffort('high')).toBe('high');
    expect(mapAcpEffort('xhigh')).toBe('high');
    expect(mapAcpEffort('max')).toBe('high');
  });

  it('omits effort the agent should decide itself', () => {
    expect(mapAcpEffort('none')).toBeUndefined();
    expect(mapAcpEffort('workflow')).toBeUndefined();
    expect(mapAcpEffort('')).toBeUndefined();
    expect(mapAcpEffort(undefined)).toBeUndefined();
    expect(mapAcpEffort('bogus')).toBeUndefined();
  });
});

describe('applyAcpSessionConfig', () => {
  it('writes the model, re-reads the returned options, then writes effort', async () => {
    const send = vi.fn(async (configId: string) =>
      configId === 'model' ? { configOptions: PRO_MODEL_OPTIONS } : { configOptions: PRO_MODEL_OPTIONS });
    const outcome = await applyAcpSessionConfig(send, FREE_MODEL_OPTIONS, {
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      effort: 'high',
    });
    expect(send.mock.calls).toEqual([
      ['model', 'xiaomi-token-plan-ams/mimo-v2.6-pro'],
      ['effort', 'high'],
    ]);
    expect(outcome).toEqual({
      applied: [
        { key: 'model', value: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
        { key: 'effort', value: 'high' },
      ],
      warnings: [],
    });
  });

  it('skips effort with a warning when the new model offers none', async () => {
    const send = vi.fn(async () => ({ configOptions: FREE_MODEL_OPTIONS }));
    const outcome = await applyAcpSessionConfig(send, PRO_MODEL_OPTIONS, {
      model: 'opencode/mimo-v2.6-flash-free',
      effort: 'high',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome.warnings).toEqual([
      'Did not set effort "high": the agent offers no effort option for this session.',
    ]);
  });

  it('turns a rejected write into a warning and keeps going', async () => {
    const send = vi.fn(async (configId: string) => {
      if (configId === 'model') throw new Error('ACP session/set_config_option failed: Invalid params: model not found (-32602)');
      return {};
    });
    const outcome = await applyAcpSessionConfig(send, null, { model: 'x/y', effort: 'high' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(outcome.applied).toEqual([{ key: 'effort', value: 'high' }]);
    expect(outcome.warnings).toEqual([
      'Could not set model "x/y": ACP session/set_config_option failed: Invalid params: model not found (-32602)',
    ]);
  });

  it('does nothing when nothing is requested', async () => {
    const send = vi.fn();
    await expect(applyAcpSessionConfig(send, FREE_MODEL_OPTIONS, {})).resolves.toEqual({ applied: [], warnings: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
