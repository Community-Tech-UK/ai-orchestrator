import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

// Render the actual attachment section, with a small presentation context, so
// this regression follows production bindings rather than a copied template.
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'input-panel.component.html'), 'utf8');
const template = source.slice(source.indexOf('<!-- Pending files and folders preview -->'), source.indexOf('<app-image-lightbox'));
const filename = 'a-long-attachment-filename-that-is-shortened-in-the-preview.png';
@Component({ standalone: true, changeDetection: ChangeDetectionStrategy.OnPush, imports: [AioTooltipDirective], template })
class PreviewHost {
  readonly copy = copyFor;
  readonly pendingFolders = () => [];
  readonly pendingFilePreviews = () => [{ file: new File(['image'], filename), isImage: true, previewUrl: '', size: '5 B' }];
  readonly getFolderDisplayName = (folder: string) => folder;
  readonly openLightbox = vi.fn();
  readonly onRemoveFile = vi.fn();
  readonly onRemoveFolder = vi.fn();
}
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });

describe('attachment filename overflow hints', () => {
  it('opens the full name when the filename is clipped inside an otherwise fitting preview box', () => {
    const fixture = TestBed.createComponent(PreviewHost); fixture.detectChanges();
    const label = fixture.nativeElement.querySelector('.file-preview-card .file-name') as HTMLElement;
    const button = label.closest('button')!;
    // jsdom has no layout. Model the existing CSS: the filename has ellipsis,
    // while the surrounding flex column fits its clipped child and the size.
    if (button !== label) {
      Object.defineProperties(button, { clientWidth: { value: 120 }, scrollWidth: { value: 120 } });
    }
    Object.defineProperties(label, { clientWidth: { value: 120 }, scrollWidth: { value: 450 } });
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    button.focus(); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(filename);
    button.click(); expect(fixture.componentInstance.openLightbox).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.onRemoveFile).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
