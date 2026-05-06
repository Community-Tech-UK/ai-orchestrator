/**
 * IPC channels for Orchestrator runtime plugin package management.
 *
 * These are intentionally separate from provider-plugin `PLUGINS_*` channels.
 */
export const RUNTIME_PLUGIN_CHANNELS = {
  RUNTIME_PLUGINS_LIST: 'runtime-plugins:list',
  RUNTIME_PLUGINS_VALIDATE: 'runtime-plugins:validate',
  RUNTIME_PLUGINS_INSTALL: 'runtime-plugins:install',
  RUNTIME_PLUGINS_UPDATE: 'runtime-plugins:update',
  RUNTIME_PLUGINS_PRUNE: 'runtime-plugins:prune',
  RUNTIME_PLUGINS_UNINSTALL: 'runtime-plugins:uninstall',
} as const;
