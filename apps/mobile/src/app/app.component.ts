import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { HostStore } from './core/host-store';
import { GatewayClient } from './core/gateway-client.service';
import { PushService } from './core/push.service';
import {
  ApprovalSheetComponent,
  type ApprovalDecision,
} from './features/approval/approval-sheet.component';
import type { MobilePromptDto } from './core/models';

@Component({
  standalone: true,
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, ApprovalSheetComponent],
  template: `
    <router-outlet />
    @if (activePrompt(); as p) {
      <app-approval-sheet
        [prompt]="p"
        (decision)="decide(p, $event)"
        (open)="openSession(p)"
        (dismiss)="dismiss(p)"
      />
    }
  `,
})
export class AppComponent implements OnInit {
  private readonly hostStore = inject(HostStore);
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);
  private readonly push = inject(PushService);

  private readonly suppressed = signal<Set<string>>(new Set());

  /** The most recent pending prompt the user hasn't dismissed. */
  protected readonly activePrompt = computed<MobilePromptDto | null>(() => {
    const suppressed = this.suppressed();
    const open = this.gateway.prompts().filter((p) => !suppressed.has(p.id));
    return open.length ? open[open.length - 1] : null;
  });

  async ngOnInit(): Promise<void> {
    void this.gateway; // keep the eager injection (its auto-reconnect effect is live)
    await this.hostStore.load();
    void this.push.init(); // request push permission + register token (native only)
  }

  protected async decide(prompt: MobilePromptDto, decision: ApprovalDecision): Promise<void> {
    try {
      await this.gateway.respond(prompt.instanceId, {
        requestId: prompt.requestId,
        decisionAction: decision.action,
        decisionScope: decision.scope,
      });
    } catch {
      /* the prompt stays if the call fails */
    }
  }

  protected openSession(prompt: MobilePromptDto): void {
    this.dismiss(prompt);
    const instance = this.gateway.snapshot()?.instances.find((i) => i.id === prompt.instanceId);
    const projectKey = instance?.workingDirectory || '__no_workspace__';
    void this.router.navigate(['/projects', projectKey, 'sessions', prompt.instanceId]);
  }

  protected dismiss(prompt: MobilePromptDto): void {
    this.suppressed.set(new Set(this.suppressed()).add(prompt.id));
  }
}
