import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { NeedsYouStore } from './needs-you.store';
import { InstanceStore } from '../../core/state/instance.store';
import { PendingRequestStore } from '../../core/state/pending-request.store';
import { SessionNavigator } from '../../core/services/session-navigator.service';
import { NoticeSlotService } from '../../core/notices/notice-slot.service';

const TIMED_BANNERS = new Set(['permission-request', 'browser-approval', 'paid-fallback']);

@Component({
  selector: 'app-needs-you-strip', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (slot()) {
    <section class="needs-you-strip" role="status" aria-live="polite">
      <span>{{ line() }}</span>
      <button type="button" (click)="open()">Go to it</button>
      <button type="button" (click)="seeAll()">See all</button>
    </section>
  }`,
  styles: [`
    .needs-you-strip { display:flex; align-items:center; gap:var(--space-2,8px); padding:6px 16px; color:var(--text-primary); background:var(--bg-secondary); border-bottom:1px solid var(--border-color); font-size:12px; }
    span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    button { flex-shrink:0; color:var(--text-primary); background:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:var(--radius-sm,4px); cursor:pointer; padding:4px 8px; }
    button:focus-visible { outline:2px solid var(--primary-color); outline-offset:2px; }
  `],
})
export class NeedsYouStripComponent {
  private readonly needsYou = inject(NeedsYouStore);
  private readonly instances = inject(InstanceStore);
  private readonly requests = inject(PendingRequestStore);
  private readonly navigator = inject(SessionNavigator);
  private readonly router = inject(Router);
  readonly eligible = computed(() => this.needsYou.answerEntries().filter((entry) =>
    !TIMED_BANNERS.has(entry.source) && (!entry.instanceId || entry.instanceId !== this.instances.selectedInstanceId())));
  readonly front = computed(() => this.eligible()[0] ?? null);
  protected readonly slot = inject(NoticeSlotService).register('needs-you-strip', computed(() => this.eligible().length > 0), inject(DestroyRef));
  readonly line = computed(() => {
    const front = this.front();
    if (!front) return '';
    const request = front.source === 'session' && front.instanceId ? this.requests.forInstance(front.instanceId)[0] : null;
    const namedSource = front.source === 'sidechat' ? 'Sidechat' : front.source === 'loop-run' ? 'Loop'
      : front.source === 'automation-run' ? 'Automation' : front.source === 'repo-job' ? 'Repository job' : null;
    const notice = namedSource && front.title !== `${namedSource} needs you` ? `${namedSource} needs you: ${front.title}` : front.title;
    const sentence = front.source !== 'session' ? notice : request?.kind === 'permission'
      ? `‘${front.title}’ wants permission${request.toolName ? ' to use ' + request.toolName : ''}`
      : request?.kind === 'question' ? `‘${front.title}’ is waiting for your answer` : `‘${front.title}’ is waiting for you`;
    return this.eligible().length > 1 ? `${this.eligible().length} things are waiting for you · ${sentence}` : sentence;
  });
  open(): void {
    const entry = this.front();
    if (entry?.instanceId) this.navigator.openSession(entry.instanceId);
    else if (entry?.route) void this.router.navigateByUrl(entry.route);
  }
  seeAll(): void { void this.router.navigateByUrl('/work'); }
}
