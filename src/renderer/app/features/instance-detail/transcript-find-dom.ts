const FIND_MATCH_CLASS = 'transcript-find-match';
const FIND_ACTIVE_CLASS = 'active';
const SKIPPED_TEXT_SELECTOR = [
  '.transcript-find-bar',
  'button',
  'input',
  'mark.transcript-find-match',
  'script',
  'style',
  'svg',
  'textarea',
].join(',');

export function applyTranscriptFindHighlights(root: HTMLElement, query: string): HTMLElement[] {
  clearTranscriptFindHighlights(root);

  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const textNodes = collectSearchableTextNodes(root);
  const matches: HTMLElement[] = [];

  for (const node of textNodes) {
    wrapTextNodeMatches(node, needle, matches);
  }

  return matches;
}

export function clearTranscriptFindHighlights(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll<HTMLElement>(`mark.${FIND_MATCH_CLASS}`));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) {
      continue;
    }
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }
}

export function setActiveTranscriptFindMatch(
  matches: readonly HTMLElement[],
  activeIndex: number,
): void {
  matches.forEach((match, index) => {
    match.classList.toggle(FIND_ACTIVE_CLASS, index === activeIndex);
  });
}

function collectSearchableTextNodes(root: HTMLElement): Text[] {
  const win = root.ownerDocument.defaultView;
  if (!win) {
    return [];
  }

  const textNodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(
    root,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!node.nodeValue?.trim()) {
          return win.NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIPPED_TEXT_SELECTOR)) {
          return win.NodeFilter.FILTER_REJECT;
        }
        return win.NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }

  return textNodes;
}

function wrapTextNodeMatches(node: Text, needle: string, matches: HTMLElement[]): void {
  const text = node.nodeValue ?? '';
  const lowerText = text.toLowerCase();
  const ranges: { start: number; end: number }[] = [];
  let fromIndex = 0;

  while (fromIndex < lowerText.length) {
    const start = lowerText.indexOf(needle, fromIndex);
    if (start === -1) {
      break;
    }
    const end = start + needle.length;
    ranges.push({ start, end });
    fromIndex = end;
  }

  if (ranges.length === 0) {
    return;
  }

  const document = node.ownerDocument;
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, range.start)));
    }

    const mark = document.createElement('mark');
    mark.classList.add(FIND_MATCH_CLASS);
    mark.textContent = text.slice(range.start, range.end);
    fragment.appendChild(mark);
    matches.push(mark);
    cursor = range.end;
  }

  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)));
  }

  node.parentNode?.replaceChild(fragment, node);
}
