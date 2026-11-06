import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Diagnostics are deliberately text-only: provider HTML is never trusted here. */
@Component({
  selector: 'app-event-error-details',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rawDetail()) {
      <details><summary>Details</summary><pre>{{ rawDetail() }}</pre></details>
    }
  `,
  styles: `pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }`,
})
export class EventErrorDetailsComponent {
  readonly metadata = input<Record<string, unknown> | undefined>();
  protected readonly rawDetail = computed(() => {
    const presentation = this.metadata()?.['errorPresentation'];
    if (!presentation || typeof presentation !== 'object') return '';
    const detail = (presentation as Record<string, unknown>)['rawDetail'];
    return typeof detail === 'string' ? detail : '';
  });
}
