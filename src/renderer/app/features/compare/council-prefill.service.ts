import { Injectable } from '@angular/core';

/** One pending prompt, consumed when the Council page opens. Never starts a run. */
@Injectable({ providedIn: 'root' })
export class CouncilPrefillService {
  private pendingText: string | null = null;

  set(text: string): void {
    this.pendingText = text;
  }

  take(): string | null {
    const text = this.pendingText;
    this.pendingText = null;
    return text;
  }
}
