import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HostStore } from './core/host-store';
import { GatewayClient } from './core/gateway-client.service';

@Component({
  standalone: true,
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class AppComponent implements OnInit {
  private readonly hostStore = inject(HostStore);
  // Eagerly construct the gateway client so its auto-reconnect effect is live
  // before any screen renders.
  private readonly gateway = inject(GatewayClient);

  async ngOnInit(): Promise<void> {
    void this.gateway; // referenced to keep the eager injection
    await this.hostStore.load();
  }
}
