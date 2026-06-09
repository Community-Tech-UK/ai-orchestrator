import { signal } from '@angular/core';

import {
  applyTranscriptFindHighlights,
  clearTranscriptFindHighlights,
  setActiveTranscriptFindMatch,
} from './transcript-find-dom';
import { loadOlderUntilFindMatch } from './transcript-find-load';

export interface TranscriptFindControllerDeps {
  getViewportElement: () => HTMLElement | null;
  hasOlderMessages: () => boolean;
  loadOlderMessages: () => Promise<void>;
}

export class TranscriptFindController {
  readonly isOpen = signal(false);
  readonly query = signal('');
  readonly matchCount = signal(0);
  readonly activeIndex = signal(-1);
  readonly loadingOlder = signal(false);

  private matches: HTMLElement[] = [];
  private searchTimer: number | null = null;
  private searchVersion = 0;

  constructor(private readonly deps: TranscriptFindControllerDeps) {}

  openFind(): void {
    this.isOpen.set(true);
    if (this.query().trim()) {
      this.scheduleFind(true);
    }
  }

  closeFind(): void {
    this.isOpen.set(false);
    this.searchVersion += 1;
    this.clearSearchTimer();
    this.clearMatches();
  }

  setQuery(query: string): void {
    this.query.set(query);
    this.activeIndex.set(-1);
    this.scheduleFind(true);
  }

  async nextMatch(): Promise<void> {
    const currentQuery = this.query();
    if (!currentQuery.trim()) {
      return;
    }
    if (this.matches.length === 0) {
      this.scheduleFind(true);
      return;
    }

    const activeIndex = this.activeIndex();
    if (activeIndex >= this.matches.length - 1 && this.deps.hasOlderMessages()) {
      const initialCount = this.matches.length;
      const version = ++this.searchVersion;
      const loadedOlderMatch = await this.loadOlderUntilMatchCountExceeds(
        currentQuery,
        version,
        initialCount,
      );
      if (loadedOlderMatch) {
        this.activateMatch(0, true);
        return;
      }
    }

    this.activateMatch(this.activeIndex() + 1, true);
  }

  async previousMatch(): Promise<void> {
    const currentQuery = this.query();
    if (!currentQuery.trim()) {
      return;
    }
    if (this.matches.length === 0) {
      this.scheduleFind(true);
      return;
    }

    const activeIndex = this.activeIndex();
    if (activeIndex <= 0 && this.deps.hasOlderMessages()) {
      const initialCount = this.matches.length;
      const version = ++this.searchVersion;
      const loadedOlderMatch = await this.loadOlderUntilMatchCountExceeds(
        currentQuery,
        version,
        initialCount,
      );
      if (loadedOlderMatch) {
        this.activateMatch(this.matches.length - initialCount - 1, true);
        return;
      }
    }

    this.activateMatch(this.activeIndex() - 1, true);
  }

  reapplyAfterRender(): void {
    const currentQuery = this.query();
    if (!this.isOpen() || !currentQuery.trim()) {
      return;
    }
    const version = this.searchVersion;
    setTimeout(() => {
      void this.applyFind(currentQuery, version, {
        loadOlderIfEmpty: false,
        preserveActive: true,
        scrollActive: false,
      });
    });
  }

  destroy(): void {
    this.clearSearchTimer();
    this.clearMatches();
  }

  private scheduleFind(loadOlderIfEmpty: boolean): void {
    this.clearSearchTimer();
    const currentQuery = this.query();
    const version = ++this.searchVersion;
    if (!currentQuery.trim()) {
      this.clearMatches();
      return;
    }

    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.applyFind(currentQuery, version, {
        loadOlderIfEmpty,
        preserveActive: false,
        scrollActive: true,
      });
    }, 80);
  }

  private async applyFind(
    query: string,
    version: number,
    options: {
      loadOlderIfEmpty: boolean;
      preserveActive: boolean;
      scrollActive: boolean;
    },
  ): Promise<void> {
    await this.waitForRender();
    if (!this.isCurrentSearch(version, query)) {
      return;
    }

    this.refreshMatches(query, options.preserveActive);
    if (options.loadOlderIfEmpty && this.matches.length === 0 && this.deps.hasOlderMessages()) {
      await this.loadOlderUntilMatchCountExceeds(query, version, 0);
    }

    if (this.isCurrentSearch(version, query) && options.scrollActive && this.matches.length > 0) {
      this.activateMatch(Math.max(0, this.activeIndex()), true);
    }
  }

  private refreshMatches(query: string, preserveActive: boolean): void {
    const viewport = this.deps.getViewportElement();
    if (!viewport) {
      this.matches = [];
      this.matchCount.set(0);
      this.activeIndex.set(-1);
      return;
    }

    const previousActive = preserveActive ? this.activeIndex() : 0;
    this.matches = applyTranscriptFindHighlights(viewport, query);
    this.matchCount.set(this.matches.length);

    const nextActive = this.matches.length === 0
      ? -1
      : Math.min(Math.max(previousActive, 0), this.matches.length - 1);
    this.activeIndex.set(nextActive);
    setActiveTranscriptFindMatch(this.matches, nextActive);
  }

  private async loadOlderUntilMatchCountExceeds(
    query: string,
    version: number,
    initialCount: number,
  ): Promise<boolean> {
    if (!this.isCurrentSearch(version, query)) {
      return false;
    }

    this.loadingOlder.set(true);
    try {
      await loadOlderUntilFindMatch({
        hasMatches: () => this.matches.length > initialCount,
        hasOlderMessages: this.deps.hasOlderMessages,
        loadOlderMessages: this.deps.loadOlderMessages,
        afterLoad: async () => {
          await this.waitForRender();
          if (this.isCurrentSearch(version, query)) {
            this.refreshMatches(query, false);
          }
        },
      });
    } finally {
      if (this.isCurrentSearch(version, query)) {
        this.loadingOlder.set(false);
      }
    }

    return this.isCurrentSearch(version, query) && this.matches.length > initialCount;
  }

  private activateMatch(index: number, scroll: boolean): void {
    if (this.matches.length === 0) {
      this.activeIndex.set(-1);
      return;
    }

    const normalizedIndex = ((index % this.matches.length) + this.matches.length) % this.matches.length;
    this.activeIndex.set(normalizedIndex);
    setActiveTranscriptFindMatch(this.matches, normalizedIndex);

    if (scroll) {
      this.matches[normalizedIndex].scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    }
  }

  private clearMatches(): void {
    const viewport = this.deps.getViewportElement();
    if (viewport) {
      clearTranscriptFindHighlights(viewport);
    }
    this.matches = [];
    this.matchCount.set(0);
    this.activeIndex.set(-1);
    this.loadingOlder.set(false);
  }

  private clearSearchTimer(): void {
    if (this.searchTimer === null) {
      return;
    }
    window.clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  private isCurrentSearch(version: number, query: string): boolean {
    return this.isOpen() && this.query() === query && this.searchVersion === version;
  }

  private async waitForRender(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
