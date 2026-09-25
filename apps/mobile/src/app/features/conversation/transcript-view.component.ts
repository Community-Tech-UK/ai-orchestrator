import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
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
  readonly retryTranscript = output<void>();

  protected readonly renderMarkdown = renderMobileMarkdown;
  protected readonly isLoopTranscriptMessage = isLoopTranscriptMessage;
  protected readonly toolLabel = toolLabel;
  protected readonly toolDetails = toolDetails;
  protected readonly displayItems = computed<DisplayItem[]>(() => buildDisplayItems(this.messages()));
  protected readonly expandedTools = signal<Set<string>>(new Set());
  protected readonly atTop = signal(true);
  protected readonly atBottom = signal(true);
  protected readonly hasNewOutput = signal(false);

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');
  private stickToBottom = true;
  private touching = false;
  private previousMessageCount = 0;

  constructor() {
    afterRenderEffect(() => {
      const count = this.messages().length;
      void this.working();
      const grew = count > this.previousMessageCount;
      this.previousMessageCount = count;
      const element = this.scrollEl()?.nativeElement;
      if (!element) return;
      queueMicrotask(() => {
        if (!element.isConnected) return;
        if (this.stickToBottom && !this.touching) element.scrollTop = element.scrollHeight;
        else if (grew) this.hasNewOutput.set(true);
        this.updateScrollFlags();
      });
    });
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
