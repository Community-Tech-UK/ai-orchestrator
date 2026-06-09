import { describe, expect, it } from 'vitest';

import {
  applyTranscriptFindHighlights,
  clearTranscriptFindHighlights,
  setActiveTranscriptFindMatch,
} from './transcript-find-dom';

describe('transcript find DOM highlighting', () => {
  it('highlights case-insensitive matches while preserving the original text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>Send queue and send Queue are related.</p>';

    const matches = applyTranscriptFindHighlights(root, 'send queue');

    expect(matches).toHaveLength(2);
    expect(root.querySelectorAll('mark.transcript-find-match')).toHaveLength(2);
    expect(matches.map((match) => match.textContent)).toEqual(['Send queue', 'send Queue']);
  });

  it('clears old highlights without changing the readable transcript text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>RTT spike and RTT recovery</p>';

    applyTranscriptFindHighlights(root, 'RTT');
    clearTranscriptFindHighlights(root);

    expect(root.querySelector('mark.transcript-find-match')).toBeNull();
    expect(root.textContent).toBe('RTT spike and RTT recovery');
  });

  it('marks only one active match at a time', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>softnet softnet softnet</p>';
    const matches = applyTranscriptFindHighlights(root, 'softnet');

    setActiveTranscriptFindMatch(matches, 1);

    expect(matches.map((match) => match.classList.contains('active'))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('does not highlight text inside transcript find controls', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="transcript-find-bar">
        <button>sendq</button>
      </div>
      <p>sendq_backlogged</p>
    `;

    const matches = applyTranscriptFindHighlights(root, 'sendq');

    expect(matches).toHaveLength(1);
    expect(matches[0].textContent).toBe('sendq');
    expect(root.querySelector('.transcript-find-bar mark')).toBeNull();
  });
});
