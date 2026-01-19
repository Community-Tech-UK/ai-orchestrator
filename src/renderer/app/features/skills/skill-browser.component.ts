/**
 * Skill Browser Component
 *
 * Skill discovery and management:
 * - Browse available skills
 * - Display trigger phrases
 * - Progressive loading hints
 * - Token cost estimation
 * - Install/uninstall skills
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import type { SkillBundle, SkillState } from '../../../../shared/types/skill.types';

interface SkillWithStatus {
  bundle: SkillBundle;
  installed: boolean;
  loading?: boolean;
}

@Component({
  selector: 'app-skill-browser',
  standalone: true,
  template: `
    <div class="skills-container">
      <!-- Header -->
      <div class="skills-header">
        <div class="header-left">
          <span class="skills-icon">🧩</span>
          <span class="skills-title">Skills</span>
          <span class="skill-count">
            {{ installedCount() }} installed
          </span>
        </div>
        <div class="header-actions">
          <input
            type="text"
            class="search-input"
            placeholder="Search skills..."
            [value]="searchQuery()"
            (input)="onSearch($event)"
          />
        </div>
      </div>

      <!-- Filters -->
      <div class="filters-section">
        <button
          class="filter-btn"
          [class.active]="categoryFilter() === ''"
          (click)="setCategory('')"
        >
          All
        </button>
        @for (cat of categories; track cat) {
          <button
            class="filter-btn"
            [class.active]="categoryFilter() === cat"
            (click)="setCategory(cat)"
          >
            {{ cat }}
          </button>
        }
      </div>

      <!-- Skills Grid -->
      <div class="skills-grid">
        @for (skill of filteredSkills(); track skill.bundle.id) {
          <div
            class="skill-card"
            [class.installed]="skill.installed"
            [class.loading]="skill.loading"
          >
            <!-- Card Header -->
            <div class="card-header">
              <span class="skill-icon">{{ skill.bundle.metadata.icon || '📦' }}</span>
              <div class="skill-info">
                <span class="skill-name">{{ skill.bundle.metadata.name }}</span>
                <span class="skill-version">v{{ skill.bundle.metadata.version }}</span>
              </div>
              @if (skill.installed) {
                <span class="installed-badge">✓</span>
              }
            </div>

            <!-- Description -->
            <p class="skill-description">{{ skill.bundle.metadata.description }}</p>

            <!-- Triggers -->
            @if (skill.bundle.metadata.triggers && skill.bundle.metadata.triggers.length > 0) {
              <div class="triggers-section">
                <span class="section-label">Triggers</span>
                <div class="triggers-list">
                  @for (trigger of skill.bundle.metadata.triggers.slice(0, 3); track trigger) {
                    <span class="trigger-tag">{{ trigger }}</span>
                  }
                  @if (skill.bundle.metadata.triggers.length > 3) {
                    <span class="trigger-more">
                      +{{ skill.bundle.metadata.triggers.length - 3 }} more
                    </span>
                  }
                </div>
              </div>
            }

            <!-- Size Indicators -->
            <div class="size-section">
              <span class="section-label">Content</span>
              <div class="size-info">
                @if (skill.bundle.metadata.coreSize) {
                  <span class="size-item">
                    📄 Core: {{ formatSize(skill.bundle.metadata.coreSize) }}
                  </span>
                }
                @if (skill.bundle.referencePaths.length > 0) {
                  <span class="size-item">
                    📚 {{ skill.bundle.referencePaths.length }} references
                  </span>
                }
                @if (skill.bundle.examplePaths.length > 0) {
                  <span class="size-item">
                    💡 {{ skill.bundle.examplePaths.length }} examples
                  </span>
                }
              </div>
            </div>

            <!-- Progressive Loading Hint -->
            <div class="loading-hint">
              <span class="hint-icon">💡</span>
              <span class="hint-text">
                Loads progressively: core first, then references on demand
              </span>
            </div>

            <!-- Actions -->
            <div class="card-actions">
              @if (!skill.installed) {
                <button
                  class="action-btn primary"
                  [disabled]="skill.loading"
                  (click)="installSkill(skill)"
                >
                  {{ skill.loading ? 'Installing...' : 'Install' }}
                </button>
              } @else {
                <button
                  class="action-btn secondary"
                  (click)="viewDetails(skill)"
                >
                  Details
                </button>
                <button
                  class="action-btn danger"
                  [disabled]="skill.loading"
                  (click)="uninstallSkill(skill)"
                >
                  Uninstall
                </button>
              }
            </div>

            <!-- Author -->
            @if (skill.bundle.metadata.author) {
              <div class="skill-author">
                by {{ skill.bundle.metadata.author }}
              </div>
            }
          </div>
        }

        @if (filteredSkills().length === 0) {
          <div class="empty-state">
            @if (skills().length === 0) {
              <span class="empty-icon">📦</span>
              <span class="empty-text">No skills available</span>
            } @else {
              <span class="empty-icon">🔍</span>
              <span class="empty-text">No skills match your search</span>
            }
          </div>
        }
      </div>

      <!-- Details Modal -->
      @if (selectedSkill(); as skill) {
        <div class="modal-overlay" (click)="closeDetails()">
          <div class="modal-content" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <span class="skill-icon large">{{ skill.bundle.metadata.icon || '📦' }}</span>
              <div class="modal-title">
                <span class="skill-name">{{ skill.bundle.metadata.name }}</span>
                <span class="skill-version">v{{ skill.bundle.metadata.version }}</span>
              </div>
              <button class="close-btn" (click)="closeDetails()">✕</button>
            </div>

            <div class="modal-body">
              <p class="skill-description">{{ skill.bundle.metadata.description }}</p>

              @if (skill.bundle.metadata.triggers && skill.bundle.metadata.triggers.length > 0) {
                <div class="detail-section">
                  <h4>Trigger Phrases</h4>
                  <div class="triggers-list full">
                    @for (trigger of skill.bundle.metadata.triggers; track trigger) {
                      <span class="trigger-tag">{{ trigger }}</span>
                    }
                  </div>
                </div>
              }

              <div class="detail-section">
                <h4>Skill Contents</h4>
                <table class="content-table">
                  <tr>
                    <td>Core (SKILL.md)</td>
                    <td>{{ formatSize(skill.bundle.metadata.coreSize || 0) }}</td>
                  </tr>
                  <tr>
                    <td>References</td>
                    <td>{{ skill.bundle.referencePaths.length }} files</td>
                  </tr>
                  <tr>
                    <td>Examples</td>
                    <td>{{ skill.bundle.examplePaths.length }} files</td>
                  </tr>
                  <tr>
                    <td>Scripts</td>
                    <td>{{ skill.bundle.scriptPaths.length }} files</td>
                  </tr>
                </table>
              </div>

              <div class="detail-section">
                <h4>Location</h4>
                <code class="path-display">{{ skill.bundle.path }}</code>
              </div>
            </div>

            <div class="modal-footer">
              @if (!skill.installed) {
                <button class="action-btn primary" (click)="installSkill(skill); closeDetails()">
                  Install
                </button>
              } @else {
                <button class="action-btn danger" (click)="uninstallSkill(skill); closeDetails()">
                  Uninstall
                </button>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .skills-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      max-height: 600px;
    }

    .skills-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .skills-icon {
      font-size: 18px;
    }

    .skills-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .skill-count {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .search-input {
      padding: 6px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      width: 200px;

      &:focus {
        outline: none;
        border-color: var(--primary-color);
      }
    }

    .filters-section {
      display: flex;
      gap: var(--spacing-xs);
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      overflow-x: auto;
    }

    .filter-btn {
      padding: 4px 10px;
      background: var(--bg-tertiary);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .skills-grid {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-md);
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: var(--spacing-md);
    }

    .skill-card {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      transition: all var(--transition-fast);

      &:hover {
        border-color: var(--primary-color);
      }

      &.installed {
        border-color: var(--success-color);
      }

      &.loading {
        opacity: 0.7;
      }
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .skill-icon {
      font-size: 24px;

      &.large {
        font-size: 32px;
      }
    }

    .skill-info {
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    .skill-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .skill-version {
      font-size: 11px;
      color: var(--text-muted);
    }

    .installed-badge {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--success-color);
      color: white;
      border-radius: 50%;
      font-size: 12px;
    }

    .skill-description {
      margin: 0;
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .triggers-section {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .section-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .triggers-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;

      &.full {
        margin-top: var(--spacing-xs);
      }
    }

    .trigger-tag {
      padding: 2px 6px;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    .trigger-more {
      font-size: 10px;
      color: var(--text-muted);
    }

    .size-section {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .size-info {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }

    .size-item {
      font-size: 10px;
      color: var(--text-secondary);
    }

    .loading-hint {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-xs);
      padding: var(--spacing-xs);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
    }

    .hint-icon {
      font-size: 12px;
      flex-shrink: 0;
    }

    .hint-text {
      font-size: 10px;
      color: var(--text-muted);
      line-height: 1.3;
    }

    .card-actions {
      display: flex;
      gap: var(--spacing-xs);
      margin-top: auto;
    }

    .action-btn {
      flex: 1;
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.primary {
        background: var(--primary-color);
        border: none;
        color: white;

        &:hover:not(:disabled) {
          background: var(--primary-hover);
        }
      }

      &.secondary {
        background: transparent;
        border: 1px solid var(--border-color);
        color: var(--text-secondary);

        &:hover:not(:disabled) {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
      }

      &.danger {
        background: transparent;
        border: 1px solid var(--error-color);
        color: var(--error-color);

        &:hover:not(:disabled) {
          background: var(--error-color);
          color: white;
        }
      }
    }

    .skill-author {
      font-size: 10px;
      color: var(--text-muted);
      text-align: right;
    }

    .empty-state {
      grid-column: 1 / -1;
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

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }

    .modal-content {
      width: 400px;
      max-height: 80vh;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .modal-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .modal-title {
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    .close-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 18px;
      cursor: pointer;

      &:hover {
        color: var(--text-primary);
      }
    }

    .modal-body {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-md);
    }

    .detail-section {
      margin-top: var(--spacing-md);

      h4 {
        margin: 0 0 var(--spacing-xs) 0;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary);
      }
    }

    .content-table {
      width: 100%;
      font-size: 12px;

      td {
        padding: var(--spacing-xs);
        border-bottom: 1px solid var(--border-color);
      }

      td:last-child {
        text-align: right;
        font-family: var(--font-mono);
        color: var(--text-secondary);
      }
    }

    .path-display {
      display: block;
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-tertiary);
      padding: var(--spacing-sm);
      border-radius: var(--radius-sm);
      word-break: break-all;
    }

    .modal-footer {
      padding: var(--spacing-md);
      border-top: 1px solid var(--border-color);
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SkillBrowserComponent {
  /** Available skills */
  skills = input<SkillWithStatus[]>([]);

  /** Events */
  install = output<SkillBundle>();
  uninstall = output<SkillBundle>();
  details = output<SkillBundle>();

  /** Categories */
  categories = ['Development', 'Testing', 'Documentation', 'DevOps', 'Analysis'];

  /** Search query */
  searchQuery = signal('');

  /** Category filter */
  categoryFilter = signal('');

  /** Selected skill for details */
  selectedSkill = signal<SkillWithStatus | null>(null);

  /** Installed count */
  installedCount = computed(() =>
    this.skills().filter((s) => s.installed).length
  );

  /** Filtered skills */
  filteredSkills = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const category = this.categoryFilter();

    return this.skills().filter((skill) => {
      const meta = skill.bundle.metadata;
      if (category && meta.category !== category) return false;
      if (query) {
        const searchable = [
          meta.name,
          meta.description,
          ...(meta.triggers || []),
        ].join(' ').toLowerCase();
        if (!searchable.includes(query)) return false;
      }
      return true;
    });
  });

  onSearch(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.searchQuery.set(target.value);
  }

  setCategory(category: string): void {
    this.categoryFilter.set(category);
  }

  installSkill(skill: SkillWithStatus): void {
    this.install.emit(skill.bundle);
  }

  uninstallSkill(skill: SkillWithStatus): void {
    this.uninstall.emit(skill.bundle);
  }

  viewDetails(skill: SkillWithStatus): void {
    this.selectedSkill.set(skill);
    this.details.emit(skill.bundle);
  }

  closeDetails(): void {
    this.selectedSkill.set(null);
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
