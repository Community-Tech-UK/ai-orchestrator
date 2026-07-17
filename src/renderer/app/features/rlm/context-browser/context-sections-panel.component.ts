/**
 * Context Sections Panel Component - Sections list with filters
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy
} from '@angular/core';
import { SlicePipe } from '@angular/common';
import type { ContextSection } from '../../../../../shared/types/rlm.types';

@Component({
  selector: 'app-context-sections-panel',
  standalone: true,
  imports: [SlicePipe],
  template: `
    <div class="sections-panel">
      <div class="sections-header">
        <span class="sections-title">Context Sections</span>
        <div class="section-filters">
          <button
            class="filter-btn"
            [class.active]="sectionTypeFilter() === ''"
            (click)="setSectionTypeFilter('')"
          >
            All
          </button>
          @for (type of sectionTypes; track type) {
            <button
              class="filter-btn"
              [class.active]="sectionTypeFilter() === type"
              (click)="setSectionTypeFilter(type)"
            >
              {{ type }}
            </button>
          }
        </div>
      </div>

      <div class="sections-list">
        @for (section of filteredSections(); track section.id) {
          <div
            class="section-card"
            [class.selected]="selectedSectionId() === section.id"
            [class.summary]="section.depth > 0"
            (click)="selectSection.emit(section)"
            (keydown.enter)="selectSection.emit(section)"
            (keydown.space)="selectSection.emit(section)"
            tabindex="0"
            role="button"
          >
            <div class="section-header">
              <span class="section-type" [class]="'type-' + section.type">
                {{ section.type }}
              </span>
              <span class="section-tokens">{{ section.tokens }} tokens</span>
            </div>
            <div class="section-name">{{ section.name }}</div>
            <div class="section-preview">
              {{ truncateContent(section.content) }}
            </div>
            <div class="section-meta">
              @if (section.filePath) {
                <span class="meta-item"
                  >{{ section.filePath | slice: -30 }}</span
                >
              }
              @if (section.depth > 0) {
                <span class="meta-item depth">Depth: {{ section.depth }}</span>
              }
              @if (section.summarizes && section.summarizes.length > 0) {
                <span class="meta-item"
                  >Summarizes {{ section.summarizes.length }} sections</span
                >
              }
            </div>
          </div>
        }

        @if (filteredSections().length === 0) {
          <div class="empty-state">
            <span class="empty-text">No sections in context store</span>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .sections-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .sections-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .sections-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .section-filters {
        display: flex;
        gap: 4px;
      }

      .filter-btn {
        padding: 3px 8px;
        background: var(--bg-tertiary);
        border: none;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        font-size: 10px;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
        }

        &.active {
          background: var(--primary-color);
          color: white;
        }
      }

      .sections-list {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-sm);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .section-card {
        background: var(--bg-tertiary);
        border: 1px solid transparent;
        border-radius: var(--radius-sm);
        padding: var(--spacing-sm);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          border-color: var(--border-color);
        }

        &.selected {
          border-color: var(--primary-color);
          background: var(--bg-secondary);
        }

        &.summary {
          border-color: var(--warning-border);
          background: var(--warning-bg);
        }
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
      }

      .section-type {
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        font-size: 10px;
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

      .section-tokens {
        font-size: 10px;
        color: var(--text-muted);
      }

      .section-name {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-primary);
        margin-bottom: 4px;
      }

      .section-preview {
        font-size: 11px;
        color: var(--text-secondary);
        line-height: 1.4;
        margin-bottom: 4px;
      }

      .section-meta {
        display: flex;
        gap: var(--spacing-sm);
      }

      .meta-item {
        font-size: 9px;
        color: var(--text-muted);

        &.depth {
          color: #f59e0b;
        }
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xl);
        color: var(--text-muted);
      }

      .empty-text {
        font-size: 13px;
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ContextSectionsPanelComponent {
  sections = input.required<ContextSection[]>();
  selectedSectionId = input<string | null>(null);

  selectSection = output<ContextSection>();

  sectionTypes: ContextSection['type'][] = [
    'file',
    'conversation',
    'tool_output',
    'external',
    'summary'
  ];

  sectionTypeFilter = signal<ContextSection['type'] | ''>('');

  filteredSections = computed(() => {
    const filter = this.sectionTypeFilter();
    let sectionList = this.sections();

    if (filter) {
      sectionList = sectionList.filter((s) => s.type === filter);
    }

    return sectionList.sort((a, b) => a.startOffset - b.startOffset);
  });

  setSectionTypeFilter(type: ContextSection['type'] | ''): void {
    this.sectionTypeFilter.set(type);
  }

  truncateContent(content: string): string {
    if (content.length <= 100) return content;
    return content.slice(0, 100) + '...';
  }
}
