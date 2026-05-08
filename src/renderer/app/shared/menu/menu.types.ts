/**
 * Generic nested-menu data shapes consumed by `<app-nested-menu>`.
 *
 * The primitive is stateless — selection lives in the consumer. Pass a
 * `MenuModel<T>` describing what to render and listen for `select` events.
 *
 * Rendering rules:
 *   - Sections without a `label` render as a header-less group (used by the
 *     compact model picker's "Latest" section at the top of the menu).
 *   - A divider is rendered between consecutive sections.
 *   - Items with `disabledReason` stay focusable for screen-reader access
 *     and surface the reason as a `title` tooltip.
 *   - Items with `submenu` render a chevron and open the submenu on
 *     hover (after 120ms) or `→` / `Enter` / chevron click.
 *   - `payload` is an opaque user-typed handle returned to the consumer
 *     in the `select` event so they can map menu IDs to domain data.
 */

export interface MenuItem<T = unknown> {
  id: string;
  label: string;
  selected?: boolean;
  disabledReason?: string;
  submenu?: MenuModel<T>;
  payload?: T;
}

export interface MenuSection<T = unknown> {
  id: string;
  label?: string;
  items: MenuItem<T>[];
}

export interface MenuModel<T = unknown> {
  sections: MenuSection<T>[];
  /**
   * Rendered as a single non-interactive row when the model has no items.
   * Used by Cursor's "Other versions" submenu when no additional models
   * have been discovered yet.
   */
  emptyStateLabel?: string;
}
