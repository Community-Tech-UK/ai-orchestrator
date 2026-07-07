import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';

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

  private base = '';
  private listenersAttached = false;

  get available(): boolean {
    return Capacitor.isNativePlatform();
  }

  /** Begin dictation, appending to `base` (the composer's current draft). */
  async start(base: string): Promise<boolean> {
    if (!this.available || this.listening()) return false;
    try {
      const { available } = await SpeechRecognition.available();
      if (!available) return false;
      const perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== 'granted') return false;

      this.base = base.length && !base.endsWith(' ') ? `${base} ` : base;
      this.text.set(this.base.trimEnd());
      await this.attachListeners();
      await SpeechRecognition.start({ partialResults: true, popup: false });
      this.listening.set(true);
      return true;
    } catch {
      this.listening.set(false);
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.available) return;
    try {
      await SpeechRecognition.stop();
    } catch {
      /* already stopped */
    }
    this.listening.set(false);
  }

  private async attachListeners(): Promise<void> {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    await SpeechRecognition.addListener('partialResults', ({ matches }) => {
      const partial = matches?.[0] ?? '';
      this.text.set(`${this.base}${partial}`.trimEnd());
    });
    await SpeechRecognition.addListener('listeningState', ({ status }) => {
      if (status === 'stopped') {
        this.listening.set(false);
      }
    });
  }
}
