/**
 * Training Export Service
 *
 * Export training data and reports:
 * - CSV export for spreadsheet analysis
 * - JSON export for backup/analysis
 * - PDF report generation with charts
 */

import { Injectable } from '@angular/core';
import type { TaskOutcome, TaskPattern, LearningInsight, TrainingStats } from '../grpo-dashboard.component';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveAs } from 'file-saver';

/** Legacy export data format */
export interface ExportData {
  outcomes: TaskOutcome[];
  patterns: TaskPattern[];
  insights: LearningInsight[];
  stats: TrainingStats;
}

/** Enhanced dashboard export data format */
export interface EnhancedExportData {
  stats: {
    totalEpisodes: number;
    totalSteps?: number;
    averageReward: number;
    maxReward?: number;
    minReward?: number;
    successRate: number;
    averageAdvantage: number;
    learningRate: number;
    lastUpdated: number;
  } | null;
  rewardData: { step?: number; batchIndex?: number; reward: number; baseline?: number; timestamp?: number }[];
  strategies: { strategyId?: string; id?: string; name: string; avgReward: number; count: number; successRate: number; trend?: number; avgDuration?: number }[];
  patterns: { id: string; type: string; pattern?: string; description?: string; effectiveness?: number; confidence?: number; appliedCount?: number; frequency?: number; avgReward?: number; trend?: string | number | number[]; isAntiPattern?: boolean }[];
  insights: { id: string; type: string; description: string; confidence?: number; evidenceCount?: number; timestamp: number; isNew?: boolean; applied?: boolean }[];
  config: Record<string, number | boolean | string>;
}

