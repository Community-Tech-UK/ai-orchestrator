/**
 * Export Panel Component
 *
 * Modal for exporting verification results:
 * - Multiple format options (Markdown, JSON, HTML, PDF)
 * - Configurable content inclusion
 * - Preview before export
 * - Download or copy to clipboard
 */

import {
  Component,
  Input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CLIPBOARD_SERVICE } from '../../../core/services/clipboard.service';

export type ExportFormat = 'markdown' | 'json' | 'html' | 'pdf';

interface ExportOptions {
  includeSynthesis: boolean;
  includeComparison: boolean;
  includeDebateRounds: boolean;
  includeRawResponses: boolean;
  includeMetadata: boolean;
  includeHeatmap: boolean;
}

interface VerificationResultInput {
  id: string;
  prompt: string;
  synthesizedResponse?: string;
  synthesisConfidence?: number;
  synthesisMethod?: string;
  completedAt?: Date;
  responses?: {
    agentId: string;
    model: string;
    personality?: string;
    response: string;
    confidence?: number;
    tokens?: number;
    cost?: number;
  }[];
  debateRounds?: {
    round: number;
    type: string;
    exchanges: {
      agent: string;
      target?: string;
      content: string;
    }[];
  }[];
  consensusMatrix?: number[][];
  totalCost?: number;
  totalTokens?: number;
  duration?: number;
}

