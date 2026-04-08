/**
 * IPC channels for provider management, CLI detection, provider plugins,
 * and model discovery/routing.
 */
export const PROVIDER_CHANNELS = {
  // Provider operations
  PROVIDER_LIST: 'provider:list',
  PROVIDER_STATUS: 'provider:status',
  PROVIDER_STATUS_ALL: 'provider:status-all',
  PROVIDER_UPDATE_CONFIG: 'provider:update-config',
  PROVIDER_LIST_MODELS: 'provider:list-models',

  // CLI detection
  CLI_DETECT_ALL: 'cli:detect-all',
  CLI_DETECT_ONE: 'cli:detect-one',
  CLI_CHECK: 'cli:check',
  CLI_TEST_CONNECTION: 'cli:test-connection',

  // Copilot operations
  COPILOT_LIST_MODELS: 'copilot:list-models',

  // Provider Plugins
  PLUGINS_DISCOVER: 'plugins:discover',
  PLUGINS_LOAD: 'plugins:load',
  PLUGINS_UNLOAD: 'plugins:unload',
  PLUGINS_GET: 'plugins:get',
  PLUGINS_GET_ALL: 'plugins:get-all',
  PLUGINS_GET_LOADED: 'plugins:get-loaded',
  PLUGINS_GET_META: 'plugins:get-meta',
  PLUGINS_INSTALL: 'plugins:install',
  PLUGINS_UNINSTALL: 'plugins:uninstall',
  PLUGINS_CREATE_TEMPLATE: 'plugins:create-template',

  // Plugin lifecycle events (renderer-bound)
  PLUGINS_LOADED: 'plugins:loaded',
  PLUGINS_UNLOADED: 'plugins:unloaded',
  PLUGINS_ERROR: 'plugins:error',

  // Model Discovery operations
  MODEL_DISCOVER: 'model:discover',
  MODEL_GET_ALL: 'model:get-all',
  MODEL_GET: 'model:get',
  MODEL_SELECT: 'model:select',
  MODEL_CONFIGURE_PROVIDER: 'model:configure-provider',
  MODEL_GET_PROVIDER_STATUS: 'model:get-provider-status',
  MODEL_GET_STATS: 'model:get-stats',
  MODEL_VERIFY: 'model:verify',
  MODEL_SET_OVERRIDE: 'model:set-override',
  MODEL_REMOVE_OVERRIDE: 'model:remove-override',

  // Model routing operations
  ROUTING_GET_CONFIG: 'routing:get-config',
  ROUTING_UPDATE_CONFIG: 'routing:update-config',
  ROUTING_PREVIEW: 'routing:preview',
  ROUTING_GET_TIER: 'routing:get-tier',
  HOT_SWITCH_GET_CONFIG: 'hot-switch:get-config',
  HOT_SWITCH_UPDATE_CONFIG: 'hot-switch:update-config',
  HOT_SWITCH_PERFORM: 'hot-switch:perform',
  HOT_SWITCH_GET_STATS: 'hot-switch:get-stats',

  // Hot-switch event forwarding (main -> renderer)
  HOT_SWITCH_EVENT_STARTED: 'hot-switch:event:started',
  HOT_SWITCH_EVENT_COMPLETED: 'hot-switch:event:completed',
  HOT_SWITCH_EVENT_FAILED: 'hot-switch:event:failed',
} as const;
