import { ConfirmService } from '../../../shared/confirm/confirm.service';
import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RemoteNodesStore } from '../remote-nodes.store';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
import type { ServiceStatus } from '../../../../../shared/types/service.types';

@Component({
  selector: 'app-node-service-panel',
  standalone: true,
  imports: [CommonModule, AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './node-service-panel.component.html',
  styleUrls: ['./node-service-panel.component.scss'],
})
export class NodeServicePanelComponent implements OnInit {
  private readonly confirmService = inject(ConfirmService);
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
  async uninstall(): Promise<void> {
    const nodeId = this.nodeId();
    if (await this.confirmService.confirm({ message: 'Uninstall the worker service on this node? The node will disconnect.', confirmLabel: 'Uninstall worker', danger: true })) {
      void this.store.uninstallService(nodeId);
    }
  }
  refresh(): void { void this.store.refreshServiceStatus(this.nodeId()); }
}
