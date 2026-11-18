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
      sessionId: () => 'session-a', notify: vi.fn(),
      isLoopStarting: () => false, panelConfig: () => config, message: () => 'First prompt',
      pendingFiles: () => [file], convertHeic: vi.fn(), setMessage: vi.fn(), setLoopStarting: vi.fn(),
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
    expect(vi.mocked(test.deps.setLoopStarting).mock.calls).toEqual([[true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('HEIC photos attached to a loop start', () => {
  const config: LoopStartConfigInput = { initialPrompt: 'Continue', provider: 'claude', workspaceCwd: '/tmp/example' };

  function deps(photo: File, convertHeic: LoopPanelStartDeps['convertHeic']) {
    const requestLoopStart = vi.fn<(payload: LoopStartRequestPayload) => void>();
    const value: LoopPanelStartDeps = {
      sessionId: () => 'session-a', notify: vi.fn(),
      isLoopStarting: () => false, panelConfig: () => config, message: () => 'Look at this photo',
      pendingFiles: () => [photo], convertHeic, setMessage: vi.fn(), setLoopStarting: vi.fn(),
      setLoopArmed: vi.fn(), setShowLoopPanel: vi.fn(), setLoopStartError: vi.fn(), requestLoopStart,
    };
    return { value, requestLoopStart };
  }

  it('names the staged files it read at Send, not files added while converting', async () => {
    const photo = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });
    const late = new File(['png'], 'late.png', { type: 'image/png' });
    const jpeg = new File([new Uint8Array([0xff])], 'IMG_1531.jpg', { type: 'image/jpeg' });
    jpeg.arrayBuffer = async () => new Uint8Array([0xff]).buffer;
    let staged = [photo];
    const test = deps(photo, async () => {
      staged = [photo, late];
      return jpeg;
    });
    test.value.pendingFiles = () => staged;

    expect(await tryStartLoopFromPanel(test.value, 30_000)).toBe(true);

    const payload = test.requestLoopStart.mock.calls[0][0];
    expect(payload.stagedFiles).toHaveLength(1);
    expect(payload.stagedFiles[0]).toBe(photo);
    expect(payload.attachments.map((attachment) => attachment.name)).toEqual(['IMG_1531.jpg']);
    payload.onResolved(true);
  });

  it('sends the converted JPEG, which the agent can open, instead of the HEIC', async () => {
    const photo = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });
    const jpeg = new File([new Uint8Array([0xff, 0xd8])], 'IMG_1531.jpg', { type: 'image/jpeg' });
    jpeg.arrayBuffer = async () => new Uint8Array([0xff, 0xd8]).buffer;
    const convertHeic = vi.fn(async () => jpeg);
    const test = deps(photo, convertHeic);

    expect(await tryStartLoopFromPanel(test.value, 30_000)).toBe(true);

    expect(convertHeic).toHaveBeenCalledWith(photo);
    const payload = test.requestLoopStart.mock.calls[0][0];
    expect(payload.attachments).toEqual([{ name: 'IMG_1531.jpg', data: new Uint8Array([0xff, 0xd8]) }]);
    payload.onResolved(true);
  });

  it('keeps the composition and explains when the photo cannot be converted', async () => {
    const photo = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });
    const test = deps(photo, vi.fn(async () => { throw new Error('SYNTHETIC_DIAGNOSTIC'); }));

    expect(await tryStartLoopFromPanel(test.value, 30_000)).toBe(false);

    expect(test.requestLoopStart).not.toHaveBeenCalled();
    expect(test.value.setMessage).not.toHaveBeenCalled();
    expect(vi.mocked(test.value.setLoopStarting).mock.calls).toEqual([[true], [false]]);
    expect(test.value.setLoopStartError).toHaveBeenCalledWith(
      'IMG_1531.HEIC could not be converted. Save it as JPEG or PNG and attach that instead.',
    );
  });

  it('starts one loop when Send is pressed again while the photo converts', async () => {
    const photo = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });
    const jpeg = new File([new Uint8Array([0xff])], 'IMG_1531.jpg', { type: 'image/jpeg' });
    jpeg.arrayBuffer = async () => new Uint8Array([0xff]).buffer;
    let finish!: (file: File) => void;
    const conversion = new Promise<File>((resolve) => { finish = resolve; });
    const test = deps(photo, () => conversion);
    let starting = false;
    test.value.isLoopStarting = () => starting;
    test.value.setLoopStarting = vi.fn((value: boolean) => { starting = value; });

    const first = tryStartLoopFromPanel(test.value, 30_000);
    const second = tryStartLoopFromPanel(test.value, 30_000);
    finish(jpeg);

    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(test.requestLoopStart).toHaveBeenCalledOnce();
    test.requestLoopStart.mock.calls[0][0].onResolved(true);
  });
});

