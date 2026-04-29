import { describe, expect, it } from 'vitest';
import { extractImageReferences } from './image-reference-extractor';

describe('extractImageReferences', () => {
  it('extracts markdown image references', () => {
    expect(
      extractImageReferences('Here is an image: ![diagram](/tmp/foo.png)')
    ).toEqual([
      { kind: 'local', src: '/tmp/foo.png', alt: 'diagram', origin: 'markdown' },
    ]);
  });

  it('extracts bare remote URLs that end in an allowed image extension', () => {
    expect(
      extractImageReferences('Generated asset:\nhttps://cdn.example.com/files/preview.png')
    ).toEqual([
      { kind: 'remote', src: 'https://cdn.example.com/files/preview.png', origin: 'bare' },
    ]);
  });

  it('respects image extension when query string or fragment is present on a bare remote URL', () => {
    expect(
      extractImageReferences([
        'https://cdn.example.com/files/a.png?token=abc',
        'https://cdn.example.com/files/b.jpg#frag',
      ].join('\n'))
    ).toEqual([
      {
        kind: 'remote',
        src: 'https://cdn.example.com/files/a.png?token=abc',
        origin: 'bare',
      },
      {
        kind: 'remote',
        src: 'https://cdn.example.com/files/b.jpg#frag',
        origin: 'bare',
      },
    ]);
  });

  it('does NOT infer non-image bare URLs as images', () => {
    // The regression: a list of doc URLs used to be fetched as images and
    // produced "REMOTE UNSUPPORTED" cards on every assistant message that
    // mentioned them.
    expect(
      extractImageReferences([
        '- https://my.communitytech.co.uk/docs/INTEGRATION_GUIDE.md',
        '- https://my.communitytech.co.uk/docs/WEBHOOK_EVENTS.md',
        '- https://example.com/page.html',
      ].join('\n'))
    ).toEqual([]);
  });

  it('does NOT infer bare extensionless remote URLs as images', () => {
    // Extensionless URLs (e.g. signed CDN URLs) require explicit `![](url)`
    // markdown syntax to render — bare-line inference can't tell them apart
    // from prose links and false positives are too common.
    expect(
      extractImageReferences('https://fal.media/files/cat')
    ).toEqual([]);
  });

  it('keeps markdown image syntax permissive even when the URL is not image-like', () => {
    // Explicit `![](...)` is a deliberate signal from the model — surface
    // the failure downstream instead of silently dropping it.
    expect(
      extractImageReferences('![generated](https://fal.media/files/cat)')
    ).toEqual([
      {
        kind: 'remote',
        src: 'https://fal.media/files/cat',
        alt: 'generated',
        origin: 'markdown',
      },
    ]);
  });

  it('extracts bare local paths from list items', () => {
    expect(
      extractImageReferences('- ~/Desktop/result.webp')
    ).toEqual([
      { kind: 'local', src: '~/Desktop/result.webp', origin: 'bare' },
    ]);
  });

  it('extracts data URIs as bare-origin', () => {
    expect(
      extractImageReferences('data:image/png;base64,Zm9v')
    ).toEqual([
      { kind: 'data', src: 'data:image/png;base64,Zm9v', origin: 'bare' },
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

  it('deduplicates repeated references and prefers markdown origin over bare', () => {
    expect(
      extractImageReferences([
        '![dup](https://example.com/a.png)',
        'https://example.com/a.png',
      ].join('\n'))
    ).toEqual([
      {
        kind: 'remote',
        src: 'https://example.com/a.png',
        alt: 'dup',
        origin: 'markdown',
      },
    ]);
  });

  it('ignores non-HTTP protocols on bare lines', () => {
    expect(
      extractImageReferences('ftp://example.com/file.png')
    ).toEqual([]);
  });
});
