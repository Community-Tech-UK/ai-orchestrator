/**
 * Specialist Picker Component
 *
 * Grid/list of specialist profiles for creating specialized agents:
 * - Security, Test, Design, Review, DevOps specialists
 * - Icon and color per specialist
 * - Description and suggested commands
 * - Instance creation with specialist preset
 */

import {
  Component,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { SlicePipe } from '@angular/common';
import type {
  SpecialistProfile,
  SpecialistCommand,
} from '../../../../shared/types/specialist.types';

@Component({
  selector: 'app-specialist-picker',
  standalone: true,
  imports: [SlicePipe],
  template: `
    <div class="specialist-container">
      <!-- Header -->
      <div class="specialist-header">
        <span class="header-icon">👥</span>
        <span class="header-title">Specialists</span>
        <span class="header-subtitle">
          Create an agent with specialized capabilities
        </span>
      </div>

      <!-- View Toggle -->
      <div class="view-controls">
        <button
          class="view-btn"
          [class.active]="viewMode() === 'grid'"
          (click)="setViewMode('grid')"
        >
          ⊞ Grid
        </button>
        <button
          class="view-btn"
          [class.active]="viewMode() === 'list'"
          (click)="setViewMode('list')"
        >
          ☰ List
        </button>
      </div>

      <!-- Specialists Grid/List -->
      <div class="specialists" [class.grid]="viewMode() === 'grid'" [class.list]="viewMode() === 'list'">
        @for (specialist of specialists(); track specialist.id) {
          <div
            class="specialist-card"
            [class.selected]="selectedId() === specialist.id"
            [style.--accent-color]="specialist.color"
            (click)="selectSpecialist(specialist)"
          >
            <!-- Icon -->
            <div class="specialist-icon">
              {{ specialist.icon }}
            </div>

            <!-- Info -->
            <div class="specialist-info">
              <span class="specialist-name">{{ specialist.name }}</span>
              <span class="specialist-category">{{ specialist.category }}</span>
              <p class="specialist-description">{{ specialist.description }}</p>

              @if (viewMode() === 'list' && specialist.suggestedCommands && specialist.suggestedCommands.length > 0) {
                <div class="suggested-commands">
                  <span class="commands-label">Example commands:</span>
                  <div class="commands-list">
                    @for (cmd of specialist.suggestedCommands.slice(0, 3); track cmd.name) {
                      <code class="command-tag">{{ cmd.name }}</code>
                    }
                  </div>
                </div>
              }
            </div>

            <!-- Create Button -->
            <button
              class="create-btn"
              (click)="onCreate(specialist); $event.stopPropagation()"
            >
              Create
            </button>
          </div>
        }
      </div>

      <!-- Selected Details -->
      @if (selectedSpecialist(); as spec) {
        <div class="selected-details">
          <div class="details-header">
            <span class="details-icon" [style.color]="spec.color">
              {{ spec.icon }}
            </span>
            <div class="details-info">
              <span class="details-name">{{ spec.name }}</span>
              <span class="details-category">{{ spec.category }} specialist</span>
            </div>
          </div>

          <p class="details-description">{{ spec.description }}</p>

          @if (spec.defaultTools && spec.defaultTools.length > 0) {
            <div class="details-section">
              <span class="section-label">Default Tools</span>
              <div class="tools-list">
                @for (tool of spec.defaultTools; track tool) {
                  <span class="tool-tag">{{ tool }}</span>
                }
              </div>
            </div>
          }

          @if (spec.suggestedCommands && spec.suggestedCommands.length > 0) {
            <div class="details-section">
              <span class="section-label">Suggested Commands</span>
              <div class="commands-grid">
                @for (cmd of spec.suggestedCommands; track cmd.name) {
                  <div class="command-item">
                    <code class="command-name">{{ cmd.name }}</code>
                    <span class="command-desc">{{ cmd.description }}</span>
                  </div>
                }
              </div>
            </div>
          }

          @if (spec.systemPromptAddition) {
            <div class="details-section">
              <span class="section-label">System Prompt Preview</span>
              <pre class="prompt-preview">{{ spec.systemPromptAddition | slice:0:200 }}...</pre>
            </div>
          }

          <div class="details-actions">
            <button class="action-btn primary" (click)="onCreate(spec)">
              Create {{ spec.name }} Agent
            </button>
          </div>
        </div>
      }

      <!-- Empty State -->
      @if (specialists().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">👥</span>
          <span class="empty-text">No specialists available</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .specialist-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
    }

    .specialist-header {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .header-icon {
      font-size: 24px;
    }

    .header-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .header-subtitle {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .view-controls {
      display: flex;
      gap: var(--spacing-xs);
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .view-btn {
      padding: 4px 10px;
      background: var(--bg-tertiary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px;
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

    .specialists {
      padding: var(--spacing-md);

      &.grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: var(--spacing-md);

        .specialist-card {
          flex-direction: column;
          align-items: center;
          text-align: center;
          padding: var(--spacing-lg) var(--spacing-md);
        }

        .specialist-icon {
          font-size: 40px;
          margin-bottom: var(--spacing-sm);
        }

        .specialist-info {
          align-items: center;
        }

        .create-btn {
          margin-top: var(--spacing-md);
          width: 100%;
        }
      }

      &.list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);

        .specialist-card {
          flex-direction: row;
          padding: var(--spacing-md);
        }

        .specialist-icon {
          font-size: 32px;
          margin-right: var(--spacing-md);
        }

        .specialist-info {
          align-items: flex-start;
          text-align: left;
        }

        .create-btn {
          margin-left: auto;
        }
      }
    }

    .specialist-card {
      display: flex;
      background: var(--bg-tertiary);
      border: 2px solid transparent;
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        border-color: var(--accent-color, var(--primary-color));
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      }

      &.selected {
        border-color: var(--accent-color, var(--primary-color));
        background: var(--bg-secondary);
      }
    }

    .specialist-icon {
      flex-shrink: 0;
    }

    .specialist-info {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }

    .specialist-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .specialist-category {
      font-size: 11px;
      color: var(--accent-color, var(--text-muted));
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .specialist-description {
      margin: var(--spacing-xs) 0 0 0;
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .suggested-commands {
      margin-top: var(--spacing-sm);
    }

    .commands-label {
      font-size: 10px;
      color: var(--text-muted);
    }

    .commands-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }

    .command-tag {
      padding: 2px 6px;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-secondary);
    }

    .create-btn {
      padding: 6px 16px;
      background: var(--accent-color, var(--primary-color));
      border: none;
      border-radius: var(--radius-sm);
      color: white;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);
      flex-shrink: 0;

      &:hover {
        filter: brightness(1.1);
      }
    }

    /* Selected Details */
    .selected-details {
      padding: var(--spacing-md);
      border-top: 1px solid var(--border-color);
      background: var(--bg-tertiary);
    }

    .details-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }

    .details-icon {
      font-size: 32px;
    }

    .details-info {
      display: flex;
      flex-direction: column;
    }

    .details-name {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .details-category {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .details-description {
      margin: 0 0 var(--spacing-md) 0;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .details-section {
      margin-bottom: var(--spacing-md);
    }

    .section-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: var(--spacing-xs);
    }

    .tools-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
    }

    .tool-tag {
      padding: 2px 6px;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    .commands-grid {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .command-item {
      display: flex;
      align-items: baseline;
      gap: var(--spacing-sm);
    }

    .command-name {
      padding: 2px 6px;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-primary);
    }

    .command-desc {
      font-size: 11px;
      color: var(--text-muted);
    }

    .prompt-preview {
      margin: 0;
      padding: var(--spacing-sm);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-secondary);
      white-space: pre-wrap;
      max-height: 100px;
      overflow-y: auto;
    }

    .details-actions {
      margin-top: var(--spacing-md);
    }

    .action-btn {
      padding: 8px 20px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &.primary {
        background: var(--primary-color);
        border: none;
        color: white;

        &:hover {
          background: var(--primary-hover);
        }
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

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 13px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpecialistPickerComponent {
  /** Available specialist profiles */
  specialists = input<SpecialistProfile[]>([]);

  /** Create event */
  create = output<SpecialistProfile>();

  /** View mode */
  viewMode = signal<'grid' | 'list'>('grid');

  /** Selected specialist ID */
  selectedId = signal<string | null>(null);

  /** Selected specialist profile */
  selectedSpecialist = signal<SpecialistProfile | null>(null);

  setViewMode(mode: 'grid' | 'list'): void {
    this.viewMode.set(mode);
  }

  selectSpecialist(specialist: SpecialistProfile): void {
    if (this.selectedId() === specialist.id) {
      this.selectedId.set(null);
      this.selectedSpecialist.set(null);
    } else {
      this.selectedId.set(specialist.id);
      this.selectedSpecialist.set(specialist);
    }
  }

  onCreate(specialist: SpecialistProfile): void {
    this.create.emit(specialist);
  }
}
