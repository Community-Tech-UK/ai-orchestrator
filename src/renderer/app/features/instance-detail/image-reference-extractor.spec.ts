import { describe, expect, it } from 'vitest';
import { extractImageReferences } from './image-reference-extractor';

describe('extractImageReferences', () => {
  it('extracts markdown image references', () => {
    expect(
      extractImageReferences('Here is an image: ![diagram](/tmp/foo.png)')
    ).toEqual([
      { kind: 'local', src: '/tmp/foo.png', alt: 'diagram' },
    ]);
  });

  it('extracts bare remote URLs on their own line', () => {
    expect(
      extractImageReferences('Generated asset:\nhttps://fal.media/files/cat')
    ).toEqual([
      { kind: 'remote', src: 'https://fal.media/files/cat' },
    ]);
  });

  it('extracts bare local paths from list items', () => {
    expect(
      extractImageReferences('- ~/Desktop/result.webp')
    ).toEqual([
      { kind: 'local', src: '~/Desktop/result.webp' },
    ]);
  });

  it('extracts data URIs', () => {
    expect(
      extractImageReferences('data:image/png;base64,Zm9v')
    ).toEqual([
      { kind: 'data', src: 'data:image/png;base64,Zm9v' },
    ]);
  });

  it('ignores image-like strings inside code fences and inline code', () => {
    expect(
      extractImageReferences([
        '```md',
        '![ignored](/tmp/ignored.png)',
        '```',
        'Use `https://example.com/test.png` instead.',
      ].join('\n'))
    ).toEqual([]);
  });

  it('deduplicates repeated references', () => {
    expect(
      extractImageReferences([
        '![dup](https://example.com/a.png)',
        'https://example.com/a.png',
      ].join('\n'))
    ).toEqual([
      { kind: 'remote', src: 'https://example.com/a.png', alt: 'dup' },
    ]);
  });
});
