import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { z } from 'zod';
import type { DocReviewItemInfo, DocReviewItemVerdict } from './doc-review.types';

const TYPE_PREFIX = 'aio-review/';

const ItemInfoSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(500).optional(),
  decisionId: z.string().max(50).nullable().optional(),
});

const ReadyMessageSchema = z.object({
  type: z.literal('aio-review/ready'),
  items: z.array(ItemInfoSchema).max(1000).optional(),
});

const DecisionMessageSchema = z.object({
  type: z.literal('aio-review/decision'),
  itemId: z.string().min(1).max(200),
  decision: z.enum(['approve', 'reject']).nullable(),
});

const CommentMessageSchema = z.object({
  type: z.literal('aio-review/comment'),
  itemId: z.string().min(1).max(200),
  comment: z.string().max(10_000),
});

export interface DocReviewDecisionMessage {
  itemId: string;
  decision: DocReviewItemVerdict;
}

export interface DocReviewCommentMessage {
  itemId: string;
  comment: string;
}

/**
 * Hosts a review artifact in a sandboxed iframe (`sandbox="allow-scripts"`, deliberately
 * NO `allow-same-origin`) and bridges its postMessage protocol. The artifact JS cannot
 * reach cookies, `electronAPI`, or the app DOM. Every inbound message is checked for the
 * iframe as its source, the `aio-review/` type prefix, and a valid Zod shape before it
 * touches app state.
 */
@Component({
  selector: 'app-doc-review-viewer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <iframe
      #frame
      class="artifact-frame"
      title="Document review artifact"
      sandbox="allow-scripts"
    ></iframe>
  `,
  styles: [
    `
      :host { display: block; height: 100%; }
      .artifact-frame {
        width: 100%;
        height: 100%;
        min-height: 320px;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: #fff;
      }
    `,
  ],
})
export class DocReviewViewerComponent implements OnInit, OnDestroy {
  readonly html = input.required<string>();

  readonly ready = output<DocReviewItemInfo[]>();
  readonly decisionChanged = output<DocReviewDecisionMessage>();
  readonly commentChanged = output<DocReviewCommentMessage>();

  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private readonly onMessage = (event: MessageEvent): void => this.handleMessage(event);

  constructor() {
    // Set srcdoc natively on the sandboxed (no allow-same-origin) iframe so the artifact's
    // own script runs. Going through the DOM property avoids Angular HTML-sanitising the
    // markup (which would strip the review runtime) without bypassSecurityTrustHtml or any
    // app-DOM injection — isolation comes from the sandbox, not from stripping scripts.
    // Reads the query signal, so it re-runs once the iframe is available.
    effect(() => {
      const html = this.html();
      const frame = this.frame()?.nativeElement;
      if (frame && frame.srcdoc !== html) frame.srcdoc = html;
    });
  }

  ngOnInit(): void {
    window.addEventListener('message', this.onMessage);
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onMessage);
  }

  private handleMessage(event: MessageEvent): void {
    const frameWindow = this.frame()?.nativeElement.contentWindow;
    if (!frameWindow || event.source !== frameWindow) return;
    const data = event.data as { type?: unknown };
    if (!data || typeof data.type !== 'string' || !data.type.startsWith(TYPE_PREFIX)) return;

    const ready = ReadyMessageSchema.safeParse(data);
    if (ready.success) {
      this.ready.emit(
        (ready.data.items ?? []).map((item) => ({
          id: item.id,
          title: item.title ?? item.id,
          decisionId: item.decisionId ?? null,
        })),
      );
      return;
    }
    const decision = DecisionMessageSchema.safeParse(data);
    if (decision.success) {
      this.decisionChanged.emit({ itemId: decision.data.itemId, decision: decision.data.decision });
      return;
    }
    const comment = CommentMessageSchema.safeParse(data);
    if (comment.success) {
      this.commentChanged.emit({ itemId: comment.data.itemId, comment: comment.data.comment });
    }
  }
}
