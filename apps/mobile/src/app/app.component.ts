import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { HostStore } from './core/host-store';
import { GatewayClient } from './core/gateway-client.service';
import { LiveActivityService } from './core/live-activity.service';
import { PushService } from './core/push.service';
import { ResumeService } from './core/resume.service';
import { AppLockService } from './core/app-lock.service';
import {
  ApprovalSheetComponent,
  type ApprovalDecision,
} from './features/approval/approval-sheet.component';
import { LockScreenComponent } from './features/lock/lock-screen.component';
import type { MobilePromptDto } from './core/models';

@Component({
  standalone: true,
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, ApprovalSheetComponent, LockScreenComponent],
  template: `
    <router-outlet />
    @if (activePrompt(); as p) {
      <app-approval-sheet
        [prompt]="p"
        [error]="decideErrorFor(p)"
        (decision)="decide(p, $event)"
        (open)="openSession(p)"
        (dismiss)="dismiss(p)"
      />
    }
    @if (appLock.locked()) {
      <app-lock-screen />
    }
  `,
})
export class AppComponent implements OnInit {
  private readonly hostStore = inject(HostStore);
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);
  private readonly push = inject(PushService);
  private readonly liveActivity = inject(LiveActivityService);
  private readonly resume = inject(ResumeService);
  protected readonly appLock = inject(AppLockService);

  private readonly suppressed = signal<Set<string>>(new Set());

  /** The most recent pending prompt the user hasn't dismissed. */
  protected readonly activePrompt = computed<MobilePromptDto | null>(() => {
    const suppressed = this.suppressed();
    const open = this.gateway.prompts().filter((p) => !suppressed.has(p.id));
    return open.length ? open[open.length - 1] : null;
  });

  /**
   * Why the last approval decision failed, shown on the sheet itself. Keyed by
   * prompt so an error can never attach itself to a different prompt.
   */
  private readonly decideError = signal<{ promptId: string; message: string } | null>(null);

  protected decideErrorFor(prompt: MobilePromptDto): string | null {
    const failure = this.decideError();
    return failure?.promptId === prompt.id ? failure.message : null;
  }

  async ngOnInit(): Promise<void> {
    void this.gateway; // keep the eager injection (its auto-reconnect effect is live)
    await this.appLock.init(); // raise the biometric gate before anything renders behind it
    await this.hostStore.load();
    void this.push.init(); // request push permission + register token (native only)
    void this.liveActivity.init(); // lock-screen session activity (native only)
    // If iOS evicted the app while backgrounded, return to where the user was.
    void this.resume.restore();
  }

  protected async decide(prompt: MobilePromptDto, decision: ApprovalDecision): Promise<void> {
    this.decideError.set(null);
    try {
      await this.gateway.respond(prompt.instanceId, {
        requestId: prompt.requestId,
        decisionAction: decision.action,
        decisionScope: decision.scope,
        response: decision.response,
      });
    } catch (err) {
      // The prompt stays, and now says why. Silently swallowing this left a
      // rejected token looking like a dead button, with the connection pill
      // hidden behind the sheet.
      this.decideError.set({
        promptId: prompt.id,
        message: err instanceof Error ? err.message : String(err),
      });
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
