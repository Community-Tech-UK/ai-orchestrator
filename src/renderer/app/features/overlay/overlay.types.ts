import type { Signal, TemplateRef } from '@angular/core';

export interface OverlayItem<T = unknown> {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  badge?: string;
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  keywords?: string[];
  value: T;
}

export interface OverlayGroup<T = unknown> {
  id: string;
  label: string;
  items: OverlayItem<T>[];
}

export interface OverlayController<T = unknown> {
  readonly title: string;
  readonly placeholder: string;
  readonly emptyLabel: string;
  readonly groups: Signal<OverlayGroup<T>[]>;
  readonly query: Signal<string>;
  setQuery(query: string): void;
  run(item: OverlayItem<T>): Promise<boolean> | boolean;
}

export type OverlayItemFooterTemplate<T = unknown> = TemplateRef<{
  $implicit: OverlayItem<T>;
  item: OverlayItem<T>;
}>;
