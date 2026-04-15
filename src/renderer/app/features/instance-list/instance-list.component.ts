/**
 * Instance List Component - Project-grouped session rail
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { InstanceStore, type Instance } from '../../core/state/instance.store';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { HistoryStore } from '../../core/state/history.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { InstanceRowComponent } from './instance-row.component';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { RecentDirectoryEntry } from '../../../../shared/types/recent-directories.types';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ProjectGroupComputationService } from './project-group-computation.service';
import { HistoryRailService } from './history-rail.service';

const ORDER_STORAGE_KEY = 'instance-list-order';
const SORT_MODE_STORAGE_KEY = 'instance-list-sort-mode';
const NO_WORKSPACE_KEY = '__no_workspace__';
type HistorySortMode = 'last-interacted' | 'created';

export interface HierarchicalInstance {
  instance: Instance;
  railTitle: string;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isLastChild: boolean;
  parentChain: boolean[];
}

interface ProjectGroup {
  key: string;
  path: string | null;
  title: string;
  subtitle: string;
  createdAt: number;
  sessionCount: number;
  busyCount: number;
  hasSelectedInstance: boolean;
  isExpanded: boolean;
  isPinned: boolean;
  hasDraft: boolean;
  draftUpdatedAt: number | null;
  projectStateLabel: string;
  projectStateTone: 'working' | 'attention' | 'connecting' | 'ready' | 'history';
  lastActivity: number;
  liveItems: HierarchicalInstance[];
  historyItems: ConversationHistoryEntry[];
}

interface ProjectPathGroupIndex {
  group: ProjectGroup;
  index: number;
}

interface RailChangeSummary {
  additions: number;
  deletions: number;
}

@Component({
  selector: 'app-instance-list',
  standalone: true,
  imports: [ScrollingModule, InstanceRowComponent, DragDropModule],
  template: `
    <div class="instance-list-container">
      <div class="list-header">
        <div>
          <p class="list-eyebrow">Project index</p>
          <h2 class="list-title">Projects</h2>
        </div>
        <span class="list-count">{{ projectGroups().length }}</span>
      </div>

      <div class="filter-bar">
        <input
          type="text"
          class="filter-input"
          placeholder="Filter projects or sessions..."
          [value]="filterText()"
          (input)="onFilterChange($event)"
        />
        <div class="filter-controls">
          <label class="filter-select-group">
            <span class="filter-select-label">Sort</span>
            <select
              class="sort-filter"
              [value]="historySortMode()"
              (change)="onSortModeChange($event)"
              title="Sort project threads"
            >
              <option value="last-interacted">Last interacted</option>
              <option value="created">Created</option>
            </select>
          </label>
          <label class="filter-select-group">
            <span class="filter-select-label">State</span>
            <select
              class="status-filter"
              [value]="statusFilter()"
              (change)="onStatusFilterChange($event)"
            >
              <option value="all">All</option>
              <option value="idle">Idle</option>
              <option value="busy">Busy</option>
              <option value="waiting_for_input">Waiting</option>
              <option value="error">Error</option>
            </select>
          </label>
          @if (remoteNodeStore.hasNodes()) {
            <label class="filter-select-group">
              <span class="filter-select-label">Location</span>
              <select
                class="status-filter"
                [value]="locationFilter()"
                (change)="onLocationFilterChange($event)"
              >
                <option value="all">All</option>
                <option value="local">Local</option>
                <option value="remote">Remote</option>
              </select>
            </label>
          }
        </div>
      </div>

      <div
        class="instance-viewport"
        cdkDropList
        [cdkDropListData]="projectGroups()"
        [cdkDropListDisabled]="isProjectDragDisabled()"
        (cdkDropListDropped)="onProjectDrop($event)"
      >
        @for (group of projectGroups(); track group.key) {
          <section
            class="project-group"
            [class.project-draggable]="canDragProject(group)"
            cdkDrag
            [cdkDragData]="group"
            [cdkDragDisabled]="!canDragProject(group)"
          >
            <div class="project-drag-preview" *cdkDragPreview>
              <span class="project-drag-title">{{ group.title }}</span>
              <span class="project-drag-meta">{{ group.sessionCount }} sessions</span>
            </div>
            <div class="project-group-placeholder" *cdkDragPlaceholder></div>
            <div
              class="project-header-row"
              [class.expanded]="group.isExpanded"
              [class.has-selected-instance]="group.hasSelectedInstance"
            >
              <button
                type="button"
                class="project-header"
                [class.expanded]="group.isExpanded"
                [attr.aria-expanded]="group.isExpanded"
                [attr.aria-controls]="'project-group-' + group.key"
                (click)="toggleProjectGroup(group.key)"
              >
                <div class="project-copy">
                  <div class="project-title-row">
                    <span class="project-icon" aria-hidden="true">
                      <svg viewBox="0 0 16 16">
                        <path d="M1.5 3.5a1 1 0 0 1 1-1H6l1.1 1.4c.2.3.6.4.9.4h5.5a1 1 0 0 1 1 1v6.7a1.8 1.8 0 0 1-1.8 1.8H3.3A1.8 1.8 0 0 1 1.5 12V3.5Zm1 1v7.5c0 .4.3.8.8.8h9.4c.4 0 .8-.4.8-.8V5.5H7.9c-.6 0-1.2-.3-1.5-.8L5.5 3.5H2.5Z" />
                      </svg>
                    </span>
                    <div class="project-title-primary">
                      <span class="project-title">{{ group.title }}</span>
                      @if (group.sessionCount > 0) {
                        <span class="project-title-count">: {{ group.sessionCount }}</span>
                      }
                    </div>
                    @if (group.isPinned) {
                      <span class="project-pinned-pill">Pinned</span>
                    }
                    @if (group.hasDraft) {
                      <span class="project-draft-pill" [title]="getProjectDraftTitle(group)">Draft</span>
                    }
                  </div>
                  <span class="project-subtitle" [title]="group.subtitle">{{ group.subtitle }}</span>
                </div>
              </button>
              <div class="project-actions" [class.visible]="openProjectMenuKey() === group.key">
                <button
                  type="button"
                  class="project-action-btn project-drag-handle"
                  cdkDragHandle
                  [disabled]="!canDragProject(group)"
                  aria-label="Reorder project"
                  title="Drag to reorder project"
                  (click)="$event.preventDefault(); $event.stopPropagation()"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm10-8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
                  </svg>
                </button>
                @if (group.path) {
                  <button
                    type="button"
                    class="project-action-btn"
                    [attr.aria-label]="group.hasDraft ? 'Resume draft in this project' : 'Start a new conversation in this project'"
                    [attr.title]="group.hasDraft ? 'Resume draft in this project' : 'Start a new conversation in this project'"
                    (click)="startProjectConversation(group, $event)"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 1.5a.75.75 0 0 1 .75.75v5h5a.75.75 0 0 1 0 1.5h-5v5a.75.75 0 0 1-1.5 0v-5h-5a.75.75 0 0 1 0-1.5h5v-5A.75.75 0 0 1 8 1.5Z" />
                    </svg>
                  </button>
                  <div class="project-menu-anchor">
                    <button
                      type="button"
                      class="project-action-btn"
                      [class.active]="openProjectMenuKey() === group.key"
                      aria-haspopup="menu"
                      [attr.aria-expanded]="openProjectMenuKey() === group.key"
                      aria-label="Project options"
                      title="Project options"
                      (click)="toggleProjectMenu(group.key, $event)"
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M3 8a1.25 1.25 0 1 1-2.5 0A1.25 1.25 0 0 1 3 8Zm6.25 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.25 0A1.25 1.25 0 1 1 13 8a1.25 1.25 0 0 1 2.5 0Z" />
                      </svg>
                    </button>
                    @if (openProjectMenuKey() === group.key) {
                      <div
                        class="project-menu"
                        role="menu"
                        aria-label="Project options"
                        tabindex="-1"
                        (keydown)="onProjectMenuKeyDown($event)"
                      >
                        <button
                          type="button"
                          class="project-menu-item"
                          role="menuitem"
                          (click)="toggleProjectPinned(group, $event)"
                        >
                          {{ group.isPinned ? 'Unpin project' : 'Pin project' }}
                        </button>
                        <button
                          type="button"
                          class="project-menu-item"
                          role="menuitem"
                          (click)="openProjectInPreferredEditor(group, $event)"
                        >
                          Open in {{ preferredEditorLabel() }}
                        </button>
                        <button
                          type="button"
                          class="project-menu-item"
                          role="menuitem"
                          (click)="openProjectInSystemFileManager(group, $event)"
                        >
                          Open in {{ systemFileManagerLabel }}
                        </button>
                        <div class="project-menu-divider"></div>
                        <button
                          type="button"
                          class="project-menu-item project-menu-item--danger"
                          role="menuitem"
                          (click)="removeProject(group, $event)"
                        >
                          Remove project
                        </button>
                      </div>
                    }
                  </div>
                }
                <span class="project-chevron" aria-hidden="true">›</span>
              </div>
            </div>

            @if (group.isExpanded) {
              <div class="project-items" [id]="'project-group-' + group.key">
                @if (group.liveItems.length > 0) {
                  <div
                    class="project-live-items"
                    cdkDropList
                    [cdkDropListData]="group.liveItems"
                    (cdkDropListDropped)="onDrop($event, group)"
                  >
                    @for (item of group.liveItems; track item.instance.id) {
                      <div
                        class="drag-wrapper"
                        [class.is-root]="item.depth === 0"
                        [cdkDragDisabled]="item.depth > 0 || isDragDisabled()"
                        cdkDrag
                        [cdkDragData]="item"
                      >
                        <div class="drag-preview" *cdkDragPreview>
                          <span class="drag-preview-name">{{ item.railTitle }}</span>
                          @if (item.hasChildren) {
                            <span class="drag-preview-children">+{{ item.instance.childrenIds.length }}</span>
                          }
                        </div>
                        <div class="drag-placeholder" *cdkDragPlaceholder></div>

                        <app-instance-row
                          [instance]="item.instance"
                          [displayTitle]="item.railTitle"
                          [depth]="item.depth"
                          [hasChildren]="item.hasChildren"
                          [isExpanded]="item.isExpanded"
                          [isLastChild]="item.isLastChild"
                          [parentChain]="item.parentChain"
                          [isSelected]="selectedId() === item.instance.id"
                          [lastActivityLabel]="selectedId() === item.instance.id ? formatRelativeTime(item.instance.lastActivity) : null"
                          [isDraggable]="item.depth === 0"
                          (instanceSelect)="onSelectInstance($event)"
                          (terminate)="onTerminateInstance($event)"
                          (restart)="onRestartInstance($event)"
                          (toggleExpand)="onToggleExpand($event)"
                        />
                      </div>
                    }
                  </div>
                }

                @if (group.historyItems.length > 0) {
                  <div
                    class="project-history-items"
                    [class.with-divider]="group.liveItems.length > 0"
                  >
                    @for (entry of getVisibleHistoryItems(group); track entry.id) {
                      <div
                        class="history-entry"
                        [class.pinned]="isPinnedHistory(entry.id)"
                        [class.restoring]="isRestoringHistory(entry.id)"
                      >
                        <div class="history-entry-copy">
                          <button
                            type="button"
                            class="history-entry-pin"
                            [class.active]="isPinnedHistory(entry.id)"
                            [attr.aria-label]="isPinnedHistory(entry.id) ? 'Unpin thread' : 'Pin thread'"
                            [title]="isPinnedHistory(entry.id) ? 'Unpin thread' : 'Pin thread'"
                            (click)="togglePinnedHistory(entry.id, $event)"
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M10.9 1.8c.3 0 .6.1.8.3l2.2 2.2c.4.4.4 1 0 1.4l-1.5 1.5.5 3.9c0 .3-.1.6-.3.8l-1.1 1.1c-.2.2-.5.2-.8.1l-3.2-1.6-2.9 2.9-.7-.7 2.9-2.9-1.6-3.2c-.1-.3-.1-.6.1-.8L6.4 5c.2-.2.5-.3.8-.3l3.9.5 1.5-1.5c.1-.1.2-.2.2-.4 0-.1-.1-.3-.2-.4L10.4 2c-.1-.1-.3-.2-.4-.2-.1 0-.3.1-.4.2L8.1 3.5l.7.7-1.4 1.4-.7-.7L5.2 6.4l1.6 3.2 4-4-.7-.7 1.4-1.4.7.7 1.5-1.5c.3-.3.3-.9 0-1.2l-2.2-2.2c-.2-.2-.5-.3-.8-.3Z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            class="history-entry-main"
                            [disabled]="isRestoringHistory(entry.id)"
                            [attr.aria-label]="'Restore ' + getHistoryTitle(entry)"
                            (click)="onRestoreHistory(entry.id)"
                          >
                            <span class="history-entry-title-row">
                              <span
                                class="history-entry-provider-badge"
                                [style.color]="getHistoryProviderVisual(entry).color"
                                [title]="getHistoryProviderVisual(entry).label"
                              >
                                @switch (getHistoryProviderVisual(entry).icon) {
                                  @case ('anthropic') {
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                      <path d="M12 1.75c.48 0 .87.39.87.87v4.04a.87.87 0 1 1-1.74 0V2.62c0-.48.39-.87.87-.87Z"/>
                                      <path d="M17.88 3.33c.41.24.55.77.32 1.19l-2.02 3.5a.87.87 0 1 1-1.5-.87l2.02-3.5a.87.87 0 0 1 1.18-.32Z"/>
                                      <path d="M21.82 7.47c.24.41.1.95-.32 1.18L18 10.67a.87.87 0 0 1-.87-1.5l3.5-2.02a.87.87 0 0 1 1.19.32Z"/>
                                      <path d="M22.25 12c0 .48-.39.87-.87.87h-4.04a.87.87 0 1 1 0-1.74h4.04c.48 0 .87.39.87.87Z"/>
                                      <path d="M20.67 17.88a.87.87 0 0 1-1.18.32l-3.5-2.02a.87.87 0 1 1 .87-1.5l3.5 2.02c.41.24.55.77.31 1.18Z"/>
                                      <path d="M16.53 21.82a.87.87 0 0 1-1.18-.32l-2.02-3.5a.87.87 0 1 1 1.5-.87l2.02 3.5c.24.41.1.95-.32 1.19Z"/>
                                      <path d="M12 22.25a.87.87 0 0 1-.87-.87v-4.04a.87.87 0 1 1 1.74 0v4.04c0 .48-.39.87-.87.87Z"/>
                                      <path d="M7.47 20.67a.87.87 0 0 1-.32-1.18l2.02-3.5a.87.87 0 1 1 1.5.87l-2.02 3.5a.87.87 0 0 1-1.18.31Z"/>
                                      <path d="M3.33 16.53a.87.87 0 0 1 .32-1.18l3.5-2.02a.87.87 0 1 1 .87 1.5l-3.5 2.02a.87.87 0 0 1-1.19-.32Z"/>
                                      <path d="M1.75 12c0-.48.39-.87.87-.87h4.04a.87.87 0 1 1 0 1.74H2.62a.87.87 0 0 1-.87-.87Z"/>
                                      <path d="M3.33 7.47a.87.87 0 0 1 1.18-.32l3.5 2.02a.87.87 0 1 1-.87 1.5l-3.5-2.02a.87.87 0 0 1-.31-1.18Z"/>
                                      <path d="M7.47 3.33c.41-.24.95-.1 1.18.32l2.02 3.5a.87.87 0 1 1-1.5.87l-2.02-3.5a.87.87 0 0 1 .32-1.19Z"/>
                                      <circle cx="12" cy="12" r="1.65"/>
                                    </svg>
                                  }
                                  @case ('openai') {
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.985 5.985 0 0 0 .517 4.91 6.046 6.046 0 0 0 6.51 2.9A6.065 6.065 0 0 0 19.02 19.81a5.985 5.985 0 0 0 3.998-2.9 6.046 6.046 0 0 0-.736-7.09z"/>
                                    </svg>
                                  }
                                  @case ('google') {
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                                    </svg>
                                  }
                                  @case ('github') {
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                                    </svg>
                                  }
                                  @default {
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                                      <path d="M12 3.5 14.5 8l5 .7-3.6 3.5.9 4.9L12 14.9 7.2 17l.9-4.8L4.5 8.7 9.5 8 12 3.5Z"/>
                                    </svg>
                                  }
                                }
                              </span>
                              <span class="history-entry-title">
                                {{ getHistoryPreviewTitle(entry) }}
                              </span>
                            </span>
                          </button>
                        </div>
                        <div class="history-entry-meta">
                          @if (getHistoryChangeSummary(entry); as changeSummary) {
                            <div class="history-entry-diff" title="Changes in this completed session">
                              <span class="history-entry-diff-additions">
                                +{{ changeSummary.additions }}
                              </span>
                              <span class="history-entry-diff-deletions">
                                -{{ changeSummary.deletions }}
                              </span>
                            </div>
                          } @else {
                            <span
                              class="history-entry-time"
                              [title]="historySortMode() === 'created' ? 'Created' : 'Last interacted'"
                            >
                              {{ formatHistoryTime(entry) }}
                            </span>
                          }
                          <button
                            type="button"
                            class="history-entry-action"
                            aria-label="Archive thread"
                            title="Archive thread"
                            (click)="onArchiveHistory(entry.id, $event)"
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M2.5 2.5h11a1 1 0 0 1 1 1v2.1a1 1 0 0 1-.29.7l-1.56 1.56a1 1 0 0 0-.29.7V13a1 1 0 0 1-1 1h-6.7a1 1 0 0 1-1-1V8.56a1 1 0 0 0-.29-.7L1.79 6.3a1 1 0 0 1-.29-.7V3.5a1 1 0 0 1 1-1Zm0 1v1.7l1.56 1.56c.38.37.59.88.59 1.4V13h6.7V8.16c0-.52.21-1.03.59-1.4L13.5 5.2V3.5h-11Zm3.1 2.9h4.8v1h-4.8v-1Z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    }
                    @if (group.historyItems.length > 10) {
                      <button
                        type="button"
                        class="history-show-more"
                        (click)="toggleHistoryExpanded(group.key)"
                      >
                        {{ historyRail.expandedHistoryKeys().has(group.key) ? 'Show less' : 'Show more' }}
                      </button>
                    }
                  </div>
                }

                @if (group.liveItems.length === 0 && group.historyItems.length === 0) {
                  <div class="project-empty">No threads yet</div>
                }
              </div>
            }
          </section>
        } @empty {
          <div class="empty-state">
            @if (filterText() || statusFilter() !== 'all' || locationFilter() !== 'all') {
              <p>No projects match your filters</p>
            } @else {
              <p>No projects yet</p>
              <p class="hint">Create a session to start building a workspace index</p>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    .instance-list-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    .list-header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: var(--spacing-md);
      padding: 12px 16px 8px;
    }

    .list-eyebrow {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .list-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .list-count {
      min-width: 24px;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-secondary);
      text-align: center;
    }

    .filter-bar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0 16px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    .filter-controls {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
      gap: 8px;
    }

    .filter-select-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .filter-select-label {
      font-family: var(--font-mono);
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .filter-input,
    .sort-filter,
    .status-filter {
      font-family: var(--font-mono);
      font-size: 12px;
      letter-spacing: 0.02em;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 14px;
      color: var(--text-primary);
      transition: all var(--transition-fast);
    }

    .filter-input {
      padding: 8px 10px;

      &::placeholder {
        color: var(--text-muted);
      }
    }

    .sort-filter,
    .status-filter {
      width: 100%;
      min-width: 0;
      padding: 8px 36px 8px 10px;
      -webkit-appearance: none;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M4 6.25L8 10.25L12 6.25' stroke='%23B8C2B5' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      background-size: 14px;
      cursor: pointer;
    }

    .filter-input:focus,
    .status-filter:focus {
      outline: none;
      border-color: var(--primary-color);
      box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.12);
    }

    .instance-viewport {
      flex: 1;
      width: 100%;
      min-height: 200px;
      overflow-y: auto;
      padding: 8px 0 14px;
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .instance-viewport.cdk-drop-list-dragging .project-group:not(.cdk-drag-placeholder) {
      transition: transform 250ms cubic-bezier(0, 0, 0.2, 1);
    }

    .instance-viewport::-webkit-scrollbar {
      width: 6px;
    }

    .instance-viewport::-webkit-scrollbar-track {
      background: transparent;
    }

    .instance-viewport::-webkit-scrollbar-thumb {
      background: var(--border-color);
      border-radius: 3px;
    }

    .project-group {
      padding: 0 10px 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      transition: background var(--transition-fast);
      position: relative;
    }

    .project-group.project-draggable {
      cursor: default;
    }

    .project-header {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 6px 8px;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      text-align: left;
      overflow: hidden;
      transition: background var(--transition-fast);
    }

    .project-header:hover {
      background: transparent;
    }

    .project-header-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      width: 100%;
      min-width: 0;
      border-radius: 14px;
      transition: background var(--transition-fast), box-shadow var(--transition-fast);
      /* Establish stacking context above .project-items so the dropdown menu
         (inside .project-menu-anchor) paints above instance rows below.
         CDK drag-drop creates stacking contexts on siblings via transform. */
      position: relative;
      z-index: 1;
    }

    .project-header-row.has-selected-instance {
      background:
        linear-gradient(90deg, rgba(var(--primary-rgb), 0.08), rgba(255, 255, 255, 0.015)),
        rgba(255, 255, 255, 0.015);
      box-shadow: inset 0 0 0 1px rgba(var(--primary-rgb), 0.08);
    }

    .project-copy {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .project-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .project-title-primary {
      display: flex;
      align-items: baseline;
      gap: 4px;
      min-width: 0;
      flex: 1 1 auto;
    }

    .project-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      color: rgba(214, 221, 208, 0.76);
      flex-shrink: 0;
    }

    .project-icon svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    .project-title {
      min-width: 0;
      flex: 0 1 auto;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .project-title-count {
      flex-shrink: 0;
      color: rgba(186, 194, 182, 0.82);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.03em;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .project-pinned-pill {
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(var(--primary-rgb), 0.12);
      color: rgba(212, 233, 190, 0.92);
      font-family: var(--font-mono);
      font-size: 8px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    .project-draft-pill {
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(var(--secondary-rgb), 0.12);
      color: rgba(224, 234, 181, 0.92);
      font-family: var(--font-mono);
      font-size: 8px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    .project-subtitle {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.02em;
      color: rgba(168, 176, 164, 0.8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .project-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      justify-content: flex-end;
      opacity: 0;
      pointer-events: none;
      transform: translateX(6px);
      transition:
        opacity var(--transition-fast),
        transform var(--transition-fast);
      position: relative;
    }

    .project-header-row:hover .project-actions,
    .project-header-row:focus-within .project-actions,
    .project-actions.visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
    }

    .project-action-btn {
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 6px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--transition-fast);
      flex-shrink: 0;
    }

    .project-action-btn:focus-visible {
      outline: none;
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.06);
    }

    .project-action-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .project-action-btn:hover,
    .project-action-btn.active {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.06);
    }

    .project-action-btn svg {
      width: 13px;
      height: 13px;
      fill: currentColor;
    }

    .project-drag-handle {
      cursor: grab;
    }

    .project-drag-handle:active {
      cursor: grabbing;
    }

    .project-menu-anchor {
      position: relative;
    }

    .project-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      min-width: 172px;
      display: flex;
      flex-direction: column;
      padding: 6px;
      overflow: hidden;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: linear-gradient(180deg, rgb(23, 30, 28), rgb(12, 18, 17));
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.34);
      isolation: isolate;
      z-index: 100;
    }

    .project-menu-item {
      width: 100%;
      min-height: 32px;
      padding: 8px 10px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast), color var(--transition-fast);
    }

    .project-menu-item:focus-visible {
      outline: none;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-primary);
    }

    .project-menu-item:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-primary);
    }

    .project-menu-item--danger {
      color: var(--error-color);
    }

    .project-menu-item--danger:hover {
      background: rgba(239, 68, 68, 0.1);
      color: var(--error-color);
    }

    .project-menu-divider {
      height: 1px;
      margin: 4px 0;
      background: rgba(255, 255, 255, 0.06);
    }

    .project-empty {
      padding: 2px 0 6px 8px;
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      opacity: 0.72;
      text-transform: uppercase;
    }

    .history-show-more {
      display: block;
      width: 100%;
      padding: 4px 8px;
      background: none;
      border: none;
      font-family: var(--font-body);
      font-size: 12px;
      color: var(--text-muted);
      cursor: pointer;
      text-align: left;
      transition: color var(--transition-fast);
    }

    .history-show-more:hover {
      color: var(--text-primary);
    }

    .project-chevron {
      font-size: 14px;
      color: var(--text-muted);
      transition: transform var(--transition-fast);
      padding-top: 3px;
    }

    .project-group-placeholder {
      height: 44px;
      margin: 2px 0 8px;
      border: 1px dashed rgba(var(--primary-rgb), 0.22);
      border-radius: 12px;
      background: rgba(var(--primary-rgb), 0.05);
    }

    .project-drag-preview {
      min-width: 180px;
      max-width: 240px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(var(--primary-rgb), 0.28);
      background: rgba(12, 18, 17, 0.96);
      box-shadow:
        0 12px 28px rgba(0, 0, 0, 0.3),
        0 0 0 1px rgba(var(--primary-rgb), 0.16);
    }

    .project-drag-title {
      min-width: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .project-drag-meta {
      flex-shrink: 0;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .project-header-row.expanded .project-chevron {
      transform: rotate(90deg);
    }

    .project-items {
      padding: 6px 0 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .project-live-items {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .project-history-items {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .project-history-items.with-divider {
      margin-top: 0;
      padding-top: 0;
      border-top: none;
    }

    .history-entry {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 30px;
      padding: 5px 4px;
      background: transparent;
      border-radius: 8px;
      color: inherit;
      transition: background var(--transition-fast), color var(--transition-fast);
    }

    .history-entry.pinned {
      background: rgba(255, 255, 255, 0.035);
    }

    .history-entry:hover:not(.restoring) {
      background: rgba(255, 255, 255, 0.025);
    }

    .history-entry.restoring {
      opacity: 0.55;
      cursor: progress;
    }

    .history-entry-copy {
      display: flex;
      align-items: center;
      gap: 0;
      min-width: 0;
    }

    .history-entry-pin {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 0;
      height: 14px;
      padding: 0;
      margin-right: 0;
      border: none;
      border-radius: 999px;
      background: transparent;
      color: var(--text-muted);
      opacity: 0;
      overflow: hidden;
      cursor: pointer;
      transition:
        width var(--transition-fast),
        margin-right var(--transition-fast),
        opacity var(--transition-fast),
        color var(--transition-fast),
        background var(--transition-fast);
      flex-shrink: 0;
    }

    .history-entry:hover .history-entry-pin,
    .history-entry-pin.active {
      width: 14px;
      margin-right: 4px;
      opacity: 1;
    }

    .history-entry-pin:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
    }

    .history-entry-pin.active {
      color: var(--primary-color);
    }

    .history-entry-pin svg {
      width: 10px;
      height: 10px;
      fill: currentColor;
      transform: rotate(-28deg);
    }

    .history-entry-title {
      display: block;
      flex: 1 1 auto;
      min-width: 0;
      font-family: var(--font-body);
      font-size: 13px;
      font-weight: 500;
      line-height: 1.35;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    .history-entry-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .history-entry-main {
      width: 100%;
      min-width: 0;
      display: flex;
      align-items: center;
      padding: 0;
      border: none;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
      border-radius: 6px;
      transition: color var(--transition-fast);
    }

    .history-entry-title-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      width: 100%;
    }

    .history-entry-provider-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      opacity: 0.92;
    }

    .history-entry-provider-badge svg {
      width: 14px;
      height: 14px;
    }

    .history-entry-main:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 1px rgba(var(--primary-rgb), 0.2);
    }

    .history-entry-main:disabled {
      cursor: progress;
    }

    .history-entry-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 0;
      height: 16px;
      padding: 0;
      border: none;
      border-radius: 999px;
      background: transparent;
      color: var(--text-muted);
      opacity: 0;
      overflow: hidden;
      cursor: pointer;
      transition:
        width var(--transition-fast),
        opacity var(--transition-fast),
        color var(--transition-fast),
        background var(--transition-fast);
    }

    .history-entry:hover .history-entry-action,
    .history-entry:focus-within .history-entry-action {
      width: 16px;
      opacity: 1;
    }

    .history-entry-action:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
    }

    .history-entry-action svg {
      width: 11px;
      height: 11px;
      fill: currentColor;
    }

    .history-entry-time {
      font-family: var(--font-body);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0;
      text-transform: uppercase;
      color: rgba(168, 176, 164, 0.78);
    }

    .history-entry-diff {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }

    .history-entry-diff-additions {
      color: var(--success-color);
    }

    .history-entry-diff-deletions {
      color: var(--error-color);
    }

    .drag-wrapper {
      transition: transform 250ms cubic-bezier(0, 0, 0.2, 1);
    }

    .drag-wrapper.cdk-drag-dragging {
      opacity: 0.4;
    }

    .drag-placeholder {
      background: rgba(var(--primary-rgb), 0.06);
      border: 1px dashed rgba(var(--primary-rgb), 0.22);
      border-radius: 10px;
      height: 38px;
      margin: 2px 0;
    }

    .drag-preview {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      background: var(--bg-secondary);
      border: 1px solid var(--primary-color);
      border-radius: var(--radius-md);
      box-shadow:
        0 8px 24px rgba(0, 0, 0, 0.3),
        0 0 0 1px rgba(var(--primary-rgb), 0.2);
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 13px;
      color: var(--text-primary);
    }

    .drag-preview-name {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .drag-preview-children {
      background: rgba(var(--primary-rgb), 0.18);
      color: var(--primary-color);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 10px;
      letter-spacing: 0.02em;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 180px;
      color: var(--text-muted);
      text-align: center;
      padding: var(--spacing-xl);
    }

    .empty-state p {
      font-family: var(--font-display);
      font-size: 14px;
      margin: 0;
    }

    .empty-state .hint {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      margin-top: var(--spacing-sm);
      opacity: 0.7;
      letter-spacing: 0.03em;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstanceListComponent {
  private host = inject(ElementRef<HTMLElement>);
  private store = inject(InstanceStore);
  private historyStore = inject(HistoryStore);
  private recentDirectoriesService = inject(RecentDirectoriesIpcService);
  private fileIpc = inject(FileIpcService);
  protected readonly remoteNodeStore = inject(RemoteNodeStore);
  protected readonly projectGroupComputation = inject(ProjectGroupComputationService);
  protected readonly historyRail = inject(HistoryRailService);
  private newSessionDraft = inject(NewSessionDraftService);

  filterText = signal('');
  statusFilter = signal<string>('all');
  locationFilter = signal<'all' | 'local' | 'remote'>('all');
  collapsedIds = signal<Set<string>>(new Set());
  collapsedProjectKeys = signal<Set<string>>(new Set());
  rootInstanceOrder = signal<string[]>(this.loadOrder());
  recentDirectories = signal<RecentDirectoryEntry[]>([]);
  historySortMode = signal<HistorySortMode>(this.loadSortMode());
  openProjectMenuKey = signal<string | null>(null);
  preferredEditorLabel = signal('Editor');
  lastVisitedHistoryThreadId = signal<string | null>(null);
  selectedId = this.store.selectedInstanceId;
  readonly systemFileManagerLabel = this.getSystemFileManagerLabel();
  private projectMenuTrigger: HTMLButtonElement | null = null;

  isDragDisabled = computed(() =>
    this.filterText().length > 0 || this.statusFilter() !== 'all' || this.locationFilter() !== 'all'
  );
  isProjectDragDisabled = computed(() =>
    this.filterText().length > 0 || this.statusFilter() !== 'all' || this.locationFilter() !== 'all' || this.openProjectMenuKey() !== null
  );

  projectGroups = computed(() => {
    this.newSessionDraft.revision();
    const instances = this.store.instances();
    const historyEntries = this.historyStore.entries().filter((entry) => !entry.archivedAt);
    const recentDirectories = this.recentDirectories();
    const filter = this.filterText().trim().toLowerCase();
    const status = this.statusFilter();
    const location = this.locationFilter();
    const childrenByParent = this.projectGroupComputation.buildChildrenMap(instances);
    const instanceMap = new Map(instances.map((instance) => [instance.id, instance]));
    const selectedId = this.selectedId();
    const collapsed = this.collapsedIds();
    const collapsedProjects = this.collapsedProjectKeys();
    const historyByProject = this.buildHistoryEntriesByProject(historyEntries, filter, status, location);
    const recentDirectoriesByKey = new Map(
      recentDirectories.map((entry) => [this.getProjectKey(entry.path), entry])
    );
    const recentDirectoryOrder = new Map(
      recentDirectories.map((entry, index) => [this.getProjectKey(entry.path), index] as const)
    );
    const groups = new Map<string, ProjectGroup>();

    for (const root of this.getOrderedRootInstances(instances)) {
      const projectKey = this.getProjectKey(root.workingDirectory);
      const title = this.getProjectTitle(root.workingDirectory);
      const subtitle = this.getProjectSubtitle(root.workingDirectory);
      const projectMatches = !!filter && this.projectGroupComputation.matchesProjectText(title, subtitle, filter);
      const rawHistoryItems = historyByProject.get(projectKey) ?? [];
      const existingGroup = groups.get(projectKey);
      const historyLookupItems = existingGroup?.historyItems ?? rawHistoryItems;
      const historyByThreadId = new Map(
        historyLookupItems.map((entry) => [this.historyRail.getHistoryThreadId(entry), entry])
      );
      const liveItems = this.projectGroupComputation.buildVisibleItems(
        root,
        {
          filter,
          status,
          location,
          projectMatches,
          collapsed,
          childrenByParent,
          instanceMap,
        },
        0,
        [],
        true
      ).map((item) => ({
        ...item,
        railTitle: this.getLiveRailTitle(
          item.instance,
          historyByThreadId.get(this.getInstanceThreadId(item.instance))
        ),
      }));
      const liveThreadIds = new Set(
        liveItems
          .map((item) => this.getInstanceThreadId(item.instance))
          .filter((threadId): threadId is string => threadId.trim().length > 0)
      );
      const historySourceItems = existingGroup?.historyItems ?? rawHistoryItems;
      const historyItems = historySourceItems.filter(
        (entry) => !liveThreadIds.has(this.historyRail.getHistoryThreadId(entry))
      );

      if (liveItems.length === 0 && historyItems.length === 0) {
        continue;
      }

      const recentDirectory = recentDirectoriesByKey.get(projectKey);
      const draftInfo = this.projectGroupComputation.getProjectDraftInfo(root.workingDirectory);
      const group = existingGroup ?? {
        key: projectKey,
        path: root.workingDirectory?.trim() || null,
        title: recentDirectory?.displayName || title,
        subtitle: recentDirectory ? this.getProjectSubtitle(recentDirectory.path) : subtitle,
        createdAt: recentDirectory?.lastAccessed ?? root.createdAt,
        sessionCount: 0,
        busyCount: 0,
        hasSelectedInstance: false,
        isExpanded: !collapsedProjects.has(projectKey),
        isPinned: recentDirectory?.isPinned ?? false,
        hasDraft: draftInfo.hasDraft,
        draftUpdatedAt: draftInfo.draftUpdatedAt,
        projectStateLabel: 'Ready',
        projectStateTone: 'ready',
        lastActivity: recentDirectory?.lastAccessed ?? root.lastActivity ?? root.createdAt,
        liveItems: [],
        historyItems: [],
      };
      const previousHistoryCount = group.historyItems.length;

      group.liveItems.push(...liveItems);
      group.createdAt = Math.max(
        group.createdAt,
        root.createdAt,
        ...rawHistoryItems.map((item) => item.createdAt)
      );
      group.sessionCount += this.projectGroupComputation.countSessionsInTree(root, childrenByParent, instanceMap);
      group.busyCount += this.projectGroupComputation.countBusySessions(root, childrenByParent, instanceMap);
      group.hasSelectedInstance = group.hasSelectedInstance || liveItems.some((item) => item.instance.id === selectedId);
      group.isExpanded = !collapsedProjects.has(projectKey);
      group.historyItems = historyItems;
      group.hasDraft = group.hasDraft || draftInfo.hasDraft;
      group.draftUpdatedAt = group.draftUpdatedAt ?? draftInfo.draftUpdatedAt;
      Object.assign(group, this.projectGroupComputation.getProjectStateSummary(group.liveItems, group.historyItems, group.hasDraft));
      group.sessionCount += historyItems.length - previousHistoryCount;
      groups.set(projectKey, group);
      historyByProject.delete(projectKey);
      recentDirectoriesByKey.delete(projectKey);
    }

    for (const [projectKey, historyItems] of historyByProject) {
      if (historyItems.length === 0) {
        continue;
      }

      const recentDirectory = recentDirectoriesByKey.get(projectKey);
      const workingDirectory = recentDirectory?.path || historyItems[0].workingDirectory || null;
      const draftInfo = this.projectGroupComputation.getProjectDraftInfo(workingDirectory);
      groups.set(projectKey, {
        key: projectKey,
        path: workingDirectory,
        title: recentDirectory?.displayName || this.getProjectTitle(historyItems[0].workingDirectory),
        subtitle: recentDirectory ? this.getProjectSubtitle(recentDirectory.path) : this.getProjectSubtitle(historyItems[0].workingDirectory),
        createdAt: Math.max(
          recentDirectory?.lastAccessed ?? 0,
          ...historyItems.map((item) => item.createdAt)
        ),
        sessionCount: historyItems.length,
        busyCount: 0,
        hasSelectedInstance: false,
        isExpanded: !collapsedProjects.has(projectKey),
        isPinned: recentDirectory?.isPinned ?? false,
        hasDraft: draftInfo.hasDraft,
        draftUpdatedAt: draftInfo.draftUpdatedAt,
        ...this.projectGroupComputation.getProjectStateSummary([], historyItems, draftInfo.hasDraft),
        lastActivity: recentDirectory?.lastAccessed ?? historyItems[0].endedAt,
        liveItems: [],
        historyItems,
      });
      recentDirectoriesByKey.delete(projectKey);
    }

    if (status === 'all' && location !== 'remote') {
      for (const recentDirectory of recentDirectoriesByKey.values()) {
        const title = recentDirectory.displayName || this.getProjectTitle(recentDirectory.path);
        const subtitle = this.getProjectSubtitle(recentDirectory.path);
        if (filter && !this.projectGroupComputation.matchesProjectText(title, subtitle, filter)) {
          continue;
        }

        const projectKey = this.getProjectKey(recentDirectory.path);
        const draftInfo = this.projectGroupComputation.getProjectDraftInfo(recentDirectory.path);
        groups.set(projectKey, {
          key: projectKey,
          path: recentDirectory.path || null,
          title,
          subtitle,
          createdAt: recentDirectory.lastAccessed,
          sessionCount: 0,
          busyCount: 0,
          hasSelectedInstance: false,
          isExpanded: !collapsedProjects.has(projectKey),
          isPinned: recentDirectory.isPinned,
          hasDraft: draftInfo.hasDraft,
          draftUpdatedAt: draftInfo.draftUpdatedAt,
          ...this.projectGroupComputation.getProjectStateSummary([], [], draftInfo.hasDraft),
          lastActivity: recentDirectory.lastAccessed,
          liveItems: [],
          historyItems: [],
        });
      }
    }

    return Array.from(groups.values()).sort((left, right) => {
      const leftOrder = recentDirectoryOrder.get(left.key);
      const rightOrder = recentDirectoryOrder.get(right.key);
      if (leftOrder !== undefined && rightOrder !== undefined) {
        return leftOrder - rightOrder;
      }
      if (leftOrder !== undefined) {
        return -1;
      }
      if (rightOrder !== undefined) {
        return 1;
      }

      const timestampDelta =
        this.getProjectSortTimestamp(right) - this.getProjectSortTimestamp(left);
      if (timestampDelta !== 0) {
        return timestampDelta;
      }

      return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
    });
  });

  constructor() {
    void this.historyStore.loadHistory();
    void this.loadRecentDirectories();

    effect(() => {
      const selected = this.store.selectedInstance();
      if (!selected) {
        return;
      }

      this.lastVisitedHistoryThreadId.set(this.getInstanceThreadId(selected));

      const projectKey = this.getProjectKey(selected.workingDirectory);
      this.collapsedProjectKeys.update((current) => {
        if (!current.has(projectKey)) {
          return current;
        }

        const next = new Set(current);
        next.delete(projectKey);
        return next;
      });

      this.collapsedIds.update((current) => {
        let changed = false;
        const next = new Set(current);
        let parentId = selected.parentId;

        while (parentId) {
          if (next.delete(parentId)) {
            changed = true;
          }
          parentId = this.store.instancesMap().get(parentId)?.parentId ?? null;
        }

        return changed ? next : current;
      });
    });

    let previousRootIds = new Set<string>();
    effect(() => {
      const currentRootIds = new Set(this.store.rootInstances().map((instance) => instance.id));
      const removedRoot = previousRootIds.size > 0 &&
        Array.from(previousRootIds).some((id) => !currentRootIds.has(id));
      const historyEntries = this.historyStore.entries().filter((entry) => !entry.archivedAt);
      const knownRecentDirectories = new Set(
        untracked(() => this.recentDirectories()).map((entry) => this.getProjectKey(entry.path))
      );
      const missingDirectories: { path: string; nodeId?: string }[] = [];

      previousRootIds = currentRootIds;

      // Sync live workspaces into the persisted recent-project index.
      for (const instance of this.store.rootInstances()) {
        const workingDirectory = instance.workingDirectory?.trim();
        if (workingDirectory && !knownRecentDirectories.has(this.getProjectKey(workingDirectory))) {
          knownRecentDirectories.add(this.getProjectKey(workingDirectory));
          const loc = instance.executionLocation;
          missingDirectories.push({
            path: workingDirectory,
            ...(loc?.type === 'remote' ? { nodeId: loc.nodeId } : {}),
          });
        }
      }
      for (const entry of historyEntries) {
        const workingDirectory = entry.workingDirectory?.trim();
        if (workingDirectory && !knownRecentDirectories.has(this.getProjectKey(workingDirectory))) {
          knownRecentDirectories.add(this.getProjectKey(workingDirectory));
          missingDirectories.push({
            path: workingDirectory,
            ...(entry.executionLocation?.type === 'remote'
              ? { nodeId: entry.executionLocation.nodeId }
              : {}),
          });
        }
      }
      if (missingDirectories.length > 0) {
        void this.syncRecentDirectories(missingDirectories);
      }

      if (removedRoot) {
        void this.historyStore.loadHistory();
      }
    });

    effect(() => {
      const historyEntries = this.historyStore.entries().filter((entry) => !entry.archivedAt);
      if (historyEntries.length === 0) {
        return;
      }

      const liveThreadIds = new Set(
        this.store.instances()
          .map((instance) => this.getInstanceThreadId(instance))
          .filter((threadId): threadId is string => threadId.trim().length > 0)
      );
      const latestHistoryEntries = this.getLatestHistoryEntriesByThread(historyEntries);
      const lastVisitedThreadId = this.lastVisitedHistoryThreadId();
      const seenEntries = Array.from(latestHistoryEntries.values()).filter((entry) => {
        const threadId = this.historyRail.getHistoryThreadId(entry);
        return liveThreadIds.has(threadId) || threadId === lastVisitedThreadId;
      });

      this.historyRail.markHistoryEntriesSeen(seenEntries);
    });
  }

  onFilterChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.filterText.set(input.value);
    this.closeProjectMenu({ restoreFocus: false });
  }

  onStatusFilterChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.statusFilter.set(select.value);
    this.closeProjectMenu({ restoreFocus: false });
  }

  onLocationFilterChange(event: Event): void {
    this.locationFilter.set((event.target as HTMLSelectElement).value as 'all' | 'local' | 'remote');
  }

  onSortModeChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = select.value === 'created' ? 'created' : 'last-interacted';
    this.historySortMode.set(value);
    this.saveSortMode(value);
    this.closeProjectMenu({ restoreFocus: false });
  }

  onSelectInstance(instanceId: string): void {
    this.closeProjectMenu({ restoreFocus: false });
    this.store.setSelectedInstance(instanceId);
  }

  onTerminateInstance(instanceId: string): void {
    this.store.terminateInstance(instanceId);
  }

  onRestartInstance(instanceId: string): void {
    this.store.restartInstance(instanceId);
  }

  onToggleExpand(instanceId: string): void {
    this.collapsedIds.update((current) => {
      const next = new Set(current);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  }

  toggleProjectGroup(projectKey: string): void {
    this.closeProjectMenu({ restoreFocus: false });
    this.collapsedProjectKeys.update((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }

  async toggleProjectPinned(group: ProjectGroup, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!group.path) {
      return;
    }

    const nextPinnedState = !group.isPinned;
    let updated = await this.recentDirectoriesService.pinDirectory(group.path, nextPinnedState);
    if (!updated) {
      await this.recentDirectoriesService.addDirectory(group.path);
      updated = await this.recentDirectoriesService.pinDirectory(group.path, nextPinnedState);
    }
    if (updated) {
      await this.loadRecentDirectories();
    }
    this.closeProjectMenu();
  }

  async toggleProjectMenu(projectKey: string, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.projectMenuTrigger = event.currentTarget instanceof HTMLButtonElement
      ? event.currentTarget
      : null;

    if (this.openProjectMenuKey() === projectKey) {
      this.closeProjectMenu();
      return;
    }

    await this.ensurePreferredEditorLoaded();
    this.openProjectMenuKey.set(projectKey);
    requestAnimationFrame(() => {
      const firstMenuItem = this.host.nativeElement.querySelector('.project-menu .project-menu-item');
      if (firstMenuItem instanceof HTMLButtonElement) {
        firstMenuItem.focus();
      }
    });
  }

  async openProjectInPreferredEditor(group: ProjectGroup, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!group.path) {
      return;
    }

    this.closeProjectMenu();
    await this.fileIpc.editorOpenDirectory(group.path);
  }

  async openProjectInSystemFileManager(group: ProjectGroup, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!group.path) {
      return;
    }

    this.closeProjectMenu();
    await this.fileIpc.openPath(group.path);
  }

  async removeProject(group: ProjectGroup, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!group.path) {
      return;
    }

    this.closeProjectMenu();

    // Archive all history entries for this project
    for (const entry of group.historyItems) {
      await this.historyStore.archiveEntry(entry.id);
    }

    // Remove from recent directories
    await this.recentDirectoriesService.removeDirectory(group.path);
    await this.loadRecentDirectories();
  }

  startProjectConversation(group: ProjectGroup, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeProjectMenu({ restoreFocus: false });
    const nodeId = this.getProjectNodeId(group);
    this.newSessionDraft.open(group.path, nodeId);
    this.store.setSelectedInstance(null);
  }

  private getProjectNodeId(group: ProjectGroup): string | null {
    // Check recent directories first (authoritative source for node mapping)
    if (group.path) {
      const recentEntry = this.recentDirectories().find(
        (entry) => this.getProjectKey(entry.path) === group.key,
      );
      if (recentEntry?.nodeId) {
        return recentEntry.nodeId;
      }
    }

    // Fall back to live instances' execution location
    const remoteItem = group.liveItems.find(
      (item) => item.instance.executionLocation?.type === 'remote',
    );
    const remoteLoc = remoteItem?.instance.executionLocation;
    return remoteLoc?.type === 'remote' ? remoteLoc.nodeId : null;
  }

  onDrop(event: CdkDragDrop<HierarchicalInstance[]>, group: ProjectGroup): void {
    const draggedItem = event.item.data as HierarchicalInstance;
    if (draggedItem.depth > 0) {
      return;
    }

    const groupRootIds = group.liveItems
      .filter((item) => item.depth === 0)
      .map((item) => item.instance.id);
    const fromRootIndex = groupRootIds.indexOf(draggedItem.instance.id);
    if (fromRootIndex === -1) {
      return;
    }

    const visibleRootIds = group.liveItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.depth === 0);

    const currentVisibleRootIndex = visibleRootIds.findIndex(({ index }) => index === event.currentIndex);
    const targetRootIndex = currentVisibleRootIndex === -1
      ? groupRootIds.length - 1
      : currentVisibleRootIndex;

    if (fromRootIndex === targetRootIndex) {
      return;
    }

    const reorderedGroupRoots = [...groupRootIds];
    moveItemInArray(reorderedGroupRoots, fromRootIndex, targetRootIndex);

    const currentOrderedRoots = this.getOrderedRootIds(this.store.instances());
    const replacementQueue = [...reorderedGroupRoots];
    const groupSet = new Set(groupRootIds);
    const nextOrder = currentOrderedRoots.map((rootId) =>
      groupSet.has(rootId) ? replacementQueue.shift() ?? rootId : rootId
    );

    this.rootInstanceOrder.set(nextOrder);
    this.saveOrder(nextOrder);
  }

  async onProjectDrop(event: CdkDragDrop<ProjectGroup[]>): Promise<void> {
    if (this.isProjectDragDisabled()) {
      return;
    }

    const draggedGroup = event.item.data as ProjectGroup | undefined;
    if (!draggedGroup || !draggedGroup.path) {
      return;
    }

    const pathGroups = this.getDraggableProjectGroups(this.projectGroups());
    const fromIndex = pathGroups.findIndex(({ group }) => group.key === draggedGroup.key);
    if (fromIndex === -1) {
      return;
    }

    const visiblePathGroups = this.projectGroups()
      .map((group, index) => ({ group, index }))
      .filter(
        (item): item is ProjectPathGroupIndex =>
          !!item.group.path && this.canDragProject(item.group)
      );
    const targetIndex = visiblePathGroups.findIndex(({ index }) => index === event.currentIndex);
    const toIndex = targetIndex === -1 ? pathGroups.length - 1 : targetIndex;

    if (fromIndex === toIndex) {
      return;
    }

    // Ensure all paths are registered in the recent-directories store before
    // reordering. Remote paths may not have been synced yet if the user drags
    // before the background sync effect runs.
    const knownPaths = new Set(
      this.recentDirectories().map((entry) => this.getProjectKey(entry.path))
    );
    const unregistered = pathGroups.filter(
      ({ group }) => !knownPaths.has(group.key)
    );
    if (unregistered.length > 0) {
      await Promise.all(
        unregistered.map(({ group }) => {
          const remoteItem = group.liveItems.find(
            (item) => item.instance.executionLocation?.type === 'remote'
          );
          const remoteLoc = remoteItem?.instance.executionLocation;
          const nodeId =
            remoteLoc?.type === 'remote' ? remoteLoc.nodeId : undefined;
          return this.recentDirectoriesService.addDirectory(
            group.path!,
            nodeId ? { nodeId } : undefined
          );
        })
      );
      await this.loadRecentDirectories();
    }

    const nextOrder = pathGroups.map(({ group }) => group.path!);
    moveItemInArray(nextOrder, fromIndex, toIndex);
    const updated = await this.recentDirectoriesService.reorderDirectories(nextOrder);
    if (updated) {
      await this.loadRecentDirectories();
    }
  }

  async onRestoreHistory(entryId: string): Promise<void> {
    if (this.historyRail.restoringHistoryIds().has(entryId)) {
      return;
    }

    this.closeProjectMenu({ restoreFocus: false });
    this.historyRail.restoringHistoryIds.update((current) => new Set(current).add(entryId));

    try {
      const entry = this.historyStore.entries().find((item) => item.id === entryId);
      const result = await this.historyStore.restoreEntry(entryId, entry?.workingDirectory);
      if (result.success && result.instanceId) {
        if (entry) {
          this.historyRail.markHistoryEntriesSeen([entry]);
        }
        // Populate restored messages into the new instance's output buffer.
        // The instance:created event may carry outputBuffer, but this explicit
        // call acts as a safety net against IPC race conditions (the event
        // fires via webContents.send while the response returns via
        // ipcMain.handle — ordering is not guaranteed).
        if (result.restoredMessages && result.restoredMessages.length > 0) {
          this.store.setInstanceMessages(
            result.instanceId,
            result.restoredMessages as OutputMessage[]
          );
        }
        // Preserve how the session was restored so the UI can adapt
        if (result.restoreMode) {
          this.store.setInstanceRestoreMode(result.instanceId, result.restoreMode);
        }
        this.store.setSelectedInstance(result.instanceId);
      } else if (result.error) {
        console.error('Failed to restore history entry:', result.error);
      }
    } finally {
      this.historyRail.restoringHistoryIds.update((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  }

  async onArchiveHistory(entryId: string, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.closeProjectMenu({ restoreFocus: false });
    await this.historyStore.archiveEntry(entryId);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.openProjectMenuKey()) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.project-menu-anchor')) {
      this.closeProjectMenu({ restoreFocus: false });
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.openProjectMenuKey()) {
      return;
    }

    event.preventDefault();
    this.closeProjectMenu();
  }

  onProjectMenuKeyDown(event: KeyboardEvent): void {
    if (!this.openProjectMenuKey()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeProjectMenu();
      return;
    }

    const items = this.getProjectMenuItems();
    if (items.length === 0) {
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      if (currentIndex === -1) {
        (event.shiftKey ? items[items.length - 1] : items[0])?.focus();
        return;
      }

      const nextIndex = event.shiftKey
        ? (currentIndex - 1 + items.length) % items.length
        : (currentIndex + 1 + items.length) % items.length;
      items[nextIndex]?.focus();
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    event.preventDefault();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex =
      event.key === 'ArrowDown'
        ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  private buildHistoryEntriesByProject(
    entries: ConversationHistoryEntry[],
    filter: string,
    status: string,
    location: 'all' | 'local' | 'remote' = 'all'
  ): Map<string, ConversationHistoryEntry[]> {
    const groups = new Map<string, ConversationHistoryEntry[]>();
    if (status !== 'all') {
      return groups;
    }

    for (const entry of entries) {
      // Location filter: match history entries by their archived executionLocation.
      // Entries without executionLocation are treated as local (pre-remote-node history).
      if (location === 'remote' && entry.executionLocation?.type !== 'remote') {
        continue;
      }
      if (location === 'local' && entry.executionLocation?.type === 'remote') {
        continue;
      }

      const title = this.getProjectTitle(entry.workingDirectory);
      const subtitle = this.getProjectSubtitle(entry.workingDirectory);

      if (
        filter &&
        !this.projectGroupComputation.matchesProjectText(title, subtitle, filter) &&
        !this.projectGroupComputation.matchesHistoryText(entry, filter)
      ) {
        continue;
      }

      const projectKey = this.getProjectKey(entry.workingDirectory);
      const projectEntries = groups.get(projectKey) ?? [];
      projectEntries.push(entry);
      groups.set(projectKey, projectEntries);
    }

    const pinnedIds = this.historyRail.pinnedHistoryIds();
    const sortMode = this.historySortMode();
    for (const projectEntries of groups.values()) {
      projectEntries.sort((left, right) => {
        const leftPinned = pinnedIds.has(left.id);
        const rightPinned = pinnedIds.has(right.id);
        if (leftPinned !== rightPinned) {
          return leftPinned ? -1 : 1;
        }
        return this.historyRail.getHistorySortTimestamp(right, sortMode) - this.historyRail.getHistorySortTimestamp(left, sortMode);
      });

      const dedupedEntries: ConversationHistoryEntry[] = [];
      const seenThreadIds = new Set<string>();

      for (const entry of projectEntries) {
        const dedupeKey = this.historyRail.getHistoryThreadId(entry);
        if (seenThreadIds.has(dedupeKey)) {
          continue;
        }
        seenThreadIds.add(dedupeKey);
        dedupedEntries.push(entry);
      }

      projectEntries.length = 0;
      projectEntries.push(...dedupedEntries);
    }

    return groups;
  }

  private getOrderedRootInstances(instances: Instance[]): Instance[] {
    const orderedRootIds = this.getOrderedRootIds(instances);
    const instanceMap = new Map(instances.map((instance) => [instance.id, instance]));
    return orderedRootIds
      .map((id) => instanceMap.get(id))
      .filter((instance): instance is Instance => !!instance);
  }

  private getOrderedRootIds(instances: Instance[]): string[] {
    const roots = instances.filter((instance) => !instance.parentId);
    const customOrder = this.rootInstanceOrder();

    return [...roots]
      .sort((left, right) => {
        const leftIndex = customOrder.indexOf(left.id);
        const rightIndex = customOrder.indexOf(right.id);

        if (leftIndex !== -1 && rightIndex !== -1) {
          return leftIndex - rightIndex;
        }
        if (leftIndex !== -1) {
          return -1;
        }
        if (rightIndex !== -1) {
          return 1;
        }
        return left.createdAt - right.createdAt;
      })
      .map((instance) => instance.id);
  }

  private getProjectKey(workingDirectory: string | null | undefined): string {
    const normalized = (workingDirectory ?? '').trim();
    return normalized ? normalized.toLowerCase() : NO_WORKSPACE_KEY;
  }

  private getProjectTitle(workingDirectory: string | null | undefined): string {
    const normalized = (workingDirectory ?? '').trim();
    if (!normalized) {
      return 'No workspace';
    }

    const parts = normalized.split(/[/\\]/).filter(Boolean);
    return parts.at(-1) ?? normalized;
  }

  private getProjectSubtitle(workingDirectory: string | null | undefined): string {
    const normalized = (workingDirectory ?? '').trim();
    if (!normalized) {
      return 'Sessions without a working directory';
    }

    return normalized
      .replace(/^\/Users\/[^/]+/, '~')
      .replace(/^\/home\/[^/]+/, '~');
  }

  private loadOrder(): string[] {
    try {
      const saved = localStorage.getItem(ORDER_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  private saveOrder(order: string[]): void {
    try {
      localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
    } catch {
      // Ignore storage errors.
    }
  }

  isRestoringHistory(entryId: string): boolean {
    return this.historyRail.isRestoringHistory(entryId);
  }

  getVisibleHistoryItems(group: ProjectGroup): ConversationHistoryEntry[] {
    return this.historyRail.getVisibleHistoryItems(group);
  }

  toggleHistoryExpanded(key: string): void {
    this.historyRail.toggleHistoryExpanded(key);
  }

  isPinnedHistory(entryId: string): boolean {
    return this.historyRail.isPinnedHistory(entryId);
  }

  togglePinnedHistory(entryId: string, event: Event): void {
    this.historyRail.togglePinnedHistory(entryId, event);
  }

  getHistoryTitle(entry: ConversationHistoryEntry): string {
    return this.historyRail.getHistoryTitle(entry);
  }

  getHistoryPreviewTitle(entry: ConversationHistoryEntry): string {
    return this.historyRail.getHistoryPreviewTitle(entry);
  }

  getHistoryChangeSummary(entry: ConversationHistoryEntry): RailChangeSummary | null {
    return this.historyRail.getHistoryChangeSummary(entry);
  }

  getHistoryProviderVisual(entry: ConversationHistoryEntry): {
    icon: 'anthropic' | 'openai' | 'google' | 'github' | 'generic';
    color: string;
    label: string;
  } {
    return this.historyRail.getHistoryProviderVisual(entry);
  }

  formatRelativeTime(timestamp: number): string {
    return this.historyRail.formatRelativeTime(timestamp);
  }

  formatHistoryTime(entry: ConversationHistoryEntry): string {
    return this.historyRail.formatHistoryTime(entry, this.historySortMode());
  }

  getProjectDraftTitle(group: ProjectGroup): string {
    if (!group.draftUpdatedAt) {
      return 'Draft saved';
    }

    return `Draft updated ${this.formatRelativeTime(group.draftUpdatedAt)} ago`;
  }

  private getLiveRailTitle(
    instance: Instance,
    matchingHistoryEntry?: ConversationHistoryEntry
  ): string {
    // User-set title always takes priority
    if (instance.isRenamed) {
      return instance.displayName;
    }

    // When we have a history entry for this thread, use the same title
    // derivation as history items so the name stays stable across
    // live → history transitions and isn't affected by async auto-titling.
    if (matchingHistoryEntry) {
      return this.historyRail.getHistoryTitle(matchingHistoryEntry);
    }

    return instance.displayName;
  }

  private getLatestHistoryEntriesByThread(
    entries: readonly ConversationHistoryEntry[]
  ): Map<string, ConversationHistoryEntry> {
    const latestEntries = new Map<string, ConversationHistoryEntry>();

    for (const entry of entries) {
      const threadId = this.historyRail.getHistoryThreadId(entry);
      const current = latestEntries.get(threadId);
      if (!current || entry.endedAt > current.endedAt) {
        latestEntries.set(threadId, entry);
      }
    }

    return latestEntries;
  }

  private getInstanceThreadId(
    instance: Pick<Instance, 'historyThreadId' | 'sessionId' | 'id'>
  ): string {
    const historyThreadId = instance.historyThreadId.trim();
    if (historyThreadId) {
      return historyThreadId;
    }

    const sessionId = instance.sessionId.trim();
    if (sessionId) {
      return sessionId;
    }

    return instance.id;
  }

  private async loadRecentDirectories(): Promise<void> {
    const directories = await this.recentDirectoriesService.getDirectories({
      sortBy: 'manual',
    });
    if (this.areRecentDirectoriesEqual(this.recentDirectories(), directories)) {
      return;
    }
    this.recentDirectories.set(directories);
  }

  private async syncRecentDirectories(
    items: readonly { path: string; nodeId?: string }[]
  ): Promise<void> {
    await Promise.all(
      items.map(({ path, nodeId }) =>
        this.recentDirectoriesService.addDirectory(
          path,
          nodeId ? { nodeId } : undefined
        )
      )
    );
    await this.loadRecentDirectories();
  }

  private areRecentDirectoriesEqual(
    left: readonly RecentDirectoryEntry[],
    right: readonly RecentDirectoryEntry[]
  ): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((entry, index) => {
      const candidate = right[index];
      return candidate !== undefined &&
        entry.path === candidate.path &&
        entry.displayName === candidate.displayName &&
        entry.lastAccessed === candidate.lastAccessed &&
        entry.accessCount === candidate.accessCount &&
        entry.isPinned === candidate.isPinned;
    });
  }

  private async ensurePreferredEditorLoaded(): Promise<void> {
    const response = await this.fileIpc.editorGetDefault();
    const editor = response.success && response.data && typeof response.data === 'object'
      ? (response.data as Record<string, unknown>)
      : null;
    const type = typeof editor?.['type'] === 'string' ? editor['type'] : null;
    if (!type) {
      this.preferredEditorLabel.set('Editor');
      return;
    }

    switch (type) {
      case 'vscode':
        this.preferredEditorLabel.set('VS Code');
        break;
      case 'vscode-insiders':
        this.preferredEditorLabel.set('VS Code Insiders');
        break;
      case 'cursor':
        this.preferredEditorLabel.set('Cursor');
        break;
      case 'xcode':
        this.preferredEditorLabel.set('Xcode');
        break;
      case 'android-studio':
        this.preferredEditorLabel.set('Android Studio');
        break;
      default:
        this.preferredEditorLabel.set(type.charAt(0).toUpperCase() + type.slice(1));
    }
  }

  private getSystemFileManagerLabel(): string {
    if (navigator.userAgent.includes('Windows')) {
      return 'Explorer';
    }
    if (navigator.userAgent.includes('Linux')) {
      return 'Files';
    }
    return 'Finder';
  }

  private getProjectSortTimestamp(group: ProjectGroup): number {
    if (this.historySortMode() === 'created') {
      return group.createdAt;
    }

    return group.lastActivity;
  }

  private loadSortMode(): HistorySortMode {
    try {
      const saved = localStorage.getItem(SORT_MODE_STORAGE_KEY);
      return saved === 'created' ? 'created' : 'last-interacted';
    } catch {
      return 'last-interacted';
    }
  }

  private saveSortMode(mode: HistorySortMode): void {
    try {
      localStorage.setItem(SORT_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors.
    }
  }

  canDragProject(group: ProjectGroup): boolean {
    return !this.isProjectDragDisabled() && !!group.path;
  }

  private getDraggableProjectGroups(groups: ProjectGroup[]): ProjectPathGroupIndex[] {
    return groups
      .map((group, index) => ({ group, index }))
      .filter(
        (item): item is ProjectPathGroupIndex =>
          !!item.group.path && this.canDragProject(item.group)
      );
  }

  private closeProjectMenu(options: { restoreFocus?: boolean } = {}): void {
    const restoreFocus = options.restoreFocus ?? true;
    if (!this.openProjectMenuKey()) {
      return;
    }

    this.openProjectMenuKey.set(null);
    if (restoreFocus) {
      this.projectMenuTrigger?.focus();
    }
    this.projectMenuTrigger = null;
  }

  private getProjectMenuItems(): HTMLButtonElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll('.project-menu .project-menu-item'))
      .filter((item): item is HTMLButtonElement => item instanceof HTMLButtonElement);
  }
}
