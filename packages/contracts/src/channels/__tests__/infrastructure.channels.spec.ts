import { INFRASTRUCTURE_CHANNELS } from '../infrastructure.channels';

describe('INFRASTRUCTURE_CHANNELS', () => {
  it('has settings channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.SETTINGS_GET_ALL).toBe('settings:get-all');
    expect(INFRASTRUCTURE_CHANNELS.SETTINGS_CHANGED).toBe('settings:changed');
  });

  it('has config channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.CONFIG_RESOLVE).toBe('config:resolve');
    expect(INFRASTRUCTURE_CHANNELS.INSTRUCTIONS_RESOLVE).toBe('instructions:resolve');
  });

  it('has app channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.APP_READY).toBe('app:ready');
    expect(INFRASTRUCTURE_CHANNELS.APP_GET_VERSION).toBe('app:get-version');
    expect(INFRASTRUCTURE_CHANNELS.APP_GET_STARTUP_CAPABILITIES).toBe('app:get-startup-capabilities');
    expect(INFRASTRUCTURE_CHANNELS.APP_STARTUP_CAPABILITIES).toBe('app:startup-capabilities');
  });

  it('has security channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.SECURITY_DETECT_SECRETS).toBe('security:detect-secrets');
    expect(INFRASTRUCTURE_CHANNELS.SECURITY_GET_PERMISSION_CONFIG).toBe('security:get-permission-config');
  });

  it('has cost tracking channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.COST_GET_SUMMARY).toBe('cost:get-summary');
    expect(INFRASTRUCTURE_CHANNELS.COST_BUDGET_ALERT).toBe('cost:budget-alert');
  });

  it('has provider quota channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.QUOTA_GET_ALL).toBe('quota:get-all');
    expect(INFRASTRUCTURE_CHANNELS.QUOTA_REFRESH).toBe('quota:refresh');
    expect(INFRASTRUCTURE_CHANNELS.QUOTA_UPDATED).toBe('quota:updated');
    expect(INFRASTRUCTURE_CHANNELS.QUOTA_WARNING).toBe('quota:warning');
    expect(INFRASTRUCTURE_CHANNELS.QUOTA_EXHAUSTED).toBe('quota:exhausted');
  });

  it('has stats channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.STATS_GET).toBe('stats:get');
    expect(INFRASTRUCTURE_CHANNELS.STATS_CLEAR).toBe('stats:clear');
  });

  it('has debug channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.DEBUG_EXECUTE).toBe('debug:execute');
    expect(INFRASTRUCTURE_CHANNELS.DEBUG_ALL).toBe('debug:all');
  });

  it('has log channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.LOG_MESSAGE).toBe('log:message');
    expect(INFRASTRUCTURE_CHANNELS.LOG_EXPORT).toBe('log:export');
  });

  it('has search channels', () => {
    expect(INFRASTRUCTURE_CHANNELS.SEARCH_SEMANTIC).toBe('search:semantic');
    expect(INFRASTRUCTURE_CHANNELS.SEARCH_IS_EXA_CONFIGURED).toBe('search:is-exa-configured');
  });
});
