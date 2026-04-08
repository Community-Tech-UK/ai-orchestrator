import { MEMORY_CHANNELS } from '../memory.channels';

describe('MEMORY_CHANNELS', () => {
  it('has memory stats channels', () => {
    expect(MEMORY_CHANNELS.MEMORY_GET_STATS).toBe('memory:get-stats');
    expect(MEMORY_CHANNELS.MEMORY_CRITICAL).toBe('memory:critical');
  });

  it('has memory-r1 channels', () => {
    expect(MEMORY_CHANNELS.MEMORY_R1_ADD_ENTRY).toBe('memory-r1:add-entry');
    expect(MEMORY_CHANNELS.MEMORY_R1_RETRIEVE).toBe('memory-r1:retrieve');
  });

  it('has unified memory channels', () => {
    expect(MEMORY_CHANNELS.UNIFIED_MEMORY_PROCESS_INPUT).toBe('unified-memory:process-input');
    expect(MEMORY_CHANNELS.UNIFIED_MEMORY_GET_STATS).toBe('unified-memory:get-stats');
  });

  it('has RLM channels', () => {
    expect(MEMORY_CHANNELS.RLM_CREATE_STORE).toBe('rlm:create-store');
    expect(MEMORY_CHANNELS.RLM_EXECUTE_QUERY).toBe('rlm:execute-query');
    expect(MEMORY_CHANNELS.RLM_STORE_UPDATED).toBe('rlm:store-updated');
  });

  it('has observation channels', () => {
    expect(MEMORY_CHANNELS.OBSERVATION_GET_STATS).toBe('observation:get-stats');
    expect(MEMORY_CHANNELS.OBSERVATION_FORCE_REFLECT).toBe('observation:force-reflect');
  });
});
