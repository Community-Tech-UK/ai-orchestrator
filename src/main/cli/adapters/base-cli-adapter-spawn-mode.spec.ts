/**
 * B9 — Spawn-mode contract on BaseCliAdapter.
 *
 * Verifies the runtime spawn-mode signal: the default, the getter, idempotent
 * no-op on an unchanged mode, and the `spawn_mode` event payload — including the
 * degraded-fallback shape that models Codex's app-server -> exec downgrade.
 */

import { describe, it, expect, vi } from 'vitest';
import { ScriptedCliAdapter } from './scripted-cli-adapter';
import type { CliSpawnMode, SpawnModeChange } from './base-cli-adapter';

/** Exposes the protected setter so the contract can be exercised directly. */
class SpawnModeProbeAdapter extends ScriptedCliAdapter {
  public changeMode(mode: CliSpawnMode, opts?: { reason?: string; degraded?: boolean }): void {
    this.setSpawnMode(mode, opts);
  }
}

describe('BaseCliAdapter spawn-mode contract (B9)', () => {
  it('defaults to subprocess-stream', () => {
    const adapter = new SpawnModeProbeAdapter();
    expect(adapter.getSpawnMode()).toBe('subprocess-stream');
  });

  it('emits spawn_mode with previous + new mode on change', () => {
    const adapter = new SpawnModeProbeAdapter();
    const onChange = vi.fn<(c: SpawnModeChange) => void>();
    adapter.on('spawn_mode', onChange);

    adapter.changeMode('app-server');

    expect(adapter.getSpawnMode()).toBe('app-server');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ mode: 'app-server', previous: 'subprocess-stream' });
  });

  it('is a no-op (no event) when the mode is unchanged', () => {
    const adapter = new SpawnModeProbeAdapter();
    adapter.changeMode('http');
    const onChange = vi.fn();
    adapter.on('spawn_mode', onChange);

    adapter.changeMode('http');

    expect(onChange).not.toHaveBeenCalled();
    expect(adapter.getSpawnMode()).toBe('http');
  });

  it('carries reason + degraded flag on a fallback downgrade', () => {
    const adapter = new SpawnModeProbeAdapter();
    const changes: SpawnModeChange[] = [];
    adapter.on('spawn_mode', (c) => changes.push(c));

    // Models Codex: app-server established, then init failure forces exec.
    adapter.changeMode('app-server');
    adapter.changeMode('subprocess-exec', { reason: 'init timed out after 30s', degraded: true });

    expect(adapter.getSpawnMode()).toBe('subprocess-exec');
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({
      mode: 'subprocess-exec',
      previous: 'app-server',
      reason: 'init timed out after 30s',
      degraded: true,
    });
  });

  it('omits optional fields when not provided', () => {
    const adapter = new SpawnModeProbeAdapter();
    const changes: SpawnModeChange[] = [];
    adapter.on('spawn_mode', (c) => changes.push(c));

    adapter.changeMode('subprocess-exec');

    expect(changes[0]).toEqual({ mode: 'subprocess-exec', previous: 'subprocess-stream' });
    expect(changes[0]).not.toHaveProperty('reason');
    expect(changes[0]).not.toHaveProperty('degraded');
  });
});
