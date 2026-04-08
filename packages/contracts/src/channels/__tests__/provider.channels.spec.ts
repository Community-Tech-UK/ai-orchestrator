import { PROVIDER_CHANNELS } from '../provider.channels';

describe('PROVIDER_CHANNELS', () => {
  it('has provider channels', () => {
    expect(PROVIDER_CHANNELS.PROVIDER_LIST).toBe('provider:list');
    expect(PROVIDER_CHANNELS.PROVIDER_LIST_MODELS).toBe('provider:list-models');
  });

  it('has CLI detection channels', () => {
    expect(PROVIDER_CHANNELS.CLI_DETECT_ALL).toBe('cli:detect-all');
    expect(PROVIDER_CHANNELS.CLI_TEST_CONNECTION).toBe('cli:test-connection');
    expect(PROVIDER_CHANNELS.COPILOT_LIST_MODELS).toBe('copilot:list-models');
  });

  it('has plugin channels', () => {
    expect(PROVIDER_CHANNELS.PLUGINS_DISCOVER).toBe('plugins:discover');
    expect(PROVIDER_CHANNELS.PLUGINS_LOADED).toBe('plugins:loaded');
  });

  it('has model discovery channels', () => {
    expect(PROVIDER_CHANNELS.MODEL_DISCOVER).toBe('model:discover');
    expect(PROVIDER_CHANNELS.MODEL_SET_OVERRIDE).toBe('model:set-override');
  });

  it('has model routing channels', () => {
    expect(PROVIDER_CHANNELS.ROUTING_GET_CONFIG).toBe('routing:get-config');
    expect(PROVIDER_CHANNELS.HOT_SWITCH_PERFORM).toBe('hot-switch:perform');
  });
});
