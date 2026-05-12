/**
 * SourceControlInlineDiffComponent — embedded inline diff that appears
 * directly below a file row in the Source Control panel when the user
 * clicks the row's chevron.
 *
 * Lifecycle: created/destroyed by the parent's `@if (expanded) { ... }`.
 * When the chevron is collapsed, the component is removed from the tree
 * and its `DiffLoader` is garbage-collected — no manual cleanup needed.
 *
 * Lazy-loads on first mount: the `effect()` in the constructor calls
 * `loader.load(...)` once the inputs are set. Subsequent input changes
 * (e.g. file path changes on the same row, which shouldn't normally
 * happen) re-fetch and the loader's sequence counter drops stale
 * responses.
 */

import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
} from '@angular/core';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import { DiffLoader } from './diff-loader';
import { SourceControlDiffViewComponent } from './source-control-diff-view.component';

@Component({
  selector: 'app-source-control-inline-diff',
  standalone: true,
  imports: [SourceControlDiffViewComponent],
  template: `
    <div class="inline-diff">
      <app-source-control-diff-view [loader]="loader" />
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .inline-diff {
      max-height: 360px;
      overflow: auto;
      background: var(--bg-primary);
      border-top: 1px solid var(--border-subtle);
      border-bottom: 1px solid var(--border-subtle);
    }

    .inline-diff::-webkit-scrollbar { width: 8px; height: 8px; }
    .inline-diff::-webkit-scrollbar-track { background: var(--bg-secondary); }
    .inline-diff::-webkit-scrollbar-thumb {
      background: var(--border-light);
      border-radius: 4px;
      border: 2px solid var(--bg-secondary);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourceControlInlineDiffComponent {
  private vcs = inject(VcsIpcService);

  workingDirectory = input.required<string>();
  filePath = input.required<string>();
  staged = input.required<boolean>();

  protected readonly loader = new DiffLoader(this.vcs);

  constructor() {
    effect(() => {
      const wd = this.workingDirectory();
      const fp = this.filePath();
      const st = this.staged();
      void this.loader.load(wd, fp, st);
    });
  }
}
