import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, inject, output } from '@angular/core';

const activeBackdrops = new WeakMap<Document, BackdropEscapeDirective[]>();

/** Mounted only while its overlay is open; Escape dismisses the latest overlay. */
@Directive({ selector: '[appBackdropEscape]', standalone: true })
export class BackdropEscapeDirective {
  readonly dismiss = output<void>({ alias: 'appBackdropEscape' });

  constructor() {
    const document = inject(DOCUMENT);
    const stack = activeBackdrops.get(document) ?? [];
    activeBackdrops.set(document, stack);
    stack.push(this);
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || stack.at(-1) !== this) return;
      // Capture precedes the document's global Escape-to-stop keybinding.
      event.preventDefault();
      event.stopImmediatePropagation();
      this.dismiss.emit();
    };
    document.addEventListener('keydown', escape, true);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('keydown', escape, true);
      stack.splice(stack.indexOf(this), 1);
      if (stack.length === 0) activeBackdrops.delete(document);
    });
  }
}
