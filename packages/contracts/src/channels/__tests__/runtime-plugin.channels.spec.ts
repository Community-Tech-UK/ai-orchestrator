import { describe, expect, it } from 'vitest';
import { RUNTIME_PLUGIN_CHANNELS } from '../runtime-plugin.channels';

describe('RUNTIME_PLUGIN_CHANNELS', () => {
  it('defines runtime plugin package-manager channels separately from provider plugin channels', () => {
    expect(RUNTIME_PLUGIN_CHANNELS.RUNTIME_PLUGINS_LIST).toBe('runtime-plugins:list');
    expect(RUNTIME_PLUGIN_CHANNELS.RUNTIME_PLUGINS_VALIDATE).toBe('runtime-plugins:validate');
    expect(RUNTIME_PLUGIN_CHANNELS.RUNTIME_PLUGINS_INSTALL).toBe('runtime-plugins:install');
    expect(RUNTIME_PLUGIN_CHANNELS.RUNTIME_PLUGINS_UPDATE).toBe('runtime-plugins:update');
    expect(RUNTIME_PLUGIN_CHANNELS.RUNTIME_PLUGINS_PRUNE).toBe('runtime-plugins:prune');
    expect(RUNTIME_PLUGIN_CHANNELS.RUNTIME_PLUGINS_UNINSTALL).toBe('runtime-plugins:uninstall');
  });
});
