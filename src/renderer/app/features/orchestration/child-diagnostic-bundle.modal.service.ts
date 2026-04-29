import { Injectable, signal } from '@angular/core';
import type { ChildDiagnosticBundle } from '../../../../shared/types/agent-tree.types';

@Injectable({ providedIn: 'root' })
export class ChildDiagnosticBundleModalService {
  private _bundle = signal<ChildDiagnosticBundle | null>(null);
  readonly bundle = this._bundle.asReadonly();

  open(bundle: ChildDiagnosticBundle): void {
    this._bundle.set(bundle);
  }

  close(): void {
    this._bundle.set(null);
  }
}
