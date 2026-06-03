import type {
  HistoryTimeWindow,
  HistoryVisibilityMode,
} from './history-rail-filtering';
import {
  FILTER_TEXT_STORAGE_KEY,
  HISTORY_TIME_WINDOW_STORAGE_KEY,
  HISTORY_VISIBILITY_STORAGE_KEY,
  LOCATION_FILTER_STORAGE_KEY,
  ORDER_STORAGE_KEY,
  SHOW_EMPTY_PROJECTS_STORAGE_KEY,
  SORT_MODE_STORAGE_KEY,
  STATUS_FILTER_STORAGE_KEY,
  type HistorySortMode,
} from './instance-list.types';

export function loadOrder(): string[] {
  try {
    const saved = localStorage.getItem(ORDER_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function saveOrder(order: string[]): void {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ignore storage errors.
  }
}

export function loadSortMode(): HistorySortMode {
  try {
    const saved = localStorage.getItem(SORT_MODE_STORAGE_KEY);
    return saved === 'created' ? 'created' : 'last-interacted';
  } catch {
    return 'last-interacted';
  }
}

export function saveSortMode(mode: HistorySortMode): void {
  try {
    localStorage.setItem(SORT_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors.
  }
}

export function loadHistoryVisibilityMode(): HistoryVisibilityMode {
  try {
    const saved = localStorage.getItem(HISTORY_VISIBILITY_STORAGE_KEY);
    return saved === 'all' ? 'all' : 'relevant';
  } catch {
    return 'relevant';
  }
}

export function saveHistoryVisibilityMode(mode: HistoryVisibilityMode): void {
  try {
    localStorage.setItem(HISTORY_VISIBILITY_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors.
  }
}

export function parseHistoryTimeWindow(value: string | null): HistoryTimeWindow {
  switch (value) {
    case 'day':
    case '3-days':
    case 'week':
    case '2-weeks':
    case 'month':
      return value;
    default:
      return 'all';
  }
}

export function loadHistoryTimeWindow(): HistoryTimeWindow {
  try {
    return parseHistoryTimeWindow(localStorage.getItem(HISTORY_TIME_WINDOW_STORAGE_KEY));
  } catch {
    return 'all';
  }
}

export function saveHistoryTimeWindow(mode: HistoryTimeWindow): void {
  try {
    localStorage.setItem(HISTORY_TIME_WINDOW_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors.
  }
}

export function loadShowEmptyProjects(): boolean {
  try {
    return localStorage.getItem(SHOW_EMPTY_PROJECTS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveShowEmptyProjects(value: boolean): void {
  try {
    localStorage.setItem(SHOW_EMPTY_PROJECTS_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Ignore storage errors.
  }
}

export function loadStatusFilter(): string {
  try {
    return localStorage.getItem(STATUS_FILTER_STORAGE_KEY) === 'active' ? 'active' : 'all';
  } catch {
    return 'all';
  }
}

export function saveStatusFilter(value: string): void {
  try {
    localStorage.setItem(STATUS_FILTER_STORAGE_KEY, value);
  } catch {
    // Ignore storage errors.
  }
}

export function loadLocationFilter(): 'all' | 'local' | 'remote' {
  try {
    const saved = localStorage.getItem(LOCATION_FILTER_STORAGE_KEY);
    return saved === 'local' || saved === 'remote' ? saved : 'all';
  } catch {
    return 'all';
  }
}

export function saveLocationFilter(value: 'all' | 'local' | 'remote'): void {
  try {
    localStorage.setItem(LOCATION_FILTER_STORAGE_KEY, value);
  } catch {
    // Ignore storage errors.
  }
}

export function loadFilterText(): string {
  try {
    return localStorage.getItem(FILTER_TEXT_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveFilterText(value: string): void {
  try {
    if (value) {
      localStorage.setItem(FILTER_TEXT_STORAGE_KEY, value);
    } else {
      localStorage.removeItem(FILTER_TEXT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
}
