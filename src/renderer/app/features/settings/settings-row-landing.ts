/** UX4.2 — how long the landing pulse marker stays on the row. */
const SEARCH_LANDING_MS = 1800;
const SEARCH_LANDING_CLASS = 'settings-search-landing';
/**
 * Frames to keep looking for the row. Six is enough for a tab swap plus a
 * couple of advanced disclosures; more would keep fighting for the viewport
 * long after it is clear the row is not coming.
 */
const SEARCH_SCROLL_MAX_FRAMES = 6;

/**
 * Find the row and bring it into view, retrying across a few frames.
 *
 * The retry exists because the tab has only just been swapped in — the row
 * does not exist in the DOM on the frame the click happens. It also opens a
 * collapsed advanced disclosure (S3.2) one per frame, since a row hidden
 * behind one would otherwise be scrolled to and never seen.
 *
 * A real scroll gesture cancels the loop. Fighting a user who has started
 * scrolling is worse than failing to land: they have taken over, and yanking
 * the viewport back is the kind of thing that makes a page feel broken.
 */
export function scrollToSettingRow(host: HTMLElement, key: string): void {
  const selector = `[data-setting-key="${key}"]`;
  let frames = 0;
  let cancelled = false;

  const cancel = (): void => { cancelled = true; };
  window.addEventListener('wheel', cancel, { passive: true });
  window.addEventListener('touchmove', cancel, { passive: true });
  const cleanup = (): void => {
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchmove', cancel);
  };

  const step = (): void => {
    if (cancelled) { cleanup(); return; }

    const row = host.querySelector(selector);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add(SEARCH_LANDING_CLASS);
      // Remove the marker so a second jump to the same row pulses again.
      window.setTimeout(() => row.classList.remove(SEARCH_LANDING_CLASS), SEARCH_LANDING_MS);
      cleanup();
      return;
    }

    // One disclosure per frame: opening them all at once would expand every
    // advanced section on the tab to reveal a row in one of them.
    host.querySelector<HTMLButtonElement>(
      '.settings-tiered-row-list__advanced-toggle[aria-expanded="false"]',
    )?.click();

    if (++frames >= SEARCH_SCROLL_MAX_FRAMES) { cleanup(); return; }
    requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}
