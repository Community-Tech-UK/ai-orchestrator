import { signal } from '@angular/core';
import { isHeicFile, type HeicConverter } from '../../core/state/instance/instance-attachments';

/**
 * Object URLs for the composer's staged-image thumbnails.
 *
 * Only images get one; other files show as a plain file chip. Chromium cannot
 * draw HEIC photos, so a HEIC file gets its thumbnail from a JPEG converted in
 * the background, and stays a file chip until that is ready (or if it fails).
 */
export class ComposerFilePreviews {
  private readonly urls = new Map<File, string>();
  private readonly converting = new Set<File>();
  private readonly unconvertible = new Set<File>();
  /** Bumped when a conversion settles, so computeds reading `thumbnailFor` re-run. */
  private readonly settled = signal(0);
  private disposed = false;

  constructor(private readonly convertHeic: HeicConverter) {}

  thumbnailFor(file: File): string | null {
    this.settled();
    const existing = this.urls.get(file);
    if (existing) return existing;
    if (isHeicFile(file)) {
      if (!this.unconvertible.has(file) && !this.converting.has(file)) this.startConversion(file);
      return null;
    }
    if (!file.type.startsWith('image/')) return null;
    const url = URL.createObjectURL(file);
    this.urls.set(file, url);
    return url;
  }

  /** Revoke URLs for files no longer staged. */
  retainOnly(files: readonly File[]): void {
    const staged = new Set(files);
    for (const file of [...this.urls.keys(), ...this.converting, ...this.unconvertible]) {
      if (!staged.has(file)) this.release(file);
    }
  }

  release(file: File): void {
    const url = this.urls.get(file);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(file);
    this.converting.delete(file);
    this.unconvertible.delete(file);
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.converting.clear();
    this.unconvertible.clear();
  }

  private startConversion(file: File): void {
    this.converting.add(file);
    this.convertHeic(file).then(
      (jpeg) => {
        // Removed or torn down while converting: nothing would revoke a new URL. Already set: a file removed and
        // re-staged mid-conversion waits on the same conversion twice.
        if (this.disposed || !this.converting.has(file) || this.urls.has(file)) return;
        this.urls.set(file, URL.createObjectURL(jpeg));
      },
      () => {
        if (this.converting.has(file)) this.unconvertible.add(file);
      },
    ).finally(() => {
      this.converting.delete(file);
      if (!this.disposed) this.settled.update((count) => count + 1);
    });
  }
}
