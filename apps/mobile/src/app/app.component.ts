import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { HostStore } from './core/host-store';
import { GatewayClient } from './core/gateway-client.service';
import { LiveActivityService } from './core/live-activity.service';
import { PushService } from './core/push.service';
import { ResumeService } from './core/resume.service';
import { AppLockService } from './core/app-lock.service';
import { ApprovalSheetComponent } from './features/approval/approval-sheet.component';
import { ApprovalPresentationStore, type ApprovalView } from './core/approval-presentation.store';
import { LockScreenComponent } from './features/lock/lock-screen.component';
import { MobileSheetComponent } from './shared/mobile-sheet.component';

@Component({
  standalone: true,
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, ApprovalSheetComponent, LockScreenComponent, MobileSheetComponent],
  template: `
    <router-outlet />
    @if (approvals.view(); as view) {
      <app-approval-sheet
        [prompt]="view.prompt"
        [error]="approvals.error()"
        [pending]="approvals.pending()"
        [draft]="approvals.draft()"
        [requests]="approvals.requests()"
        [context]="approvalContext()"
        (decision)="approvals.decide($event, view)"
        (scopeChange)="approvals.setScope($event, view)"
        (answerChange)="approvals.updateAnswer($event.index, $event.value, view)"
        (requestSelected)="approvals.open($event, view)"
        (open)="openSession(view)"
        (dismiss)="approvals.dismiss(view)"
      />
    }
    @if (appLock.locked()) {
      <app-lock-screen />
    }
    @if (push.endedSession()) {
      <app-mobile-sheet label="This session has ended" (dismiss)="push.dismissRoutingIssue()">
        <p>The session is no longer running on this host. You can read its saved transcript or return to your projects.</p>
        <div class="ended-session-actions">
          <button class="mobile-secondary-button" type="button" (click)="push.openEndedSessionProjects()">Projects</button>
          <button class="mobile-primary-button" type="button" (click)="push.openEndedSessionHistory()">History</button>
        </div>
      </app-mobile-sheet>
    }
    @if (push.unknownHost()) {
      <app-mobile-sheet label="Host not paired" (dismiss)="push.dismissRoutingIssue()">
        <p>This notification came from another host. You need to pair this host before you can open its prompt.</p>
        <div class="ended-session-actions">
          <button class="mobile-primary-button" type="button" (click)="push.openEndedSessionProjects()">Projects</button>
        </div>
      </app-mobile-sheet>
    }
    @if (push.hostUnavailable()) {
      <app-mobile-sheet label="Host unavailable" (dismiss)="push.dismissRoutingIssue()">
        <p>The paired host could not confirm whether this session is still running. Check the connection and try again.</p>
        <div class="ended-session-actions">
          <button class="mobile-secondary-button" type="button" (click)="push.openEndedSessionProjects()">Projects</button>
          <button class="mobile-primary-button" type="button" (click)="push.retryNotificationRouting()">Retry</button>
        </div>
      </app-mobile-sheet>
    }
  `,
  styles: [`
    .ended-session-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }
  `],
})
export class AppComponent implements OnInit {
  private readonly hostStore = inject(HostStore);
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);
  protected readonly push = inject(PushService);
  private readonly liveActivity = inject(LiveActivityService);
  private readonly resume = inject(ResumeService);
  protected readonly appLock = inject(AppLockService);
  protected readonly approvals = inject(ApprovalPresentationStore);
  protected readonly approvalContext = computed(() => {
    const prompt = this.approvals.activePrompt();
    const instance = this.gateway.snapshot()?.instances.find((item) => item.id === prompt?.instanceId);
    return {
      host: this.hostStore.activeHost()?.name || 'Unknown host',
      project: instance?.projectName || instance?.workingDirectory || 'No workspace',
      session: instance?.displayName || 'Session unavailable',
    };
  });

  async ngOnInit(): Promise<void> {
    void this.gateway; // keep the eager injection (its auto-reconnect effect is live)
    await this.appLock.init(); // raise the biometric gate before anything renders behind it
    await this.hostStore.load();
    void this.push.init(); // request push permission + register token (native only)
    void this.liveActivity.init(); // lock-screen session activity (native only)
    // If iOS evicted the app while backgrounded, return to where the user was.
    void this.resume.restore();
  }

  protected openSession(view: ApprovalView): void {
    if (!this.approvals.isCurrentView(view)) return;
    const prompt = view.prompt;
    this.approvals.dismiss(view);
    const instance = this.gateway.snapshot()?.instances.find((i) => i.id === prompt.instanceId);
    const projectKey = instance?.workingDirectory || '__no_workspace__';
    void this.router.navigate(['/projects', projectKey, 'sessions', prompt.instanceId]);
  }
}
