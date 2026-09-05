import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryStartLoopFromPanel, type LoopPanelStartDeps, type LoopStartRequestPayload } from './input-panel-loop-start';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';

describe('loop configuration capture across attachment preparation', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    let config: LoopStartConfigInput | null = { initialPrompt: 'Continue', provider: 'claude', workspaceCwd: '/tmp/example' };
    let release!: (buffer: ArrayBuffer) => void;
    const file = new File(['example'], 'example.txt');
    const read = new Promise<ArrayBuffer>(resolve => { release = resolve; });
    file.arrayBuffer = () => read;
    const requestLoopStart = vi.fn<(payload: LoopStartRequestPayload) => void>();
    const deps: LoopPanelStartDeps = {
      isLoopStarting: () => false, panelConfig: () => config, message: () => 'First prompt',
      pendingFiles: () => [file], setMessage: vi.fn(), setLoopStarting: vi.fn(),
      setLoopArmed: vi.fn(), setShowLoopPanel: vi.fn(), setLoopStartError: vi.fn(), requestLoopStart,
    };
    return { deps, release, requestLoopStart, setConfig: (value: LoopStartConfigInput | null) => { config = value; } };
  }

  it.each(['codex', 'gemini'] as const)('uses the current panel provider %s after an attachment read, including explicit overrides', async provider => {
    const test = setup();
    const pending = tryStartLoopFromPanel(test.deps, 30_000);
    expect(test.requestLoopStart).not.toHaveBeenCalled();
    test.setConfig({ initialPrompt: 'Latest loop instructions', provider, workspaceCwd: '/tmp/example' });
    test.release(new ArrayBuffer(1));
    expect(await pending).toBe(true);
    const payload = test.requestLoopStart.mock.calls[0][0];
    expect(payload.config).toMatchObject({ provider, initialPrompt: 'First prompt', iterationPrompt: 'Latest loop instructions' });
    expect(payload.attachments).toEqual([{ name: 'example.txt', data: new Uint8Array(1) }]);
    payload.onResolved(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains composition without submitting if the panel becomes invalid during an attachment read', async () => {
    const test = setup();
    const pending = tryStartLoopFromPanel(test.deps, 30_000);
    test.setConfig(null);
    test.release(new ArrayBuffer(1));
    expect(await pending).toBe(false);
    expect(test.requestLoopStart).not.toHaveBeenCalled();
    expect(test.deps.setMessage).not.toHaveBeenCalled();
    expect(test.deps.setLoopStartError).toHaveBeenCalledWith(expect.stringContaining('Check the settings and start again'));
    expect(vi.getTimerCount()).toBe(0);
  });
});
