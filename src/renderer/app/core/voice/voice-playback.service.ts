import { Injectable, signal } from '@angular/core';
import type { VoiceTtsResult } from '@contracts/schemas/voice';

@Injectable({ providedIn: 'root' })
export class VoicePlaybackService {
  readonly isPlaying = signal(false);
  readonly currentText = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;

  async play(result: VoiceTtsResult, text: string): Promise<void> {
    this.stop();
    this.currentText.set(text);
    this.error.set(null);

    const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: result.mimeType });
    this.objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(this.objectUrl);
    this.audio = audio;
    this.isPlaying.set(true);

    audio.onended = () => this.finishPlayback();
    audio.onerror = () => {
      this.error.set('Unable to play voice response.');
      this.finishPlayback();
    };

    try {
      await audio.play();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Unable to play voice response.');
      this.finishPlayback();
      throw error;
    }
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    this.finishPlayback();
  }

  private finishPlayback(): void {
    this.isPlaying.set(false);
    this.currentText.set(null);
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
