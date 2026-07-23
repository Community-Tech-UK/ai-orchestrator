/**
 * FileIconComponent — renders a file-type icon (VS Code's Seti glyph) for a
 * path via the `@font-face`-registered `seti` font.
 *
 * Usage: `<app-file-icon [path]="file.path" />`
 *
 * The glyph keeps its Seti per-type colour in every state (VS Code behaviour);
 * only the surrounding filename text takes a git-status tint. The base
 * `.file-icon` style (font-family, sizing) lives in the global stylesheet so a
 * single `@font-face` registration serves every consumer.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { resolveFileIcon } from './file-icon';

@Component({
  selector: 'app-file-icon',
  standalone: true,
  template: `<span class="file-icon" aria-hidden="true" [style.color]="icon().color">{{ icon().glyph }}</span>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileIconComponent {
  readonly path = input.required<string>();
  protected readonly icon = computed(() => resolveFileIcon(this.path()));
}
