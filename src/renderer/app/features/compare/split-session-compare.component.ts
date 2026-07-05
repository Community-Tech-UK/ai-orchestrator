/**
 * Split Session Compare Component (E9)
 *
 * Shows two instance sessions side-by-side in a fixed 50/50 split
 * so users can compare two agents' output streams simultaneously.
 * Each pane has an instance picker (dropdown of all running instances)
 * and shows the selected instance's full output stream below.
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import type { Instance, OutputMessage } from '../../core/state/instance/instance.types';
import { OutputStreamComponent } from '../instance-detail/output-stream.component';

// ────────────────────────────────────────────────────────────
// Pure helper — exported for unit testing without TestBed
// ────────────────────────────────────────────────────────────

/**
 * Pick default IDs for left and right panes from the instance list.
 * Left gets [0], right gets [1] when available; otherwise null.
 */
export function pickPaneDefaults(instances: Instance[]): [string | null, string | null] {
  return [
    instances[0]?.id ?? null,
    instances[1]?.id ?? null,
  ];
}

// ────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────

@Component({
  selector: 'app-split-session-compare',
  standalone: true,
  imports: [OutputStreamComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './split-session-compare.component.html',
  styleUrl: './split-session-compare.component.scss',
})
export class SplitSessionCompareComponent {
  private readonly store = inject(InstanceStore);

  /** Reactive list of all known instances — drives both pickers. */
  protected readonly instances = this.store.instances;

  // ── Pane selection signals ─────────────────────────────────

  /** ID of the instance shown in the left pane, or null when none selected. */
  protected readonly leftId = signal<string | null>(null);

  /** ID of the instance shown in the right pane, or null when none selected. */
  protected readonly rightId = signal<string | null>(null);

  // ── Derived instance + messages ───────────────────────────

  /** Resolved Instance object for the left pane (null when unselected). */
  protected readonly leftInstance = computed<Instance | null>(() => {
    const id = this.leftId();
    return id ? (this.store.getInstance(id) ?? null) : null;
  });

  /** Resolved Instance object for the right pane (null when unselected). */
  protected readonly rightInstance = computed<Instance | null>(() => {
    const id = this.rightId();
    return id ? (this.store.getInstance(id) ?? null) : null;
  });

  /** Output messages for the left pane's output stream. */
  protected readonly leftMessages = computed<OutputMessage[]>(() =>
    this.leftInstance()?.outputBuffer ?? []
  );

  /** Output messages for the right pane's output stream. */
  protected readonly rightMessages = computed<OutputMessage[]>(() =>
    this.rightInstance()?.outputBuffer ?? []
  );

  // ── Default seeding ────────────────────────────────────────

  constructor() {
    // Seed defaults once when instances first become available.
    // We only seed if the panes are still unset (null) so that a user who
    // has already made a selection isn't overridden when new instances arrive.
    effect(() => {
      const list = this.instances();
      if (list.length > 0 && this.leftId() === null && this.rightId() === null) {
        const [defaultLeft, defaultRight] = pickPaneDefaults(list);
        this.leftId.set(defaultLeft);
        this.rightId.set(defaultRight);
      }
    });
  }

  // ── Event handlers ─────────────────────────────────────────

  protected onLeftChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.leftId.set(value || null);
  }

  protected onRightChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.rightId.set(value || null);
  }

  /** Display label for a picker option (id + displayName). */
  protected instanceLabel(inst: Instance): string {
    return inst.displayName || inst.id;
  }
}
