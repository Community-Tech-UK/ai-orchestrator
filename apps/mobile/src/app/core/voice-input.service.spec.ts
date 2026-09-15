import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceInputService } from './voice-input.service';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn() } }));
vi.mock('@capacitor-community/speech-recognition', () => ({
  SpeechRecognition: {
    available: vi.fn(), requestPermissions: vi.fn(), start: vi.fn(), stop: vi.fn(), addListener: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('VoiceInputService ownership', () => {
  let service: VoiceInputService;
  let partials: ((data: { matches: string[] }) => void)[];
  let states: ((data: { status: 'started' | 'stopped' }) => void)[];
  let removals: ReturnType<typeof vi.fn>[];

  beforeEach(() => {
    vi.resetAllMocks();
    service = new VoiceInputService();
    partials = []; states = []; removals = [];
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(SpeechRecognition.available).mockResolvedValue({ available: true });
    vi.mocked(SpeechRecognition.requestPermissions).mockResolvedValue({ speechRecognition: 'granted' });
    vi.mocked(SpeechRecognition.start).mockResolvedValue({});
    vi.mocked(SpeechRecognition.stop).mockResolvedValue();
    vi.mocked(SpeechRecognition.addListener).mockImplementation(async (
      event: 'partialResults' | 'listeningState',
      listener: ((data: { matches: string[] }) => void) | ((data: { status: 'started' | 'stopped' }) => void),
    ) => {
      if (event === 'partialResults') partials.push(listener as (data: { matches: string[] }) => void);
      else states.push(listener as (data: { status: 'started' | 'stopped' }) => void);
      const remove = vi.fn().mockResolvedValue(undefined);
      removals.push(remove);
      return { remove };
    });
  });

  it('freezes text and stops publishing synchronously while native stop is pending', async () => {
    const nativeStop = deferred<void>();
    vi.mocked(SpeechRecognition.stop).mockReturnValue(nativeStop.promise);
    expect(await service.start('Existing draft')).toBe(true);
    partials[0]({ matches: ['dictated text'] });
    expect(service.text()).toBe('Existing draft dictated text');

    const stopping = service.stop();
    expect(service.listening()).toBe(false);
    partials[0]({ matches: ['late text for old composer'] });
    expect(service.text()).toBe('Existing draft dictated text');
    nativeStop.resolve();
    await stopping;
  });

  it('settles a cancelled permission request immediately and never starts its recognizer later', async () => {
    const permissions = deferred<{ speechRecognition: 'granted' }>();
    vi.mocked(SpeechRecognition.requestPermissions).mockReturnValue(permissions.promise);
    const starting = service.start('Old draft');
    await vi.waitFor(() => expect(SpeechRecognition.requestPermissions).toHaveBeenCalledOnce());
    await service.stop();
    await expect(starting).resolves.toBe(false);
    permissions.resolve({ speechRecognition: 'granted' });
    await Promise.resolve();
    expect(SpeechRecognition.start).not.toHaveBeenCalled();
    expect(service.listening()).toBe(false);
    expect(service.text()).toBe('');
  });

  it('accepts only one overlapping start while availability or permission checks are pending', async () => {
    const availability = deferred<{ available: boolean }>();
    vi.mocked(SpeechRecognition.available).mockReturnValue(availability.promise);
    const starting = service.start('First');
    await expect(service.start('Second')).resolves.toBe(false);
    availability.resolve({ available: true });
    await expect(starting).resolves.toBe(true);
    expect(SpeechRecognition.start).toHaveBeenCalledOnce();
    partials[0]({ matches: ['words'] });
    expect(service.text()).toBe('First words');
  });

  it('lets a new composer start while cancelled permissions remain pending', async () => {
    const permissions = deferred<{ speechRecognition: 'granted' }>();
    vi.mocked(SpeechRecognition.requestPermissions).mockReturnValueOnce(permissions.promise);
    const first = service.start('Old');
    await vi.waitFor(() => expect(SpeechRecognition.requestPermissions).toHaveBeenCalledOnce());
    await service.stop();
    await expect(first).resolves.toBe(false);
    expect(await service.start('New')).toBe(true);
    partials[0]({ matches: ['draft'] });
    permissions.resolve({ speechRecognition: 'granted' });
    await Promise.resolve();
    await Promise.resolve();
    expect(SpeechRecognition.start).toHaveBeenCalledOnce();
    expect(service.text()).toBe('New draft');
    expect(service.listening()).toBe(true);
  });

  it('finishes an old native stop before starting again and ignores the old listeners', async () => {
    await service.start('First');
    const nativeStop = deferred<void>();
    vi.mocked(SpeechRecognition.stop).mockReturnValueOnce(nativeStop.promise);
    const stopping = service.stop();
    const starting = service.start('Second');
    await vi.waitFor(() => expect(SpeechRecognition.requestPermissions).toHaveBeenCalledTimes(2));
    expect(SpeechRecognition.start).toHaveBeenCalledTimes(1);
    nativeStop.resolve();
    await stopping;
    expect(await starting).toBe(true);

    partials.at(-1)!({ matches: ['new words'] });
    partials[0]({ matches: ['old words'] });
    states[0]({ status: 'stopped' });
    expect(service.text()).toBe('Second new words');
    expect(service.listening()).toBe(true);
    expect(removals[0]).toHaveBeenCalledOnce();
    expect(removals[1]).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight native start without publishing and queues its stop before a new start', async () => {
    const nativeStart = deferred<Record<string, never>>();
    vi.mocked(SpeechRecognition.start).mockReturnValueOnce(nativeStart.promise);
    const first = service.start('First');
    await vi.waitFor(() => expect(SpeechRecognition.start).toHaveBeenCalledOnce());
    const stopping = service.stop();
    await expect(first).resolves.toBe(false);
    const next = service.start('Second');
    expect(service.listening()).toBe(false);
    expect(SpeechRecognition.stop).not.toHaveBeenCalled();
    nativeStart.resolve({});
    await stopping;
    expect(await next).toBe(true);
    expect(vi.mocked(SpeechRecognition.stop).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(SpeechRecognition.start).mock.invocationCallOrder[1]);
  });

  it('cleans up partial listener installation on failure and supports a complete retry', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SpeechRecognition.addListener)
      .mockResolvedValueOnce({ remove })
      .mockRejectedValueOnce(new Error('Listener installation failed'));
    expect(await service.start('First')).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    expect(SpeechRecognition.start).not.toHaveBeenCalled();
    expect(await service.start('Retry')).toBe(true);
    expect(SpeechRecognition.addListener).toHaveBeenCalledTimes(4);
    partials.at(-1)!({ matches: ['works'] });
    expect(service.text()).toBe('Retry works');
  });

  it('removes a listener that finishes installing after cancellation', async () => {
    const listener = deferred<PluginListenerHandle>();
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SpeechRecognition.addListener).mockReturnValueOnce(listener.promise);
    const starting = service.start('Old');
    await vi.waitFor(() => expect(SpeechRecognition.addListener).toHaveBeenCalledOnce());
    await service.stop();
    await expect(starting).resolves.toBe(false);
    listener.resolve({ remove });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(SpeechRecognition.start).not.toHaveBeenCalled();
    expect(SpeechRecognition.addListener).toHaveBeenCalledOnce();
    expect(await service.start('New')).toBe(true);
  });

  it('does not re-enable listening when native start resolves after a stopped event', async () => {
    const nativeStart = deferred<Record<string, never>>();
    vi.mocked(SpeechRecognition.start).mockReturnValueOnce(nativeStart.promise);
    const starting = service.start('Draft');
    await vi.waitFor(() => expect(SpeechRecognition.start).toHaveBeenCalledOnce());
    states[0]({ status: 'stopped' });
    nativeStart.resolve({});
    await expect(starting).resolves.toBe(false);
    expect(service.listening()).toBe(false);
  });

  it('returns failure after permission denial and allows retry', async () => {
    vi.mocked(SpeechRecognition.requestPermissions).mockResolvedValueOnce({ speechRecognition: 'denied' });
    expect(await service.start('Draft')).toBe(false);
    expect(SpeechRecognition.start).not.toHaveBeenCalled();
    expect(await service.start('Draft')).toBe(true);
  });

  it('does not call the native recognizer on web', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await service.start('Draft')).toBe(false);
    await service.stop();
    expect(SpeechRecognition.available).not.toHaveBeenCalled();
    expect(SpeechRecognition.stop).not.toHaveBeenCalled();
  });
});
