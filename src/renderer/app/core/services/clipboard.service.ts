import {
  Injectable,
  InjectionToken,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { ElectronIpcService } from './ipc/electron-ipc.service';
import { CLIPBOARD_TOAST } from './clipboard-toast.token';
import {
  blobToClipboardCompatibleDataUrl,
  dataUrlToClipboardCompatibleDataUrl,
} from './clipboard-image.util';

export type ClipboardCopyResult =
  | { ok: true }
  | { ok: false; reason: ClipboardCopyFailureReason; cause?: unknown };

export type ClipboardCopyFailureReason =
  | 'unavailable'
  | 'permission-denied'
  | 'unknown';

export interface ClipboardCopyOptions {
  label?: string;
  silent?: boolean;
  jsonIndent?: number;
}

/** Image attachment shape consumed by `ClipboardService.copyMessage`. */
export interface ClipboardMessageImage {
  /** A `data:image/...` URL. Non-PNG/JPEG sources are re-encoded to PNG. */
  dataUrl: string;
  /** Optional original filename, used as the `<img alt>` in HTML. */
  name?: string;
}

export interface ClipboardMessagePayload {
  /** Plain-text body of the message. */
  text: string;
  /** Image attachments to include alongside the text. */
  images?: ClipboardMessageImage[];
}

export interface ClipboardService {
  readonly lastResult: Signal<ClipboardCopyResult | null>;

  copyText(text: string, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
  copyJSON(value: unknown, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
  copyImage(blob: Blob, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
  copyMessage(
    payload: ClipboardMessagePayload,
    opts?: ClipboardCopyOptions,
  ): Promise<ClipboardCopyResult>;
}

export const CLIPBOARD_SERVICE = new InjectionToken<ClipboardService>('CLIPBOARD_SERVICE', {
  providedIn: 'root',
  factory: () => inject(ClipboardServiceImpl),
});

@Injectable({ providedIn: 'root' })
export class ClipboardServiceImpl implements ClipboardService {
  private readonly toast = inject(CLIPBOARD_TOAST, { optional: true });
  private readonly ipc = inject(ElectronIpcService, { optional: true });
  private readonly _lastResult = signal<ClipboardCopyResult | null>(null);
  readonly lastResult = this._lastResult.asReadonly();

  async copyText(text: string, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
    const label = opts.label ?? 'text';
    if (!text) {
      return this.finish({ ok: true }, label, opts);
    }

    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return this.finish({ ok: false, reason: 'unavailable' }, label, opts);
    }

    try {
      await navigator.clipboard.writeText(text);
      return this.finish({ ok: true }, label, opts);
    } catch (cause) {
      const reason: ClipboardCopyFailureReason =
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? 'permission-denied'
          : 'unknown';
      return this.finish({ ok: false, reason, cause }, label, opts);
    }
  }

  async copyJSON(value: unknown, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
    const label = opts.label ?? 'JSON';
    let text: string;
    try {
      text = JSON.stringify(value, null, opts.jsonIndent ?? 2);
    } catch (cause) {
      return this.finish({ ok: false, reason: 'unknown', cause }, label, opts);
    }

    return this.copyText(text, { ...opts, label });
  }

  async copyImage(blob: Blob, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
    const label = opts.label ?? 'image';
    if (!this.ipc?.invoke) {
      return this.finish({ ok: false, reason: 'unavailable' }, label, opts);
    }

    const dataUrl = await blobToClipboardCompatibleDataUrl(blob);
    if (!dataUrl) {
      return this.finish(
        { ok: false, reason: 'unknown', cause: new Error('Failed to encode image') },
        label,
        opts,
      );
    }

    const response = await this.ipc.invoke('image:copy-to-clipboard', { dataUrl });
    if (response.success) {
      return this.finish({ ok: true }, label, opts);
    }

    return this.finish(
      { ok: false, reason: 'unknown', cause: response.error ?? new Error('IPC failed') },
      label,
      opts,
    );
  }

  /**
   * Copy a chat message — its text plus any image attachments — to the
   * system clipboard as a single multi-format entry.
   *
   * Behaviour by paste target:
   * - **Plain-text** (terminal, code editor): pastes `payload.text`.
   * - **Rich-text / HTML** (Slack, email, Word, Notes): pastes the text
   *   followed by inline `<img>` tags for every attachment. Images survive
   *   the paste because the data URLs are embedded directly.
   * - **Image-only** (Photoshop, Preview, image-paste boxes): pastes the
   *   first attachment as a native image. Subsequent images are only
   *   reachable via the HTML representation.
   *
   * If the message has no images, this falls back to plain `copyText` so
   * we don't require Electron IPC for text-only copies.
   */
  async copyMessage(
    payload: ClipboardMessagePayload,
    opts: ClipboardCopyOptions = {},
  ): Promise<ClipboardCopyResult> {
    const label = opts.label ?? 'message';
    const images = (payload.images ?? []).filter((img) =>
      img.dataUrl.startsWith('data:image/'),
    );

    // No images → preserve the existing text-only path so this method is
    // a strict superset of copyText (and works in non-Electron contexts).
    if (images.length === 0) {
      return this.copyText(payload.text, { ...opts, label });
    }

    if (!this.ipc?.invoke) {
      return this.finish({ ok: false, reason: 'unavailable' }, label, opts);
    }

    // Convert the first image to a clipboard-compatible (PNG/JPEG) data
    // URL — Electron's nativeImage.createFromDataURL only accepts those.
    // The HTML representation can keep the original encoding because
    // browsers and rich-text apps render WebP/GIF/etc. directly.
    let firstImageDataUrl: string | undefined;
    try {
      const compat = await dataUrlToClipboardCompatibleDataUrl(images[0].dataUrl);
      firstImageDataUrl = compat ?? undefined;
    } catch {
      firstImageDataUrl = undefined;
    }

    const html = this.buildMessageHtml(payload.text, images);
    const response = await this.ipc.invoke('image:copy-message', {
      text: payload.text,
      html,
      imageDataUrl: firstImageDataUrl,
    });

    if (response.success) {
      return this.finish({ ok: true }, label, opts);
    }

    return this.finish(
      { ok: false, reason: 'unknown', cause: response.error ?? new Error('IPC failed') },
      label,
      opts,
    );
  }

  /**
   * Build the HTML representation for `copyMessage`: text rendered as
   * paragraphs (with `<br>` for line breaks) followed by one `<img>` per
   * attachment. Plain — no styling — so paste targets can apply their own.
   */
  private buildMessageHtml(text: string, images: ClipboardMessageImage[]): string {
    const escape = (s: string): string =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const textHtml = text
      ? `<p>${escape(text).replace(/\r?\n/g, '<br/>')}</p>`
      : '';

    const imgsHtml = images
      .map((img) => {
        const alt = img.name ? escape(img.name) : '';
        // src is a data: URL — already self-contained, no escaping needed
        // beyond what the browser tolerates inside an attribute.
        return `<img src="${img.dataUrl}" alt="${alt}" />`;
      })
      .join('');

    return `${textHtml}${imgsHtml}`;
  }

  private finish(
    result: ClipboardCopyResult,
    label: string,
    opts: ClipboardCopyOptions,
  ): ClipboardCopyResult {
    this._lastResult.set(result);
    if (this.toast && !opts.silent) {
      if (result.ok) {
        this.toast.success(label);
      } else {
        this.toast.error(`Failed to copy ${label}: ${result.reason}`);
      }
    }
    return result;
  }
}
