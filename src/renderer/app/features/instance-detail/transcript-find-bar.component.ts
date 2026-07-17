import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'app-transcript-find-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="transcript-find-bar" role="search" aria-label="Find in transcript">
      <svg class="find-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"></circle>
        <path d="m21 21-4.3-4.3"></path>
      </svg>
      <input
        #searchInput
        class="find-input"
        type="text"
        placeholder="Find"
        [value]="query()"
        (input)="onInput($event)"
        (keydown)="onKeydown($event)"
        aria-label="Find in transcript"
      />
      <span class="find-count" [class.empty]="matchCount() === 0">
        {{ statusLabel() }}
      </span>
      <button
        type="button"
        class="find-button"
        title="Previous match"
        aria-label="Previous match"
        [disabled]="matchCount() === 0 || loadingOlder()"
        (click)="previous.emit()"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
      </button>
      <button
        type="button"
        class="find-button"
        title="Next match"
        aria-label="Next match"
        [disabled]="matchCount() === 0 || loadingOlder()"
        (click)="next.emit()"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <button
        type="button"
        class="find-button close"
        title="Close find"
        aria-label="Close find"
        (click)="closeRequested.emit()"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  `,
  styles: [`
    :host {
      position: absolute;
      top: 12px;
      right: 56px;
      z-index: 20;
      display: block;
      max-width: min(380px, calc(100% - 72px));
    }

    .transcript-find-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 280px;
      max-width: 100%;
      padding: 6px 8px;
      border: 1px solid rgba(var(--primary-rgb), 0.24);
      border-radius: 8px;
      background: rgba(12, 18, 17, 0.96);
      box-shadow: 0 14px 30px rgba(0, 0, 0, 0.28);
      color: var(--text-secondary);
    }

    .find-icon {
      flex: 0 0 auto;
      color: var(--text-muted);
    }

    .find-input {
      flex: 1 1 auto;
      min-width: 80px;
      border: none;
      outline: none;
      background: transparent;
      color: var(--text-primary);
      font: 13px var(--font-body);
      line-height: 1.3;
    }

    .find-input::placeholder {
      color: var(--text-muted);
    }

    .find-count {
      flex: 0 0 auto;
      min-width: 48px;
      color: var(--text-secondary);
      font: 11px var(--font-mono);
      text-align: right;
      white-space: nowrap;
    }

    .find-count.empty {
      color: var(--text-muted);
    }

    .find-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      transition: background var(--transition-fast), color var(--transition-fast);
    }

    .find-button:hover:not(:disabled) {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .find-button:disabled {
      cursor: not-allowed;
      opacity: 0.35;
    }

    .find-button.close:hover {
      color: var(--error-color);
    }
  `],
})
export class TranscriptFindBarComponent implements AfterViewInit {
  readonly query = input('');
  readonly matchCount = input(0);
  readonly activeIndex = input(-1);
  readonly loadingOlder = input(false);

  readonly queryChange = output<string>();
  readonly previous = output<void>();
  readonly next = output<void>();
  readonly closeRequested = output<void>();

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  protected readonly statusLabel = computed(() => {
    if (this.loadingOlder()) {
      return 'Loading...';
    }
    if (!this.query().trim()) {
      return '';
    }
    if (this.matchCount() === 0) {
      return '0/0';
    }
    return `${this.activeIndex() + 1}/${this.matchCount()}`;
  });

  ngAfterViewInit(): void {
    setTimeout(() => {
      const input = this.searchInput()?.nativeElement;
      input?.focus();
      input?.select();
    });
  }

  protected onInput(event: Event): void {
    this.queryChange.emit((event.target as HTMLInputElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeRequested.emit();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        this.previous.emit();
      } else {
        this.next.emit();
      }
    }
  }
}
