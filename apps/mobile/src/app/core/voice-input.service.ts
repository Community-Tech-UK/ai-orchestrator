import { Injectable, signal } from '@angular/core';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';

interface DictationSession {
  base: string;
  cancelled: Promise<false>;
  cancel: () => void;
  listeners: PluginListenerHandle[];
}

/**
 * On-device dictation via SFSpeechRecognizer (iOS). One dictation session at a
 * time, owned by whichever composer is on screen:
 *
 *   1. `start(base)` — remembers the composer's current draft as the prefix.
 *   2. While listening, `text()` is `base + live partial transcript`; the
 *      composer mirrors it into its draft signal via an effect.
 *   3. `stop()` (or the recognizer stopping itself) freezes the final text.
 *
 * No-ops on the web/dev build. Permission prompts (mic + speech recognition)
 * are raised lazily on the first `start()`.
 */
@Injectable({ providedIn: 'root' })
export class VoiceInputService {
  /** True while the recognizer is actively listening. */
  readonly listening = signal(false);
  /** Base draft + live partial transcript (only meaningful while/after listening). */
  readonly text = signal('');

  private session: DictationSession | undefined;
  private nativeOperations: Promise<unknown> = Promise.resolve();

  get available(): boolean {
    return Capacitor.isNativePlatform();
  }

  /** Begin dictation, appending to `base` (the composer's current draft). */
  async start(base: string): Promise<boolean> {
    if (!this.available || this.session) return false;
    let cancel!: () => void;
    const session: DictationSession = {
      base: base.length && !base.endsWith(' ') ? `${base} ` : base,
      cancelled: new Promise<false>((resolve) => { cancel = () => resolve(false); }),
      cancel: () => cancel(),
      listeners: [],
    };
    this.session = session;
    const started = await Promise.race([this.begin(session), session.cancelled]);
    return started && this.session === session;
  }

  /** Invalidate the composer immediately, including a pending permission prompt. */
  stop(): Promise<void> {
    if (this.session) this.release(this.session);
    this.listening.set(false);
    if (!this.available) return Promise.resolve();
    // Never allow a delayed stop to overtake a subsequent native start.
    return this.serializeNative(() => this.stopNative());
  }

  private async begin(session: DictationSession): Promise<boolean> {
    let started = false;
    try {
      const { available } = await SpeechRecognition.available();
      if (this.session !== session || !available) return false;
      const perm = await SpeechRecognition.requestPermissions();
      if (this.session !== session || perm.speechRecognition !== 'granted') return false;
      started = await this.serializeNative(() => this.startNative(session));
      return started;
    } catch {
      return false;
    } finally {
      if (!started) this.release(session);
    }
  }

  private async startNative(session: DictationSession): Promise<boolean> {
    if (this.session !== session) return false;
    // Install only after the previous native stop has settled, so its events
    // cannot be received by the next session while it waits in the queue.
    await this.attachListener(session, SpeechRecognition.addListener('partialResults', ({ matches }) => {
      if (this.session === session) {
        this.text.set(`${session.base}${matches?.[0] ?? ''}`.trimEnd());
      }
    }));
    if (this.session !== session) return false;
    await this.attachListener(session, SpeechRecognition.addListener('listeningState', ({ status }) => {
      if (status === 'stopped') this.release(session);
    }));
    if (this.session !== session) return false;
    this.text.set(session.base.trimEnd());
    try {
      await SpeechRecognition.start({ partialResults: true, popup: false });
    } catch {
      // A rejected native start may have acquired the microphone. Clean up
      // inside this same queue entry, before a later start can run.
      await this.stopNative();
      return false;
    }
    if (this.session !== session) return false;
    this.listening.set(true);
    return true;
  }

  private async stopNative(): Promise<void> {
    try {
      await SpeechRecognition.stop();
    } catch {
      /* already stopped */
    }
  }

  private async attachListener(session: DictationSession, pending: Promise<PluginListenerHandle>): Promise<void> {
    const installed = pending.then((handle) => {
      if (this.session === session) session.listeners.push(handle);
      else this.removeListener(handle);
    });
    // Cancellation must also free the native queue if listener installation
    // never settles. A late handle is removed by the continuation above.
    await Promise.race([installed, session.cancelled]);
  }

  private release(session: DictationSession): void {
    if (this.session === session) {
      this.session = undefined;
      this.listening.set(false);
    }
    session.cancel();
    for (const handle of session.listeners.splice(0)) this.removeListener(handle);
  }

  private removeListener(handle: PluginListenerHandle): void {
    try {
      void handle.remove().catch(() => { /* Stale callbacks are also guarded by session identity. */ });
    } catch {
      /* Some native bridges can throw before returning a promise. */
    }
  }

  private serializeNative<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.nativeOperations.then(operation);
    this.nativeOperations = pending.catch(() => undefined);
    return pending;
  }
}
