/**
 * Debate Export Service
 *
 * Export debate data and reports:
 * - HTML report generation
 * - JSON export for analysis
 * - Markdown export with structured headers
 * - PDF report generation
 */

import { Injectable } from '@angular/core';
import type { DebateResult, DebateSessionRound, DebateContribution } from '../../../../../shared/types/debate.types';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveAs } from 'file-saver';

@Injectable({
  providedIn: 'root',
})
export class DebateExportService {
  /**
   * Export debate result as HTML
   */
  exportAsHTML(debate: DebateResult): void {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Debate Report: ${this.escapeHtml(debate.query.substring(0, 50))}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem;
      background: #1a1a1a;
      color: #e5e5e5;
    }
    h1 { color: #6366f1; border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
    h2 { color: #888; margin-top: 2rem; }
    h3 { color: #aaa; }
    .query { background: #222; padding: 1rem; border-radius: 8px; margin: 1rem 0; }
    .synthesis { background: #1a2f1a; border-left: 4px solid #10b981; padding: 1rem; margin: 1rem 0; }
    .round { background: #222; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
    .contribution { background: #2a2a2a; border-radius: 4px; padding: 0.75rem; margin: 0.5rem 0; }
    .agent-badge { background: #6366f1; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1rem 0; }
    .stat { background: #222; padding: 1rem; border-radius: 8px; text-align: center; }
    .stat-value { font-size: 1.5rem; font-weight: bold; color: #6366f1; }
    .stat-label { font-size: 0.8rem; color: #888; }
    .agreements { color: #10b981; }
    .disagreements { color: #f59e0b; }
    .meta { color: #666; font-size: 0.85em; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>Debate Report</h1>

  <div class="query">
    <strong>Query:</strong> ${this.escapeHtml(debate.query)}
  </div>

  <h2>Synthesis</h2>
  <div class="synthesis">
    ${this.escapeHtml(debate.synthesis)}
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${debate.rounds.length}</div>
      <div class="stat-label">Rounds</div>
    </div>
    <div class="stat">
      <div class="stat-value">${(debate.finalConsensusScore * 100).toFixed(0)}%</div>
      <div class="stat-label">Consensus</div>
    </div>
    <div class="stat">
      <div class="stat-value">${this.formatNumber(debate.tokensUsed)}</div>
      <div class="stat-label">Tokens</div>
    </div>
    <div class="stat">
      <div class="stat-value">${this.formatDuration(debate.duration)}</div>
      <div class="stat-label">Duration</div>
    </div>
  </div>

  <h2>Key Outcomes</h2>
  <h3 class="agreements">Agreements</h3>
  <ul>
    ${debate.keyAgreements.map(a => `<li>${this.escapeHtml(a)}</li>`).join('\n')}
  </ul>

  ${debate.unresolvedDisagreements.length > 0 ? `
  <h3 class="disagreements">Unresolved Disagreements</h3>
  <ul>
    ${debate.unresolvedDisagreements.map(d => `<li>${this.escapeHtml(d)}</li>`).join('\n')}
  </ul>
  ` : ''}

  <h2>Debate Rounds</h2>
  ${debate.rounds.map(round => this.renderRoundHTML(round)).join('\n')}

  <div class="meta">
    Generated: ${new Date().toLocaleString()}<br>
    Claude Orchestrator Debate System
  </div>
</body>
</html>
    `.trim();

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    saveAs(blob, `debate-report-${this.getTimestamp()}.html`);
  }

  /**
   * Export debate result as JSON
   */
  exportAsJSON(debate: DebateResult): void {
    const json = JSON.stringify(debate, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    saveAs(blob, `debate-export-${this.getTimestamp()}.json`);
  }

  /**
   * Export debate result as Markdown
   */
  exportAsMarkdown(debate: DebateResult): void {
    const md = `
# Debate Report

**Query:** ${debate.query}

**Generated:** ${new Date().toLocaleString()}

---

## Synthesis

${debate.synthesis}

---

## Statistics

| Metric | Value |
|--------|-------|
| Total Rounds | ${debate.rounds.length} |
| Final Consensus | ${(debate.finalConsensusScore * 100).toFixed(0)}% |
| Tokens Used | ${this.formatNumber(debate.tokensUsed)} |
| Duration | ${this.formatDuration(debate.duration)} |
| Consensus Reached | ${debate.consensusReached ? 'Yes' : 'No'} |

---

## Key Agreements

${debate.keyAgreements.map(a => `- ${a}`).join('\n')}

${debate.unresolvedDisagreements.length > 0 ? `
## Unresolved Disagreements

${debate.unresolvedDisagreements.map(d => `- ${d}`).join('\n')}
` : ''}

---

## Debate Rounds

${debate.rounds.map(round => this.renderRoundMarkdown(round)).join('\n\n---\n\n')}

---

*Generated by Claude Orchestrator Debate System*
    `.trim();

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    saveAs(blob, `debate-report-${this.getTimestamp()}.md`);
  }

  /**
   * Export debate result as PDF
   */
  async exportAsPDF(debate: DebateResult): Promise<void> {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    // Title
    doc.setFontSize(20);
    doc.setTextColor(99, 102, 241);
    doc.text('Debate Report', pageWidth / 2, 20, { align: 'center' });

    // Timestamp
    doc.setFontSize(10);
    doc.setTextColor(128, 128, 128);
    doc.text(`Generated: ${new Date().toLocaleString()}`, pageWidth / 2, 28, { align: 'center' });

    // Query
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    doc.text('Query:', 14, 40);
    doc.setFontSize(10);
    doc.setTextColor(64, 64, 64);
    const queryLines = doc.splitTextToSize(debate.query, pageWidth - 28);
    doc.text(queryLines, 14, 48);

    const queryEndY = 48 + queryLines.length * 5;

    // Stats
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    doc.text('Statistics', 14, queryEndY + 10);

    autoTable(doc, {
      startY: queryEndY + 14,
      head: [['Rounds', 'Consensus', 'Tokens', 'Duration']],
      body: [[
        debate.rounds.length.toString(),
        `${(debate.finalConsensusScore * 100).toFixed(0)}%`,
        this.formatNumber(debate.tokensUsed),
        this.formatDuration(debate.duration),
      ]],
      theme: 'grid',
      headStyles: { fillColor: [99, 102, 241] },
      styles: { fontSize: 9, halign: 'center' },
    });

    // Synthesis
    const synthesisY = (doc as any).lastAutoTable?.finalY + 10 || queryEndY + 40;
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    doc.text('Synthesis', 14, synthesisY);

    doc.setFontSize(10);
    doc.setTextColor(64, 64, 64);
    const synthesisLines = doc.splitTextToSize(debate.synthesis, pageWidth - 28);
    doc.text(synthesisLines, 14, synthesisY + 8);

    // Agreements
    const agreementsY = synthesisY + 8 + synthesisLines.length * 5 + 10;

    if (agreementsY > 250) {
      doc.addPage();
    }

    doc.setFontSize(12);
    doc.setTextColor(16, 185, 129);
    doc.text('Key Agreements', 14, agreementsY > 250 ? 20 : agreementsY);

    if (debate.keyAgreements.length > 0) {
      autoTable(doc, {
        startY: (agreementsY > 250 ? 24 : agreementsY + 4),
        head: [['#', 'Agreement']],
        body: debate.keyAgreements.map((a, i) => [(i + 1).toString(), a]),
        theme: 'striped',
        headStyles: { fillColor: [16, 185, 129] },
        styles: { fontSize: 9 },
        columnStyles: {
          0: { cellWidth: 15 },
          1: { cellWidth: pageWidth - 43 },
        },
      });
    }

    // Disagreements
    if (debate.unresolvedDisagreements.length > 0) {
      const disagreementsY = (doc as any).lastAutoTable?.finalY + 10 || agreementsY + 30;

      if (disagreementsY > 250) {
        doc.addPage();
      }

      doc.setFontSize(12);
      doc.setTextColor(245, 158, 11);
      doc.text('Unresolved Disagreements', 14, disagreementsY > 250 ? 20 : disagreementsY);

      autoTable(doc, {
        startY: (disagreementsY > 250 ? 24 : disagreementsY + 4),
        head: [['#', 'Disagreement']],
        body: debate.unresolvedDisagreements.map((d, i) => [(i + 1).toString(), d]),
        theme: 'striped',
        headStyles: { fillColor: [245, 158, 11] },
        styles: { fontSize: 9 },
        columnStyles: {
          0: { cellWidth: 15 },
          1: { cellWidth: pageWidth - 43 },
        },
      });
    }

    // Footer
    const pageCount = doc.internal.pages.length - 1;
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(128, 128, 128);
      doc.text(
        `Page ${i} of ${pageCount} | Claude Orchestrator Debate System`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 10,
        { align: 'center' }
      );
    }

    // Save
    doc.save(`debate-report-${this.getTimestamp()}.pdf`);
  }

  private renderRoundHTML(round: DebateSessionRound): string {
    return `
      <div class="round">
        <h3>Round ${round.roundNumber}: ${this.formatRoundType(round.type)}</h3>
        <p>Consensus: ${(round.consensusScore * 100).toFixed(0)}% | Duration: ${this.formatDuration(round.durationMs)}</p>
        ${round.contributions.map(c => `
          <div class="contribution">
            <span class="agent-badge">${c.agentId}</span>
            <span>(${(c.confidence * 100).toFixed(0)}% confident)</span>
            <p>${this.escapeHtml(c.content.substring(0, 300))}${c.content.length > 300 ? '...' : ''}</p>
          </div>
        `).join('\n')}
      </div>
    `;
  }

  private renderRoundMarkdown(round: DebateSessionRound): string {
    return `
### Round ${round.roundNumber}: ${this.formatRoundType(round.type)}

**Consensus Score:** ${(round.consensusScore * 100).toFixed(0)}%
**Duration:** ${this.formatDuration(round.durationMs)}

${round.contributions.map(c => `
#### ${c.agentId} (${(c.confidence * 100).toFixed(0)}% confident)

${c.content}

${c.reasoning ? `*Reasoning: ${c.reasoning}*` : ''}
`).join('\n')}
    `.trim();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private formatRoundType(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  private getTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  }
}
