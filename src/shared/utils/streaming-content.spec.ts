import { describe, expect, it } from 'vitest';
import { nextMonotonicStreamingContent } from './streaming-content';

describe('nextMonotonicStreamingContent', () => {
  it('keeps committed text when a later chunk is empty', () => {
    expect(nextMonotonicStreamingContent('first segment of the deliverable', '')).toBe(
      'first segment of the deliverable',
    );
  });

  it('keeps committed text when a later chunk rewinds to a shorter snapshot', () => {
    expect(
      nextMonotonicStreamingContent(
        "I'll check those attached todo files and whether a single de-duplicated merge already exists.",
        "I'll",
      ),
    ).toBe(
      "I'll check those attached todo files and whether a single de-duplicated merge already exists.",
    );
  });

  it('accepts growth and the first non-empty chunk', () => {
    expect(nextMonotonicStreamingContent('', "I'll")).toBe("I'll");
    expect(nextMonotonicStreamingContent("I'll", "I'll check")).toBe("I'll check");
  });
});
