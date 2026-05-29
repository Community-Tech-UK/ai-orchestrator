/**
 * Local types for the OutputStreamComponent.
 * Kept in a sibling module to limit the main component file's size.
 */

import type { MarkdownService } from '../../core/services/markdown.service';
import type { DisplayItem } from './display-item-processor.service';

export type RenderedMarkdown = ReturnType<MarkdownService['render']>;

/** Narrows DisplayItem's `unknown` rendered fields to RenderedMarkdown for template type safety */
export interface RenderedDisplayItem extends DisplayItem {
  renderedMessage?: RenderedMarkdown;
  renderedResponse?: RenderedMarkdown;
}

export interface LinkedFileTarget {
  rawPath: string;
  resolvedPath: string;
  displayPath: string;
  canUseLocalFileActions: boolean;
}
