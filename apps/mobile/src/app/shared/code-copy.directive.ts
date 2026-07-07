import { Directive, inject } from '@angular/core';
import { ClipboardService } from '../core/clipboard.service';
import { HapticsService } from '../core/haptics.service';

const RESET_MS = 1500;

/**
 * Click-delegation for the "Copy" chip that {@link renderMobileMarkdown} puts
 * in the header bar of every fenced code block. Attach to the transcript
 * scroll container; taps anywhere else pass through untouched.
 *
 * The chip's "Copied" state is transient DOM-only feedback — the rendered
 * markdown is cached/re-set wholesale via [innerHTML], so no component state
 * can live on the chip itself.
 */
@Directive({
  selector: '[appCodeCopy]',
  standalone: true,
  host: {
    '(click)': 'onActivate($event)',
    '(keydown.enter)': 'onActivate($event)',
  },
})
export class CodeCopyDirective {
  private readonly clipboard = inject(ClipboardService);
  private readonly haptics = inject(HapticsService);

  protected async onActivate(event: Event): Promise<void> {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const chip = target?.closest('.md-code-copy');
    if (!(chip instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const code = chip.closest('.md-code')?.querySelector('pre code')?.textContent ?? '';
    const ok = await this.clipboard.copy(code);
    if (!ok) return;
    this.haptics.tap();
    chip.textContent = 'Copied';
    chip.classList.add('copied');
    setTimeout(() => {
      // The block may have been re-rendered/removed meanwhile; guard is free.
      if (chip.isConnected) {
        chip.textContent = 'Copy';
        chip.classList.remove('copied');
      }
    }, RESET_MS);
  }
}
