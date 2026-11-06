import { Pipe, inject, type PipeTransform } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';

/**
 * Marks a registry icon as safe for `[innerHTML]` on an `<svg>`. The HTML sanitizer strips SVG shapes,
 * so without this every icon renders empty. Use only for the constants in `control-surface-icons.ts`.
 */
@Pipe({ name: 'controlSurfaceIcon', standalone: true })
export class ControlSurfaceIconPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(icon: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(icon);
  }
}
