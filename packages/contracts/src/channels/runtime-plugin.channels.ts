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
  // Task 9: trust gating for project-scoped plugin roots. Grant/revoke persist
  // the decision in user-scoped settings; plugin code is imported only after
  // an explicit grant is written.
  PROJECT_PLUGIN_TRUST_QUERY: 'project-plugin-trust:query',
  PROJECT_PLUGIN_TRUST_GRANT: 'project-plugin-trust:grant',
  PROJECT_PLUGIN_TRUST_REVOKE: 'project-plugin-trust:revoke',
} as const;
