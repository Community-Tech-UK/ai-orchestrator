/**
 * Context Section Detail Component - Selected section detail view
 */

import {
  Component,
  input,
  output,
  ChangeDetectionStrategy
} from '@angular/core';
import { SlicePipe } from '@angular/common';
import type { ContextSection, QueryType } from '../../../../../shared/types/rlm.types';

@Component({
  selector: 'app-context-section-detail',
  standalone: true,
  imports: [SlicePipe],
  template: `
    <div class="section-detail">
      <div class="detail-header">
        <span class="detail-type" [class]="'type-' + section().type">
          {{ section().type }}
        </span>
        <button class="close-btn" (click)="closePanel.emit()">✕</button>
      </div>

      <div class="detail-body">
        <div class="detail-section">
          <span class="section-label">Name</span>
          <span class="section-value">{{ section().name }}</span>
        </div>

        <div class="detail-section">
          <span class="section-label">Content</span>
          <pre class="section-content">{{ section().content }}</pre>
        </div>

        <div class="detail-section">
          <span class="section-label">Metadata</span>
          <div class="metadata-grid">
            <div class="metadata-item">
              <span class="metadata-label">Tokens</span>
              <span class="metadata-value">{{ section().tokens }}</span>
            </div>
            <div class="metadata-item">
              <span class="metadata-label">Offset</span>
              <span class="metadata-value"
                >{{ section().startOffset }} - {{ section().endOffset }}</span
              >
            </div>
            @if (section().filePath) {
              <div class="metadata-item">
                <span class="metadata-label">File</span>
                <span class="metadata-value">{{ section().filePath }}</span>
              </div>
            }
            @if (section().language) {
              <div class="metadata-item">
                <span class="metadata-label">Language</span>
                <span class="metadata-value">{{ section().language }}</span>
              </div>
            }
            <div class="metadata-item">
              <span class="metadata-label">Checksum</span>
              <span class="metadata-value mono">{{ section().checksum }}</span>
            </div>
          </div>
        </div>

        @if (section().summarizes && section().summarizes!.length > 0) {
          <div class="detail-section">
            <span class="section-label">Summarizes</span>
            <div class="summarizes-list">
              @for (id of section().summarizes!; track id) {
                <button class="summarized-item" (click)="navigateToSection.emit(id)">
                  {{ id | slice: 0 : 12 }}...
                </button>
              }
            </div>
          </div>
        }
      </div>

      <div class="detail-actions">
        @if (selectedQueryType() === 'summarize') {
          <button
            class="action-btn"
            (click)="addToQuery.emit(section().id)"
            [disabled]="isSectionInQuery()"
          >
            {{ isSectionInQuery() ? 'Added' : 'Add to Query' }}
          </button>
        }
        <button class="action-btn" (click)="getSectionContent.emit(section().id)">
          Get Full Content
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      .section-detail {
        border-top: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        max-height: 300px;
        overflow-y: auto;
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .detail-type {
        padding: 4px 8px;
        border-radius: var(--radius-sm);
        font-size: 12px;
        font-weight: 600;

        &.type-file {
          background: rgba(59, 130, 246, 0.2);
          color: #3b82f6;
        }

        &.type-conversation {
          background: rgba(16, 185, 129, 0.2);
          color: #10b981;
        }

        &.type-tool_output {
          background: rgba(245, 158, 11, 0.2);
          color: #f59e0b;
        }

        &.type-external {
          background: rgba(var(--primary-rgb), 0.2);
          color: var(--primary-color);
        }

        &.type-summary {
          background: rgba(var(--secondary-rgb), 0.2);
          color: var(--secondary-hover);
        }
      }

      .close-btn {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        font-size: 16px;
        cursor: pointer;

        &:hover {
          color: var(--text-primary);
        }
      }

      .detail-body {
        padding: var(--spacing-md);
      }

      .detail-section {
        margin-bottom: var(--spacing-md);

        &:last-child {
          margin-bottom: 0;
        }
      }

      .section-label {
        display: block;
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted);
        margin-bottom: var(--spacing-xs);
      }

      .section-value {
        font-size: 12px;
        color: var(--text-primary);
      }

      .section-content {
        margin: 0;
        padding: var(--spacing-sm);
        background: var(--bg-secondary);
        border-radius: var(--radius-sm);
        font-size: 11px;
        color: var(--text-primary);
        white-space: pre-wrap;
        max-height: 120px;
        overflow-y: auto;
        font-family: var(--font-mono);
      }

      .metadata-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--spacing-sm);
      }

      .metadata-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .metadata-label {
        font-size: 9px;
        color: var(--text-muted);
      }

      .metadata-value {
        font-size: 11px;
        color: var(--text-primary);

        &.mono {
          font-family: var(--font-mono);
        }
      }

      .summarizes-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .summarized-item {
        padding: 4px 8px;
        background: var(--bg-secondary);
        border: none;
        border-radius: var(--radius-sm);
        color: var(--primary-color);
        font-size: 10px;
        cursor: pointer;
        font-family: var(--font-mono);

        &:hover {
          background: var(--primary-color);
          color: white;
        }
      }

      .detail-actions {
        padding: var(--spacing-sm) var(--spacing-md);
        border-top: 1px solid var(--border-color);
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
      }

      .action-btn {
        padding: 6px 12px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 12px;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          background: var(--bg-hover);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ContextSectionDetailComponent {
  section = input.required<ContextSection>();
  selectedQueryType = input<QueryType>('grep');
  sectionInQuery = input(false);

  closePanel = output<void>();
  navigateToSection = output<string>();
  addToQuery = output<string>();
  getSectionContent = output<string>();

  isSectionInQuery(): boolean {
    return this.sectionInQuery();
  }
}
