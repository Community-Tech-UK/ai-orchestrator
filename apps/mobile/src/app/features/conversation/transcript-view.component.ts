import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { MobileLoadState } from '../../core/gateway-request-state';
import type { MobileMessageDto } from '../../core/models';
import { CodeCopyDirective } from '../../shared/code-copy.directive';
import { CopyButtonComponent } from '../../shared/copy-button.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { renderMobileMarkdown } from '../../shared/mobile-markdown';
import {
  buildDisplayItems,
  isLoopTranscriptMessage,
  toolDetails,
  toolLabel,
  type DisplayItem,
} from '../../shared/transcript-items';

interface TranscriptAnchor {
  candidates: { element: HTMLElement; top: number }[];
  count: number;
  messages: MobileMessageDto[];
  scrollTop: number;
  scrollHeight: number;
}

@Component({
  standalone: true,
  selector: 'app-transcript-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeCopyDirective, CopyButtonComponent, MobileIconComponent],
  templateUrl: './transcript-view.component.html',
  styleUrls: ['./transcript-view.component.scss'],
})
export class TranscriptViewComponent {
  readonly messages = input.required<MobileMessageDto[]>();
  readonly state = input.required<MobileLoadState>();
  readonly emptyText = input.required<string>();
  readonly working = input(false);
  readonly transcriptKey = input('');
  readonly hasEarlier = input(false);
  readonly earlierLoading = input(false);
  readonly earlierError = input<string | null>(null);
  readonly earlierDisabled = input(false);
  readonly loadEarlier = output<void>();
  readonly retryTranscript = output<void>();

  protected readonly isLoopTranscriptMessage = isLoopTranscriptMessage;
  protected readonly toolLabel = toolLabel;
  protected readonly toolDetails = toolDetails;
  private readonly markdown = new Map<string, { content: string; html: string }>();
  private markdownKey = '';
  private readonly visibleCount = linkedSignal({ source: this.transcriptKey, computation: () => 150 });
  private readonly allItems = computed(() => buildDisplayItems(this.messages()));
  protected readonly canShowEarlier = computed(() => this.hasEarlier() || this.allItems().length > this.visibleCount());
  protected readonly cannotShowEarlier = computed(() => this.earlierLoading() ||
    (this.earlierDisabled() && this.allItems().length <= this.visibleCount()));
  protected readonly displayItems = computed(() => {
    const key = this.transcriptKey();
    if (key !== this.markdownKey || !this.messages().length) {
      this.markdown.clear();
      this.markdownKey = key;
    }
    // Cache the exact content as its fingerprint: no hash collisions or global eviction.
    return this.allItems().slice(-this.visibleCount()).map(item => {
      if (item.kind !== 'msg') return item;
      const { id, content } = item.message;
      let cached = this.markdown.get(id);
      if (!cached || cached.content !== content) {
        cached = { content, html: renderMobileMarkdown(content) };
        this.markdown.set(id, cached);
      }
      return { ...item, html: cached.html };
    });
  });
  protected readonly expandedTools = signal<Set<string>>(new Set());
  protected readonly atTop = signal(true);
  protected readonly atBottom = signal(true);
  protected readonly hasNewOutput = signal(false);

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');
  private stickToBottom = true;
  private touching = false;
  private previousMessageCount = 0;
  private renderedKey: string | null = null;
  private anchor: TranscriptAnchor | null = null;

  constructor() {
    afterRenderEffect(() => {
      const key = this.transcriptKey();
      if (key !== this.renderedKey) {
        this.renderedKey = key;
        this.anchor = null;
        this.stickToBottom = true;
        this.touching = false;
        this.previousMessageCount = 0;
        this.expandedTools.set(new Set());
        this.hasNewOutput.set(false);
      }
      const messages = this.messages();
      const count = messages.length;
      const displayed = this.displayItems().length;
      const loadingEarlier = this.earlierLoading();
      const earlierFinished = !this.hasEarlier() || Boolean(this.earlierError());
      void this.working();
      const grew = count > this.previousMessageCount;
      this.previousMessageCount = count;
      const element = this.scrollEl()?.nativeElement;
      if (!element) return;
      queueMicrotask(() => {
        if (!element.isConnected) return;
        if (this.anchor && !loadingEarlier && (displayed !== this.anchor.count ||
            messages !== this.anchor.messages || earlierFinished)) {
          this.restoreAnchor(element, this.anchor);
        } else if (!this.anchor && this.stickToBottom && !this.touching) element.scrollTop = element.scrollHeight;
        else if (grew) this.hasNewOutput.set(true);
        this.updateScrollFlags();
      });
    });
  }

