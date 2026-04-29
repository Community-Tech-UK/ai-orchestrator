import {
  Injectable,
  InjectionToken,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { ElectronIpcService } from './ipc/electron-ipc.service';
import { CLIPBOARD_TOAST } from './clipboard-toast.token';
import { blobToClipboardCompatibleDataUrl } from './clipboard-image.util';

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

export interface ClipboardService {
  readonly lastResult: Signal<ClipboardCopyResult | null>;

  copyText(text: string, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
  copyJSON(value: unknown, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
  copyImage(blob: Blob, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
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