describe('switching session while a loop start is under way', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    let shown = 'session-a';
    let finish!: (file: File) => void;
    const photo = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });
    const jpeg = new File([new Uint8Array([0xff])], 'IMG_1531.jpg', { type: 'image/jpeg' });
    jpeg.arrayBuffer = async () => new Uint8Array([0xff]).buffer;
    const requestLoopStart = vi.fn<(payload: LoopStartRequestPayload) => void>();
    const deps: LoopPanelStartDeps = {
      sessionId: () => shown, notify: vi.fn(),
      isLoopStarting: () => false,
      panelConfig: () => ({ initialPrompt: 'Continue', provider: 'claude', workspaceCwd: '/tmp/example' }),
      message: () => 'Session A goal', pendingFiles: () => [photo],
      convertHeic: () => new Promise<File>((resolve) => { finish = resolve; }),
      setMessage: vi.fn(), setLoopStarting: vi.fn(), setLoopArmed: vi.fn(), setShowLoopPanel: vi.fn(),
      setLoopStartError: vi.fn(), requestLoopStart,
    };
    return { deps, requestLoopStart, finish: () => finish(jpeg), switchTo: (id: string) => { shown = id; } };
  }

  it('does not start the loop in the session switched to, and says so', async () => {
    const test = setup();

    const pending = tryStartLoopFromPanel(test.deps, 30_000);
    test.switchTo('session-b');
    test.finish();

    expect(await pending).toBe(false);
    expect(test.requestLoopStart).not.toHaveBeenCalled();
    expect(vi.mocked(test.deps.setLoopStarting).mock.calls).toEqual([[true], [false]]);
    expect(test.deps.setMessage).not.toHaveBeenCalled();
    expect(test.deps.notify).toHaveBeenCalledWith(expect.stringContaining('you switched session'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves the shown session's composer alone when the started loop replies after a switch", async () => {
    const test = setup();
    const pending = tryStartLoopFromPanel(test.deps, 30_000);
    test.finish();
    expect(await pending).toBe(true);
    const payload = test.requestLoopStart.mock.calls[0][0];
    expect(payload.firstMessage).toBe('Session A goal');

    test.switchTo('session-b');
    payload.onResolved(true);

    expect(test.deps.setMessage).not.toHaveBeenCalled();
    // The loop panel is shared across sessions; the started loop no longer needs it armed.
    expect(test.deps.setLoopArmed).toHaveBeenCalledWith(false);
    expect(test.deps.setShowLoopPanel).toHaveBeenCalledWith(false);
    expect(test.deps.notify).not.toHaveBeenCalled();
    expect(vi.mocked(test.deps.setLoopStarting).mock.calls).toEqual([[true], [false]]);
  });

  it('tells the user when the loop in the session they left fails to start', async () => {
    const test = setup();
    const pending = tryStartLoopFromPanel(test.deps, 30_000);
    test.finish();
    await pending;

    test.switchTo('session-b');
    test.requestLoopStart.mock.calls[0][0].onResolved(false, 'SYNTHETIC_DIAGNOSTIC');

    expect(test.deps.setLoopArmed).not.toHaveBeenCalled();
    expect(test.deps.setLoopStartError).not.toHaveBeenCalledWith('SYNTHETIC_DIAGNOSTIC');
    expect(test.deps.notify).toHaveBeenCalledWith(expect.stringContaining('session you left may not have started'), 'error');
  });

  it('tells the user, not the session switched to, when attachments fail after a switch', async () => {
    const test = setup();
    test.deps.convertHeic = async () => { throw new Error('SYNTHETIC_DIAGNOSTIC'); };

    const pending = tryStartLoopFromPanel(test.deps, 30_000);
    test.switchTo('session-b');

    expect(await pending).toBe(false);
    expect(test.deps.setShowLoopPanel).not.toHaveBeenCalled();
    expect(test.deps.setLoopStartError).not.toHaveBeenCalledWith(expect.stringContaining('IMG_1531.HEIC'));
    expect(test.deps.notify).toHaveBeenCalledWith(expect.stringContaining('you switched session'));
  });
});