@Injectable({
  providedIn: 'root',
})
export class TrainingExportService {
  /**
   * Export outcomes as CSV
   */
  exportOutcomesAsCSV(outcomes: TaskOutcome[]): void {
    const headers = [
      'ID',
      'Task Type',
      'Description',
      'Agent',
      'Model',
      'Tokens',
      'Duration (ms)',
      'Success',
      'Completion Score',
      'Error Type',
      'Timestamp',
    ];

    const rows = outcomes.map(o => [
      o.id,
      o.taskType,
      `"${o.taskDescription.replace(/"/g, '""')}"`,
      o.agentUsed,
      o.modelUsed,
      o.tokensUsed,
      o.duration,
      o.success ? 'Yes' : 'No',
      o.completionScore?.toFixed(2) ?? '',
      o.errorType ?? '',
      new Date(o.timestamp).toISOString(),
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `training-outcomes-${this.getTimestamp()}.csv`);
  }

  /**
   * Export patterns as CSV
   */
  exportPatternsAsCSV(patterns: TaskPattern[]): void {
    const headers = [
      'Type',
      'Pattern',
      'Effectiveness',
      'Sample Size',
      'Last Updated',
    ];

    const rows = patterns.map(p => [
      p.type,
      `"${p.value.replace(/"/g, '""')}"`,
      (p.effectiveness * 100).toFixed(1) + '%',
      p.sampleSize,
      new Date(p.lastUpdated).toISOString(),
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `training-patterns-${this.getTimestamp()}.csv`);
  }

  /**
   * Export all data as JSON (supports both legacy and enhanced formats)
   */
  exportAsJSON(data: ExportData | EnhancedExportData): void {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    saveAs(blob, `training-export-${this.getTimestamp()}.json`);
  }

  /**
   * Export enhanced data as CSV
   */
  exportAsCSV(data: EnhancedExportData): void {
    const sections: string[] = [];

    // Stats section
    if (data.stats) {
      sections.push('# Training Statistics');
      sections.push('Metric,Value');
      sections.push(`Total Episodes,${data.stats.totalEpisodes}`);
      if (data.stats.totalSteps !== undefined) sections.push(`Total Steps,${data.stats.totalSteps}`);
      sections.push(`Average Reward,${data.stats.averageReward.toFixed(4)}`);
      if (data.stats.maxReward !== undefined) sections.push(`Max Reward,${data.stats.maxReward.toFixed(4)}`);
      if (data.stats.minReward !== undefined) sections.push(`Min Reward,${data.stats.minReward.toFixed(4)}`);
      sections.push(`Success Rate,${(data.stats.successRate * 100).toFixed(1)}%`);
      sections.push(`Average Advantage,${data.stats.averageAdvantage.toFixed(4)}`);
      sections.push(`Learning Rate,${data.stats.learningRate}`);
      sections.push('');
    }

    // Reward data section
    if (data.rewardData.length > 0) {
      sections.push('# Reward Trend');
      sections.push('Step/Batch,Reward,Baseline,Timestamp');
      for (const point of data.rewardData) {
        const index = point.step ?? point.batchIndex ?? 0;
        const timestamp = point.timestamp ? new Date(point.timestamp).toISOString() : '';
        sections.push(`${index},${point.reward.toFixed(4)},${point.baseline?.toFixed(4) ?? ''},${timestamp}`);
      }
      sections.push('');
    }

    // Strategies section
    if (data.strategies.length > 0) {
      sections.push('# Strategies');
      sections.push('ID,Name,Avg Reward,Count,Success Rate,Trend');
      for (const strategy of data.strategies) {
        const id = strategy.strategyId || strategy.id || strategy.name;
        sections.push(`${id},"${strategy.name}",${strategy.avgReward.toFixed(4)},${strategy.count},${(strategy.successRate * 100).toFixed(1)}%,${strategy.trend ?? ''}`);
      }
      sections.push('');
    }

    // Patterns section
    if (data.patterns.length > 0) {
      sections.push('# Patterns');
      sections.push('ID,Type,Pattern/Description,Effectiveness,Confidence,Applied Count');
      for (const pattern of data.patterns) {
        const desc = pattern.pattern || pattern.description || '';
        const effectiveness = pattern.effectiveness !== undefined ? (pattern.effectiveness * 100).toFixed(1) + '%' : '';
        const confidence = pattern.confidence !== undefined ? (pattern.confidence * 100).toFixed(1) + '%' : '';
        sections.push(`${pattern.id},${pattern.type},"${desc.replace(/"/g, '""')}",${effectiveness},${confidence},${pattern.appliedCount ?? ''}`);
      }
      sections.push('');
    }

    // Insights section
    if (data.insights.length > 0) {
      sections.push('# Insights');
      sections.push('ID,Type,Description,Confidence,Evidence Count,Timestamp,Applied');
      for (const insight of data.insights) {
        const confidence = insight.confidence !== undefined ? (insight.confidence * 100).toFixed(1) + '%' : '';
        sections.push(`${insight.id},${insight.type},"${insight.description.replace(/"/g, '""')}",${confidence},${insight.evidenceCount ?? ''},${new Date(insight.timestamp).toISOString()},${insight.applied ?? ''}`);
      }
      sections.push('');
    }

    // Config section
    sections.push('# Configuration');
    sections.push('Parameter,Value');
    for (const [key, value] of Object.entries(data.config)) {
      const formattedKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
      sections.push(`${formattedKey},${value}`);
    }

    const csv = sections.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `training-export-${this.getTimestamp()}.csv`);
  }

  /**
   * Generate PDF report (supports both legacy and enhanced formats)
   */
  async exportAsPDF(data: ExportData | EnhancedExportData): Promise<void> {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    // Title
    doc.setFontSize(20);
    doc.setTextColor(99, 102, 241); // Primary color
    doc.text('GRPO Training Report', pageWidth / 2, 20, { align: 'center' });

    // Timestamp
    doc.setFontSize(10);
    doc.setTextColor(128, 128, 128);
    doc.text(`Generated: ${new Date().toLocaleString()}`, pageWidth / 2, 28, { align: 'center' });

    // Determine format type
    const isEnhancedFormat = 'rewardData' in data;

    // Stats Overview
    doc.setFontSize(14);
    doc.setTextColor(0, 0, 0);
    doc.text('Statistics Overview', 14, 42);

    doc.setFontSize(10);
    doc.setTextColor(64, 64, 64);
    const statsY = 50;

    if (isEnhancedFormat) {
      const enhancedData = data as EnhancedExportData;
      if (enhancedData.stats) {
        doc.text(`Total Episodes: ${enhancedData.stats.totalEpisodes}`, 14, statsY);
        doc.text(`Success Rate: ${(enhancedData.stats.successRate * 100).toFixed(1)}%`, 14, statsY + 6);
        doc.text(`Average Reward: ${enhancedData.stats.averageReward.toFixed(4)}`, 14, statsY + 12);
        doc.text(`Average Advantage: ${enhancedData.stats.averageAdvantage.toFixed(4)}`, 14, statsY + 18);
        doc.text(`Learning Rate: ${enhancedData.stats.learningRate}`, 14, statsY + 24);
      }

      // Strategies Table
      doc.setFontSize(14);
      doc.setTextColor(0, 0, 0);
      doc.text('Top Strategies', 14, statsY + 38);

      if (enhancedData.strategies.length > 0) {
        const strategyRows = enhancedData.strategies
          .sort((a, b) => b.avgReward - a.avgReward)
          .slice(0, 10)
          .map(s => [
            s.name,
            s.avgReward.toFixed(4),
            s.count.toString(),
            `${(s.successRate * 100).toFixed(1)}%`,
          ]);

        autoTable(doc, {
          startY: statsY + 42,
          head: [['Strategy', 'Avg Reward', 'Count', 'Success Rate']],
          body: strategyRows,
          theme: 'striped',
          headStyles: { fillColor: [99, 102, 241] },
          styles: { fontSize: 8 },
        });
      }

      // Patterns Table
      const patternsY = (doc as any).lastAutoTable?.finalY + 15 || 130;
      doc.setFontSize(14);
      doc.setTextColor(0, 0, 0);
      doc.text('Patterns', 14, patternsY);

      if (enhancedData.patterns.length > 0) {
        const patternRows = enhancedData.patterns
          .slice(0, 10)
          .map(p => {
            const desc = p.pattern || p.description || '';
            const effectiveness = p.effectiveness !== undefined ? `${(p.effectiveness * 100).toFixed(0)}%` : '';
            const confidence = p.confidence !== undefined ? `${(p.confidence * 100).toFixed(0)}%` : '';
            return [
              p.type,
              desc.substring(0, 50) + (desc.length > 50 ? '...' : ''),
              effectiveness,
              confidence,
              p.appliedCount?.toString() || '',
            ];
          });

        autoTable(doc, {
          startY: patternsY + 4,
          head: [['Type', 'Description', 'Effectiveness', 'Confidence', 'Applied']],
          body: patternRows,
          theme: 'striped',
          headStyles: { fillColor: [99, 102, 241] },
          styles: { fontSize: 8 },
        });
      }

      // Insights Table
      const insightsY = (doc as any).lastAutoTable?.finalY + 15 || 200;
      if (insightsY > 250) {
        doc.addPage();
      }

      doc.setFontSize(14);
      doc.setTextColor(0, 0, 0);
      doc.text('Insights', 14, insightsY > 250 ? 20 : insightsY);

      if (enhancedData.insights.length > 0) {
        const insightRows = enhancedData.insights
          .filter(i => !i.applied)
          .slice(0, 10)
          .map(i => {
            const confidence = i.confidence !== undefined ? `${(i.confidence * 100).toFixed(0)}%` : '';
            return [
              i.type,
              i.description.substring(0, 60) + (i.description.length > 60 ? '...' : ''),
              confidence,
              i.evidenceCount?.toString() || '',
            ];
          });

        autoTable(doc, {
          startY: (insightsY > 250 ? 24 : insightsY + 4),
          head: [['Type', 'Description', 'Confidence', 'Evidence']],
          body: insightRows,
          theme: 'striped',
          headStyles: { fillColor: [99, 102, 241] },
          styles: { fontSize: 8 },
        });
      }
    } else {
      // Legacy format
      const legacyData = data as ExportData;
      doc.text(`Total Outcomes: ${legacyData.stats.totalOutcomes}`, 14, statsY);
      doc.text(`Success Rate: ${(legacyData.stats.successRate * 100).toFixed(1)}%`, 14, statsY + 6);
      doc.text(`Patterns Discovered: ${legacyData.stats.patternCount}`, 14, statsY + 12);
      doc.text(`Insights Generated: ${legacyData.stats.insightCount}`, 14, statsY + 18);

      // Top Patterns Table
      doc.setFontSize(14);
      doc.setTextColor(0, 0, 0);
      doc.text('Top Patterns', 14, statsY + 32);

      if (legacyData.patterns.length > 0) {
        const patternRows = legacyData.patterns
          .sort((a, b) => b.effectiveness - a.effectiveness)
          .slice(0, 10)
          .map(p => [
            this.formatPatternType(p.type),
            p.value.substring(0, 50) + (p.value.length > 50 ? '...' : ''),
            `${(p.effectiveness * 100).toFixed(0)}%`,
            p.sampleSize.toString(),
          ]);

        autoTable(doc, {
          startY: statsY + 36,
          head: [['Type', 'Pattern', 'Effectiveness', 'Samples']],
          body: patternRows,
          theme: 'striped',
          headStyles: { fillColor: [99, 102, 241] },
          styles: { fontSize: 8 },
          columnStyles: {
            0: { cellWidth: 35 },
            1: { cellWidth: 80 },
            2: { cellWidth: 30 },
            3: { cellWidth: 25 },
          },
        });
      }

      // Recent Insights
      const insightsY = (doc as any).lastAutoTable?.finalY + 15 || 130;

      doc.setFontSize(14);
      doc.setTextColor(0, 0, 0);
      doc.text('Recent Insights', 14, insightsY);

      if (legacyData.insights.length > 0) {
        const insightRows = legacyData.insights
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 10)
          .map(i => [
            i.type,
            i.description.substring(0, 60) + (i.description.length > 60 ? '...' : ''),
            `${(i.confidence * 100).toFixed(0)}%`,
            `${(i.successRate * 100).toFixed(0)}%`,
          ]);

        autoTable(doc, {
          startY: insightsY + 4,
          head: [['Type', 'Description', 'Confidence', 'Success Rate']],
          body: insightRows,
          theme: 'striped',
          headStyles: { fillColor: [99, 102, 241] },
          styles: { fontSize: 8 },
          columnStyles: {
            0: { cellWidth: 30 },
            1: { cellWidth: 90 },
            2: { cellWidth: 25 },
            3: { cellWidth: 25 },
          },
        });
      }

      // Outcomes Summary
      const outcomesY = (doc as any).lastAutoTable?.finalY + 15 || 200;

      if (outcomesY > 250) {
        doc.addPage();
      }

      doc.setFontSize(14);
      doc.setTextColor(0, 0, 0);
      doc.text('Recent Outcomes', 14, outcomesY > 250 ? 20 : outcomesY);

      if (legacyData.outcomes.length > 0) {
        const outcomeRows = legacyData.outcomes
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 15)
          .map(o => [
            o.taskType,
            o.taskDescription.substring(0, 40) + (o.taskDescription.length > 40 ? '...' : ''),
            o.agentUsed,
            o.success ? 'Yes' : 'No',
            this.formatDuration(o.duration),
          ]);

        autoTable(doc, {
          startY: (outcomesY > 250 ? 24 : outcomesY + 4),
          head: [['Task Type', 'Description', 'Agent', 'Success', 'Duration']],
          body: outcomeRows,
          theme: 'striped',
          headStyles: { fillColor: [99, 102, 241] },
          styles: { fontSize: 8 },
          columnStyles: {
            0: { cellWidth: 30 },
            1: { cellWidth: 70 },
            2: { cellWidth: 35 },
            3: { cellWidth: 20 },
            4: { cellWidth: 25 },
          },
        });
      }
    }

    // Footer
    const pageCount = doc.internal.pages.length - 1;
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(128, 128, 128);
      doc.text(
        `Page ${i} of ${pageCount} | Claude Orchestrator GRPO Training`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 10,
        { align: 'center' }
      );
    }

    // Save
    doc.save(`grpo-training-report-${this.getTimestamp()}.pdf`);
  }

  /**
   * Export chart as image
   */
  exportChartAsImage(chartInstance: any, filename: string): void {
    if (!chartInstance?.getDataURL) return;

    const url = chartInstance.getDataURL({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: '#1a1a1a',
    });

    // Convert base64 to blob and save
    const byteString = atob(url.split(',')[1]);
    const mimeString = url.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([ab], { type: mimeString });

    saveAs(blob, `${filename}-${this.getTimestamp()}.png`);
  }

  private getTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  }

  private formatPatternType(type: string): string {
    return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }
}
