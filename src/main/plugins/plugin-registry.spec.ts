import { describe, expect, it } from 'vitest';
import { PluginRegistry } from './plugin-registry';
import type { PluginLoadReport } from '../../shared/types/plugin.types';

function buildReport(slot: PluginLoadReport['slot']): PluginLoadReport {
  return {
    slot,
    detected: true,
    ready: true,
    phases: [],
  };
}

describe('PluginRegistry', () => {
  it('groups plugins by slot for a working directory', () => {
    const registry = new PluginRegistry();
    const notifierRuntime = { notify: async () => undefined };

    registry.replacePlugins('/tmp/project', [
      {
        workingDirectory: '/tmp/project',
        filePath: '/tmp/project/.orchestrator/plugins/hook.js',
        slot: 'hook',
        hooks: {},
        loadReport: buildReport('hook'),
      },
      {
        workingDirectory: '/tmp/project',
        filePath: '/tmp/project/.orchestrator/plugins/notifier.js',
        slot: 'notifier',
        hooks: {},
        runtime: notifierRuntime,
        loadReport: buildReport('notifier'),
      },
    ]);

    expect(registry.getSlots('/tmp/project')).toEqual(['hook', 'notifier']);
    expect(registry.getPlugins('/tmp/project', 'hook')).toHaveLength(1);
    expect(registry.getPlugins('/tmp/project', 'notifier')).toHaveLength(1);
    expect(registry.getRuntimes('/tmp/project', 'notifier')).toEqual([notifierRuntime]);
  });

  it('clears a single working directory without affecting others', () => {
    const registry = new PluginRegistry();

    registry.replacePlugins('/tmp/a', [{
      workingDirectory: '/tmp/a',
      filePath: '/tmp/a/a.js',
      slot: 'hook',
      hooks: {},
      loadReport: buildReport('hook'),
    }]);
    registry.replacePlugins('/tmp/b', [{
      workingDirectory: '/tmp/b',
      filePath: '/tmp/b/b.js',
      slot: 'hook',
      hooks: {},
      loadReport: buildReport('hook'),
    }]);

    registry.clear('/tmp/a');

    expect(registry.getPlugins('/tmp/a')).toEqual([]);
    expect(registry.getPlugins('/tmp/b')).toHaveLength(1);
  });
});
