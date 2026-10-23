import { Injectable, signal } from '@angular/core';
import type { HelpTarget } from './help-target';

@Injectable({ providedIn: 'root' })
export class HelpDrawerService {
  private readonly openTarget = signal<HelpTarget | null>(null);
  readonly target = this.openTarget.asReadonly();
  open(target: HelpTarget): void { this.openTarget.set(target); }
  close(): void { this.openTarget.set(null); }
}
