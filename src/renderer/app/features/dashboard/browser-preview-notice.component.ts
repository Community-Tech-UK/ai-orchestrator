import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-browser-preview-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="browser-preview">
      <div class="browser-preview-card">
        <p class="preview-eyebrow">Renderer preview</p>
        <h1 class="preview-title">This page is the Angular dev server, not the Electron app.</h1>
        <p class="preview-copy">
          The full orchestrator needs the Electron preload bridge for CLI detection, instance creation,
          and file/system access. If this tab opens during development, use the Electron window that
          launches alongside it.
        </p>

        <div class="preview-actions">
          <a class="preview-link" href="http://localhost:4567/?bench=1">
            Open benchmark preview
          </a>
          <span class="preview-hint">Use ?bench=1 only for renderer profiling.</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .browser-preview {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      padding: 32px;
      background: var(--bg-primary);
    }

    .browser-preview-card {
      width: min(640px, 100%);
      padding: 28px;
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: var(--bg-elevated);
      box-shadow: 0 28px 80px rgba(0, 0, 0, 0.32);
    }

    .preview-eyebrow {
      margin: 0 0 10px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
    }

    .preview-title {
      margin: 0 0 14px;
      font-size: clamp(28px, 4vw, 42px);
      line-height: 0.98;
      letter-spacing: -0.03em;
      color: var(--text-primary);
    }

    .preview-copy {
      margin: 0;
      max-width: 52ch;
      color: var(--text-secondary);
      font-size: 16px;
      line-height: 1.7;
    }

    .preview-actions {
      margin-top: 22px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .preview-link {
      width: fit-content;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(var(--primary-rgb), 0.24);
      background: rgba(var(--primary-rgb), 0.12);
      color: var(--text-primary);
      text-decoration: none;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
    }

    .preview-hint {
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.03em;
    }
  `],
})
export class BrowserPreviewNoticeComponent {}
