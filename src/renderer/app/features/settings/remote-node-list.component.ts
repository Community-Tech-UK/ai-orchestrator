/**
 * Remote Node List — the "list" half of the Computers list/detail workspace
 * (Task 4). Pure presentation: derives scan-friendly health/capability
 * summaries from the roster it's given and emits a typed selection event;
 * all async operations and authoritative state stay in the parent tab.
 */
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import { type NodeHealthEntry, buildNodeHealthEntries } from './remote-nodes-browser-automation';
import { formatNodeCapacity, formatNodePlatformLabel } from './remote-nodes-pairing-ui';

@Component({
  standalone: true,
  selector: 'app-remote-node-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="node-list" role="list" aria-label="Connected computers">
      @if (entries().length === 0) {
        <p class="field-hint node-list-empty">
          No computers have connected yet. Create a pairing code in Pairing and enter it on the
          other machine to connect one.
        </p>
      } @else {
        @for (entry of entries(); track entry.id) {
          <button
            type="button"
            role="listitem"
            class="node-list-row"
            [class.selected]="entry.id === selectedNodeId()"
            [attr.aria-current]="entry.id === selectedNodeId() ? 'true' : null"
            (click)="select(entry.id)"
          >
            <span class="node-list-row-main">
              <span class="node-list-name">{{ entry.name }}</span>
              <span class="node-list-meta">
                <span>{{ formatNodePlatformLabel(entry.platform) }}</span>
                @if (entry.address) {
                  <span>{{ entry.address }}</span>
                }
                <span>{{ formatNodeCapacity(entry) }}</span>
              </span>
              @if (entry.connectivityHint) {
                <span class="node-list-hint" role="status">{{ entry.connectivityHint }}</span>
              }
            </span>
            <span class="status-badge" [class]="'status-badge ' + entry.status">{{ entry.status }}</span>
          </button>
        }
      }
    </div>
  `,
  styleUrl: './remote-node-list.component.scss',
})
export class RemoteNodeListComponent {
  readonly nodes = input.required<readonly RemoteNodeRosterEntry[]>();
  readonly selectedNodeId = input<string | null>(null);
  readonly nodeSelected = output<string>();

  protected readonly entries = computed<NodeHealthEntry[]>(() =>
    buildNodeHealthEntries([...this.nodes()]),
  );

  protected readonly formatNodePlatformLabel = formatNodePlatformLabel;
  protected readonly formatNodeCapacity = formatNodeCapacity;

  protected select(id: string): void {
    this.nodeSelected.emit(id);
  }
}
