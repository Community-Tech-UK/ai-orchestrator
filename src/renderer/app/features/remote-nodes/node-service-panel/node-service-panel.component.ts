import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RemoteNodesStore } from '../remote-nodes.store';
import type { ServiceStatus } from '../../../../../shared/types/service.types';

@Component({
  selector: 'app-node-service-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './node-service-panel.component.html',
  styleUrls: ['./node-service-panel.component.scss'],
})
export class NodeServicePanelComponent implements OnInit {
  readonly nodeId = input.required<string>();
  private readonly store = inject(RemoteNodesStore);

  readonly status = computed<ServiceStatus | null>(
    () => this.store.serviceStatuses()[this.nodeId()] ?? null,
  );

  ngOnInit(): void {
    void this.store.refreshServiceStatus(this.nodeId());
  }

  restart(): void { void this.store.restartService(this.nodeId()); }
  stop(): void { void this.store.stopService(this.nodeId()); }
  uninstall(): void {
    if (confirm('Uninstall the worker service on this node? The node will disconnect.')) {
      void this.store.uninstallService(this.nodeId());
    }
  }
  refresh(): void { void this.store.refreshServiceStatus(this.nodeId()); }
}
