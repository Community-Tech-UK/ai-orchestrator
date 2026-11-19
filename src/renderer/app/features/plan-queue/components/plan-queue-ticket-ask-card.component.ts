import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { TICKET_ASK_ALREADY_ANSWERED, TICKET_ASK_CHANGED_AGAIN, type PlanQueueTicketAskView } from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { presentError } from '../../../../../shared/present-error';

/** What the card holds. The held text is other people's text: it lives in this component's signals and nowhere else. */
type CardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly view: PlanQueueTicketAskView }
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed'; readonly message: string };

type PlanQueueChangedPart = NonNullable<PlanQueueTicketAskView['held']>['changed'][number];

/** The main process's own words for a refused call. */
const failureText = (error: unknown): string => presentError(error).rawDetail;

const CHANGED_AGAIN_NOTICE = 'The ticket changed again. Read the new version below.';

let nextCardId = 0;

/** "Raf", "Raf and Sam", "Raf, Sam and an unknown author". */
function nameList(names: readonly (string | null)[]): string {
  const unique = [...new Set(names.map((name) => name?.trim() || 'an unknown author'))];
  return unique.length < 2 ? unique.join('') : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/**
 * The question a Linear ticket opens when its text no longer matches what James approved. It reads both versions through
 * the page-only channel when it opens and shows them as plain text, with each answer as a button and what it does beside
 * it. Nothing is kept outside this component: a second card for the same ticket reads again. An answer sends the hash of
 * the question that was shown, so a ticket that changed again is never answered unseen.
 */
@Component({
  selector: 'app-plan-queue-ticket-ask-card',
  standalone: true,
  templateUrl: './plan-queue-ticket-ask-card.component.html',
  styleUrl: './plan-queue-ticket-ask-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueTicketAskCardComponent {
  private readonly ipc = inject(PlanQueueIpcService);

  readonly itemId = input.required<string>();
  /** The job's row title (the identifier and approved title), shown until the question has been read. */
  readonly itemTitle = input<string | null>(null);
  /** Changes when the job's row changes, so a question that was replaced is read again. */
  readonly refreshKey = input<number>(0);

  protected readonly headingId = `pq-ticket-ask-${nextCardId++}`;
  private readonly state = signal<CardState>({ kind: 'loading' });
  protected readonly answering = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly problem = signal<string | null>(null);
  private loadSequence = 0;

  protected readonly view = computed(() => {
    const state = this.state();
    return state.kind === 'loaded' ? state.view : null;
  });
  protected readonly closed = computed(() => this.state().kind === 'closed');
  protected readonly loading = computed(() => this.state().kind === 'loading');
  protected readonly loadFailure = computed(() => {
    const state = this.state();
    return state.kind === 'failed' ? state.message : null;
  });

  protected readonly heading = computed(() => {
    const view = this.view();
    if (view?.approved) return `${view.identifier} ${view.approved.title}`;
    return this.itemTitle() ?? view?.identifier ?? 'A Linear ticket';
  });

  /** One line saying what changed, in words. */
  protected readonly changeLine = computed(() => {
    const view = this.view();
    if (!view) return null;
    switch (view.kind) {
      case 'gone': return 'This ticket was removed from Linear or moved out of its project.';
      case 'unconfirmed': return 'Harness cannot confirm what you approved for this ticket.';
      case 'cleared': return 'The text you approved was deleted, because Harness keeps client text for 30 days at most.';
      case 'changed': {
        const changed = view.held?.changed ?? ([] as PlanQueueChangedPart[]);
        const newCommentAuthors = view.held?.newCommentAuthors ?? ([] as (string | null)[]);
        const parts: string[] = [];
        if (changed.includes('title')) parts.push('The title changed.');
        if (changed.includes('description')) parts.push('The description changed.');
        if (changed.includes('comments')) {
          parts.push(newCommentAuthors.length === 0 ? 'The comments changed.'
            : `${newCommentAuthors.length === 1 ? 'A new comment' : 'New comments'} from ${nameList(newCommentAuthors)}.`);
        }
        return parts.join(' ') || 'The ticket changed.';
      }
    }
  });

  protected readonly approvedAt = computed(() => {
    const approved = this.view()?.approved;
    return approved ? new Date(approved.approvedAt).toLocaleString() : null;
  });

  constructor() {
    effect(() => {
      this.itemId();
      this.refreshKey();
      untracked(() => void this.load());
    });
  }

  /** What each answer does, beside its button. */
  protected consequence(view: PlanQueueTicketAskView, optionId: string): string {
    switch (optionId) {
      case 'use-now': return view.kind === 'cleared' ? 'This text becomes the version you approved.' : 'The worker will be told the ticket changed.';
      case 'keep-approved': return 'Harness will not ask about this change again.';
      case 'stop': return 'This ticket will be set aside, or skipped if its work has not started.';
      case 'leave-waiting': return 'The ticket stays waiting. Nothing starts until you answer.';
      default: return '';
    }
  }

  protected async load(): Promise<void> {
    const sequence = ++this.loadSequence;
    let next: CardState;
    try {
      const response = await this.ipc.ticketAskRead(this.itemId());
      if (!response.success) next = { kind: 'failed', message: failureText(response.error) || 'This question could not be read.' };
      else next = response.data?.ask ? { kind: 'loaded', view: response.data.ask } : { kind: 'closed' };
    } catch (error) {
      next = { kind: 'failed', message: failureText(error) || 'This question could not be read.' };
    }
    // A later read replaces this one: only the newest answer is shown.
    if (sequence === this.loadSequence) this.state.set(next);
  }

  protected async onAnswer(view: PlanQueueTicketAskView, optionId: string): Promise<void> {
    if (this.answering()) return;
    this.answering.set(true);
    this.problem.set(null);
    this.notice.set(null);
    try {
      const response = await this.ipc.ticketAskAnswer({ itemId: view.itemId, optionId, askHash: view.askHash });
      if (response.success) {
        if (optionId === 'leave-waiting') this.notice.set('Left waiting. Nothing starts until you answer.');
        else this.state.set({ kind: 'closed' });
        return;
      }
      const message = failureText(response.error);
      if (message.includes(TICKET_ASK_CHANGED_AGAIN)) {
        await this.load();
        this.notice.set(CHANGED_AGAIN_NOTICE);
      } else if (message.includes(TICKET_ASK_ALREADY_ANSWERED)) {
        await this.load();
      } else {
        this.problem.set(message || 'The answer could not be sent.');
      }
    } catch (error) {
      this.problem.set(failureText(error) || 'The answer could not be sent.');
    } finally {
      this.answering.set(false);
    }
  }
}