  protected showEarlier(): void {
    if (this.cannotShowEarlier()) return;
    const scroll = this.scrollEl()?.nativeElement;
    const top = scroll?.getBoundingClientRect().top ?? 0;
    if (scroll) {
      const items = Array.from(scroll.querySelectorAll<HTMLElement>('[data-transcript-item]'));
      const first = items.findIndex(item => item.getBoundingClientRect().bottom > top);
      this.anchor = {
        // Stamps and activity groups can disappear when adjacent pages merge.
        // Keep following items too, so the first surviving message stays put.
        candidates: first < 0 ? [] : items.slice(first).map(element => ({ element, top: element.getBoundingClientRect().top })),
        count: this.displayItems().length, messages: this.messages(),
        scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight,
      };
    }
    this.stickToBottom = false;
    const needsPage = !this.earlierDisabled() && this.hasEarlier() && this.allItems().length - this.visibleCount() < 150;
    if (!this.earlierError()) this.visibleCount.update(count => count + 150);
    if (needsPage) this.loadEarlier.emit();
  }

  protected trackItem(item: DisplayItem): string {
    return item.kind === 'msg' ? item.message.id : item.id;
  }

  protected toggleTools(id: string): void {
    this.expandedTools.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected toolGroupLabel(item: Extract<DisplayItem, { kind: 'tools' }>): string {
    return `Show ${item.items.length} activity ${item.items.length === 1 ? 'entry' : 'entries'}`;
  }

  protected onScroll(): void { this.updateScrollFlags(); }

  protected onTouchStart(): void {
    this.anchor = null;
    this.touching = true;
    this.stickToBottom = false;
  }

  protected onTouchEnd(): void {
    this.touching = false;
    this.updateScrollFlags();
  }

  protected scrollToTop(): void {
    this.scrollEl()?.nativeElement.scrollTo({ top: 0, behavior: 'smooth' });
  }

  protected scrollToBottom(): void {
    const element = this.scrollEl()?.nativeElement;
    if (!element) return;
    this.stickToBottom = true;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }

  private restoreAnchor(scroll: HTMLElement, anchor: TranscriptAnchor, remaining = 4): void {
    if (this.anchor !== anchor) return;
    const candidate = anchor.candidates.find(item => scroll.contains(item.element));
    if (!candidate || !scroll.isConnected) {
      // A page made entirely of one merged activity group can rekey every
      // displayed item without changing the item count. Preserve its extent,
      // then release the anchor so later output can follow the bottom again.
      scroll.scrollTop = anchor.scrollTop + scroll.scrollHeight - anchor.scrollHeight;
      this.anchor = null;
      this.updateScrollFlags();
      return;
    }
    scroll.scrollTop += candidate.element.getBoundingClientRect().top - candidate.top;
    // Scrolling realises content-visibility blocks whose intrinsic estimates
    // differ from their measured height. Re-anchor after that layout settles.
    if (remaining > 0) {
      requestAnimationFrame(() => this.restoreAnchor(scroll, anchor, remaining - 1));
    } else {
      this.anchor = null;
      this.updateScrollFlags();
    }
  }

  private updateScrollFlags(): void {
    const element = this.scrollEl()?.nativeElement;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    this.atBottom.set(atBottom);
    this.atTop.set(element.scrollTop < 40);
    this.stickToBottom = atBottom;
    if (atBottom) this.hasNewOutput.set(false);
  }
}
