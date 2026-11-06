import { describe, expect, it } from 'vitest';
import { SCOUT_REASONING_EFFORT, SCOUT_TIER, isScoutSpawn, scoutModelRequest, scoutReasoningEffort } from './scout-defaults';
import { parseOrchestratorCommands } from './orchestration-protocol';

describe('scout defaults', () => {
  it('recognises only an explicit scout role', () => {
    expect(isScoutSpawn({ role: 'scout' })).toBe(true);
    expect(isScoutSpawn({})).toBe(false);
    expect(isScoutSpawn({ role: 'Scout' as never })).toBe(false);
    expect(isScoutSpawn({ role: 'worker' as never })).toBe(false);
  });

  it('asks for the balanced tier only when nobody chose a model', () => {
    expect(scoutModelRequest({ role: 'scout' })).toBe(SCOUT_TIER);
    expect(scoutModelRequest({ role: 'scout', model: '  ' })).toBe(SCOUT_TIER);
    expect(scoutModelRequest({ role: 'scout', model: 'opus' })).toBeUndefined();
    expect(scoutModelRequest({ role: 'scout' }, 'haiku')).toBeUndefined();
    expect(scoutModelRequest({})).toBeUndefined();
  });

  it('asks for high effort for a scout and nothing for other helpers', () => {
    expect(scoutReasoningEffort({ role: 'scout' })).toBe(SCOUT_REASONING_EFFORT);
    expect(SCOUT_REASONING_EFFORT).toBe('high');
    expect(scoutReasoningEffort({})).toBeUndefined();
  });

  it('keeps the role on a spawn_child command the lead writes', () => {
    const text = ':::ORCHESTRATOR_COMMAND:::\n{"action":"spawn_child","task":"List every route with no permission check","role":"scout","name":"route-scout"}\n:::END_COMMAND:::';
    expect(parseOrchestratorCommands(text)[0]).toMatchObject({ action: 'spawn_child', role: 'scout', name: 'route-scout' });
  });
});