@Component({
  selector: 'app-export-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      (click)="closePanel.emit()"
      (keydown.escape)="closePanel.emit()"
    >
      <div class="export-modal" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()" tabindex="-1">
        <header class="modal-header">
          <h2 id="export-modal-title">Export Verification Results</h2>
          <button class="close-btn" (click)="closePanel.emit()" aria-label="Close export panel">✕</button>
        </header>

        <div class="modal-body">
          <!-- Format Selection -->
          <section class="export-section">
            <h3>Export Format</h3>
            <div class="format-grid">
              @for (format of formats; track format.id) {
                <button
                  class="format-card"
                  [class.selected]="selectedFormat() === format.id"
                  (click)="selectedFormat.set(format.id)"
                >
                  <span class="format-icon">{{ format.icon }}</span>
                  <span class="format-name">{{ format.name }}</span>
                  <span class="format-ext">.{{ format.extension }}</span>
                </button>
              }
            </div>
          </section>

          <!-- Content Options -->
          <section class="export-section">
            <h3>Include Content</h3>
            <div class="options-list">
              <label class="option-item">
                <input type="checkbox" [(ngModel)]="options.includeSynthesis" />
                <div class="option-info">
                  <span class="option-label">Synthesized Response</span>
                  <span class="option-hint">Final merged/debated result</span>
                </div>
              </label>

              <label class="option-item">
                <input type="checkbox" [(ngModel)]="options.includeComparison" />
                <div class="option-info">
                  <span class="option-label">Agent Comparison</span>
                  <span class="option-hint">Side-by-side response comparison</span>
                </div>
              </label>

              <label class="option-item">
                <input type="checkbox" [(ngModel)]="options.includeDebateRounds" />
                <div class="option-info">
                  <span class="option-label">Debate Rounds</span>
                  <span class="option-hint">Full debate history if applicable</span>
                </div>
              </label>

              <label class="option-item">
                <input type="checkbox" [(ngModel)]="options.includeRawResponses" />
                <div class="option-info">
                  <span class="option-label">Raw Agent Responses</span>
                  <span class="option-hint">Complete unedited outputs</span>
                </div>
              </label>

              <label class="option-item">
                <input type="checkbox" [(ngModel)]="options.includeHeatmap" />
                <div class="option-info">
                  <span class="option-label">Consensus Heatmap</span>
                  <span class="option-hint">Agreement matrix between agents</span>
                </div>
              </label>

              <label class="option-item">
                <input type="checkbox" [(ngModel)]="options.includeMetadata" />
                <div class="option-info">
                  <span class="option-label">Session Metadata</span>
                  <span class="option-hint">Timing, tokens, cost breakdown</span>
                </div>
              </label>
            </div>
          </section>

          <!-- Preview -->
          <section class="export-section preview-section">
            <div class="preview-header">
              <h3>Preview</h3>
              <span class="preview-size">~{{ estimatedSize() }}</span>
            </div>
            <div class="preview-content">
              <pre>{{ preview() }}</pre>
            </div>
          </section>
        </div>

        <footer class="modal-footer">
          <div class="footer-left">
            <button class="btn-secondary" (click)="copyToClipboard()">
              {{ copied() ? '✓ Copied!' : '📋 Copy to Clipboard' }}
            </button>
          </div>
          <div class="footer-right">
            <button class="btn-secondary" (click)="closePanel.emit()">Cancel</button>
            <button
              class="btn-primary"
              (click)="exportFile()"
              [disabled]="isExporting()"
            >
              {{ isExporting() ? 'Exporting...' : '⬇️ Download ' + selectedFormatInfo()?.extension?.toUpperCase() }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .export-modal {
      width: 600px;
      max-width: 90vw;
      max-height: 90vh;
      background: var(--bg-primary);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      animation: slideIn 0.2s ease;
    }

    @keyframes slideIn {
      from { transform: translateY(-20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-color);
    }

    .modal-header h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: var(--text-secondary);
      padding: 4px 8px;
      border-radius: 4px;
    }

    .close-btn:hover {
      background: var(--bg-tertiary);
    }

    .modal-body {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    .export-section {
      margin-bottom: 24px;
    }

    .export-section:last-child {
      margin-bottom: 0;
    }

    .export-section h3 {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .format-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }

    .format-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 16px 12px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      background: var(--bg-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }

    .format-card:hover {
      border-color: var(--accent-color);
      background: var(--bg-hover);
    }

    .format-card.selected {
      border-color: var(--accent-color);
      background: rgba(59, 130, 246, 0.1);
    }

    .format-icon {
      font-size: 24px;
    }

    .format-name {
      font-size: 13px;
      font-weight: 500;
    }

    .format-ext {
      font-size: 11px;
      color: var(--text-muted);
    }

    .options-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .option-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .option-item:hover {
      background: var(--bg-secondary);
    }

    .option-item input {
      margin-top: 2px;
      width: 16px;
      height: 16px;
    }

    .option-info {
      display: flex;
      flex-direction: column;
    }

    .option-label {
      font-size: 13px;
      font-weight: 500;
    }

    .option-hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    .preview-section {
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    .preview-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .preview-header h3 {
      margin: 0;
    }

    .preview-size {
      font-size: 12px;
      color: var(--text-muted);
    }

    .preview-content {
      flex: 1;
      max-height: 200px;
      overflow: auto;
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }

    .preview-content pre {
      margin: 0;
      font-size: 12px;
      font-family: 'Monaco', 'Menlo', monospace;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-secondary);
    }

    .modal-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .footer-left,
    .footer-right {
      display: flex;
      gap: 8px;
    }

    /* Buttons */
    .btn-primary {
      padding: 10px 20px;
      background: var(--accent-color);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }

    .btn-primary:hover {
      opacity: 0.9;
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-secondary {
      padding: 10px 16px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }

    .btn-secondary:hover {
      background: var(--bg-hover);
    }
  `],
})
export class ExportPanelComponent {
  private clipboard = inject(CLIPBOARD_SERVICE);

  // Use traditional @Input for better test compatibility
  private _result = signal<VerificationResultInput>({ id: '', prompt: '' });

  @Input()
  set result(value: VerificationResultInput) {
    this._result.set(value);
  }
  get result(): VerificationResultInput {
    return this._result();
  }

  // Internal signal accessor for computed properties
  resultSignal = this._result.asReadonly();

  closePanel = output<void>();
  exportComplete = output<{ format: ExportFormat; content: string }>();

  // Formats
  formats = [
    { id: 'markdown' as ExportFormat, name: 'Markdown', extension: 'md', icon: '📝' },
    { id: 'json' as ExportFormat, name: 'JSON', extension: 'json', icon: '📦' },
    { id: 'html' as ExportFormat, name: 'HTML', extension: 'html', icon: '🌐' },
    { id: 'pdf' as ExportFormat, name: 'PDF', extension: 'pdf', icon: '📄' },
  ];

  // State
  selectedFormat = signal<ExportFormat>('markdown');
  isExporting = signal(false);
  copied = signal(false);

  // Options
  options: ExportOptions = {
    includeSynthesis: true,
    includeComparison: true,
    includeDebateRounds: true,
    includeRawResponses: false,
    includeMetadata: true,
    includeHeatmap: true,
  };

  // Computed
  selectedFormatInfo = computed(() =>
    this.formats.find(f => f.id === this.selectedFormat())
  );

  preview = computed(() => {
    const content = this.generateExport();
    // Truncate for preview
    if (content.length > 1000) {
      return content.substring(0, 1000) + '\n\n... (truncated)';
    }
    return content;
  });

  estimatedSize = computed(() => {
    const content = this.generateExport();
    const bytes = new Blob([content]).size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  });

  generateExport(): string {
    const format = this.selectedFormat();
    const r = this._result();

    switch (format) {
      case 'json':
        return this.generateJson(r);
      case 'markdown':
        return this.generateMarkdown(r);
      case 'html':
        return this.generateHtml(r);
      case 'pdf':
        // PDF uses same content as markdown, converted server-side
        return this.generateMarkdown(r);
      default:
        return '';
    }
  }

  private generateJson(r: VerificationResultInput): string {
    const output: Record<string, unknown> = {};

    if (this.options.includeMetadata) {
      output['metadata'] = {
        id: r.id,
        prompt: r.prompt,
        completedAt: r.completedAt,
        duration: r.duration,
        totalTokens: r.totalTokens,
        totalCost: r.totalCost,
      };
    }

    if (this.options.includeSynthesis) {
      output['synthesis'] = {
        response: r.synthesizedResponse,
        confidence: r.synthesisConfidence,
        method: r.synthesisMethod,
      };
    }

    if (this.options.includeComparison && r.responses) {
      output['agentResponses'] = r.responses.map(resp => ({
        agentId: resp.agentId,
        model: resp.model,
        personality: resp.personality,
        response: resp.response,
        confidence: resp.confidence,
        tokens: resp.tokens,
        cost: resp.cost,
      }));
    }

    if (this.options.includeDebateRounds && r.debateRounds) {
      output['debateRounds'] = r.debateRounds;
    }

    if (this.options.includeHeatmap && r.consensusMatrix) {
      output['consensusMatrix'] = r.consensusMatrix;
    }

    if (this.options.includeRawResponses && r.responses) {
      output['rawResponses'] = r.responses.map(resp => ({
        agent: resp.model,
        fullResponse: resp.response,
      }));
    }

    return JSON.stringify(output, null, 2);
  }

  private generateMarkdown(r: VerificationResultInput): string {
    let md = `# Multi-Agent Verification Results\n\n`;

    if (this.options.includeMetadata) {
      md += `## Session Information\n\n`;
      md += `- **Prompt:** ${r.prompt}\n`;
      md += `- **Completed:** ${r.completedAt ? new Date(r.completedAt).toLocaleString() : 'N/A'}\n`;
      if (r.duration) {
        md += `- **Duration:** ${Math.round(r.duration / 1000)}s\n`;
      }
      if (r.totalTokens) {
        md += `- **Total Tokens:** ${r.totalTokens.toLocaleString()}\n`;
      }
      if (r.totalCost) {
        md += `- **Total Cost:** $${r.totalCost.toFixed(4)}\n`;
      }
      md += `\n---\n\n`;
    }

    if (this.options.includeSynthesis && r.synthesizedResponse) {
      md += `## Synthesized Response\n\n`;
      md += `**Method:** ${r.synthesisMethod || 'N/A'}  \n`;
      md += `**Confidence:** ${r.synthesisConfidence ? Math.round(r.synthesisConfidence * 100) : 'N/A'}%\n\n`;
      md += `${r.synthesizedResponse}\n\n`;
      md += `---\n\n`;
    }

    if (this.options.includeComparison && r.responses?.length) {
      md += `## Agent Responses\n\n`;
      for (const resp of r.responses) {
        md += `### ${resp.model}${resp.personality ? ` (${resp.personality})` : ''}\n\n`;
        if (resp.confidence) {
          md += `**Confidence:** ${Math.round(resp.confidence * 100)}%\n\n`;
        }
        md += `${resp.response}\n\n`;
      }
      md += `---\n\n`;
    }

    if (this.options.includeDebateRounds && r.debateRounds?.length) {
      md += `## Debate Rounds\n\n`;
      for (const round of r.debateRounds) {
        md += `### Round ${round.round}: ${round.type}\n\n`;
        for (const exchange of round.exchanges) {
          md += `**${exchange.agent}**`;
          if (exchange.target) {
            md += ` → ${exchange.target}`;
          }
          md += `:\n\n${exchange.content}\n\n`;
        }
      }
      md += `---\n\n`;
    }

    if (this.options.includeHeatmap && r.consensusMatrix && r.responses) {
      md += `## Consensus Matrix\n\n`;
      const agents = r.responses.map(resp => resp.model);
      md += `| | ${agents.join(' | ')} |\n`;
      md += `|${agents.map(() => '---').join('|')}|${agents.map(() => '---').join('|')}|\n`;
      for (let i = 0; i < r.consensusMatrix.length; i++) {
        md += `| ${agents[i]} | ${r.consensusMatrix[i].map(v => `${Math.round(v * 100)}%`).join(' | ')} |\n`;
      }
      md += `\n`;
    }

    md += `---\n\n*Generated by AI Orchestrator*\n`;

    return md;
  }

  private generateHtml(r: VerificationResultInput): string {
    const md = this.generateMarkdown(r);

    // Simple markdown to HTML conversion
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Results - ${r.id}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      line-height: 1.6;
      color: #333;
    }
    h1 { color: #1a1a1a; border-bottom: 2px solid #3b82f6; padding-bottom: 10px; }
    h2 { color: #374151; margin-top: 30px; }
    h3 { color: #4b5563; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 30px 0; }
    pre { background: #f3f4f6; padding: 15px; border-radius: 6px; overflow-x: auto; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 3px; }
    table { border-collapse: collapse; width: 100%; margin: 15px 0; }
    th, td { border: 1px solid #e5e7eb; padding: 10px; text-align: left; }
    th { background: #f9fafb; }
    blockquote { border-left: 4px solid #3b82f6; margin: 0; padding-left: 20px; color: #6b7280; }
    .confidence { display: inline-block; padding: 2px 8px; background: #ecfdf5; color: #059669; border-radius: 4px; }
    .meta { color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
`;

    // Convert markdown to HTML (simple conversion)
    html += md
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^\*\*(.*)\*\*:?\s*(.*)$/gim, '<p><strong>$1</strong> $2</p>')
      .replace(/^- (.*$)/gim, '<li>$1</li>')
      .replace(/^---$/gim, '<hr>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^\|.*\|$/gim, (match) => {
        const cells = match.split('|').filter(c => c.trim());
        if (cells.every(c => c.trim() === '---')) {
          return '';
        }
        const isHeader = cells.some(c => c.includes('**'));
        const tag = isHeader ? 'th' : 'td';
        const row = cells.map(c => `<${tag}>${c.trim().replace(/\*\*/g, '')}</${tag}>`).join('');
        return `<tr>${row}</tr>`;
      });

    html += `
</body>
</html>`;

    return html;
  }

  async copyToClipboard(): Promise<void> {
    const content = this.generateExport();
    const result = await this.clipboard.copyText(content, { label: 'export' });
    if (result.ok) {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } else {
      console.error('Failed to copy export:', result.reason, result.cause);
    }
  }

  async exportFile(): Promise<void> {
    this.isExporting.set(true);

    try {
      const content = this.generateExport();
      const format = this.selectedFormat();
      const formatInfo = this.selectedFormatInfo();

      if (format === 'pdf') {
        // PDF requires server-side conversion
        interface ElectronAPI {
          invoke: (channel: string, data: { content: string; filename: string }) => Promise<void>;
        }
        await ((window as unknown as { electronAPI?: ElectronAPI }).electronAPI)?.invoke('export:pdf', {
          content,
          filename: `verification-${this._result().id}.pdf`,
        });
      } else {
        // Direct file download
        const blob = new Blob([content], {
          type: format === 'json' ? 'application/json'
            : format === 'html' ? 'text/html'
            : 'text/plain',
        });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `verification-${this._result().id}.${formatInfo?.extension || 'txt'}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      this.exportComplete.emit({ format, content });
      this.closePanel.emit();
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      this.isExporting.set(false);
    }
  }
}
