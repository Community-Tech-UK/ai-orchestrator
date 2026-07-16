import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';

import { MarkdownService } from './markdown.service';
import {
  CLIPBOARD_SERVICE,
  type ClipboardCopyResult,
  type ClipboardService,
} from './clipboard.service';

describe('MarkdownService.renderSync command stripping', () => {
  let service: MarkdownService;
  let clipboard: ClipboardService;

  beforeEach(() => {
    clipboard = {
      lastResult: signal<ClipboardCopyResult | null>(null).asReadonly(),
      copyText: vi.fn().mockResolvedValue({ ok: true }),
      copyJSON: vi.fn().mockResolvedValue({ ok: true }),
      copyImage: vi.fn().mockResolvedValue({ ok: true }),
      copyMessage: vi.fn().mockResolvedValue({ ok: true }),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: CLIPBOARD_SERVICE, useValue: clipboard }],
    });
    service = TestBed.inject(MarkdownService);
  });

  it('renders normal markdown in surrounding paragraphs', () => {
    const html = service.renderSync('hello **world**');
    expect(html).toContain('<strong>world</strong>');
  });

  it('preserves literal tildes used for approximate values', () => {
    const html = service.renderSync(
      'Total alloc was 2.0 TB pre-fix -> ~0.5 TB post-fix at ~170 players, this is the first look at ~250-player peak), FancyHolograms~(1 GB expected).',
    );

    expect(html).not.toContain('<del>');
    expect(html).not.toContain('<s>');
    expect(html).toContain('~0.5 TB');
    expect(html).toContain('~170 players');
    expect(html).toContain('~250-player peak');
    expect(html).toContain('FancyHolograms~');
  });

  it('keeps double-tilde strikethrough support', () => {
    const html = service.renderSync('Use ~~removed~~ only when deletion is intentional.');

    expect(html).toContain('<del>removed</del>');
  });

  it('removes orchestrator command blocks from rendered output', () => {
    const markdown = [
      'before the command',
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"get_children"}',
      ':::END_COMMAND:::',
      'after the command',
    ].join('\n');

    const html = service.renderSync(markdown);

    expect(html).not.toContain('ORCHESTRATOR_COMMAND');
    expect(html).not.toContain('END_COMMAND');
    expect(html).not.toContain('"action":"get_children"');
    expect(html).toContain('before the command');
    expect(html).toContain('after the command');
  });

  it('removes multiple command blocks in a single message', () => {
    const markdown = [
      'lead',
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"get_children"}',
      ':::END_COMMAND:::',
      'middle',
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"terminate_child","childId":"c1"}',
      ':::END_COMMAND:::',
      'tail',
    ].join('\n');

    const html = service.renderSync(markdown);

    expect(html).not.toContain('ORCHESTRATOR_COMMAND');
    expect(html).not.toContain('terminate_child');
    expect(html).toContain('lead');
    expect(html).toContain('middle');
    expect(html).toContain('tail');
  });

  it('removes orchestrator response blocks', () => {
    const markdown = [
      'preamble',
      '[Orchestrator Response]',
      'Action: get_children',
      'Status: SUCCESS',
      '[/Orchestrator Response]',
      'postamble',
    ].join('\n');

    const html = service.renderSync(markdown);

    expect(html).not.toContain('[Orchestrator Response]');
    expect(html).not.toContain('[/Orchestrator Response]');
    expect(html).toContain('preamble');
    expect(html).toContain('postamble');
  });

  it('returns an empty string for empty input', () => {
    expect(service.renderSync('')).toBe('');
  });

  it('marks Unix, Windows, UNC, and relative codespan paths as file paths', () => {
    expect(service.renderSync('`/Users/foo/bar.ts`')).toContain('data-file-path="/Users/foo/bar.ts"');
    expect(service.renderSync('`C:\\Users\\foo\\bar.ts`')).toContain('data-file-path="C:\\Users\\foo\\bar.ts"');
    expect(service.renderSync('`\\\\server\\share\\file.txt`')).toContain('class="inline-code file-path"');
    expect(service.renderSync('`./src/foo.ts`')).toContain('data-file-path="./src/foo.ts"');
  });

  it('uses the file path without line and column suffixes for file actions', () => {
    const html = service.renderSync('`src/app.ts:42:7`');

    expect(html).toContain('data-file-path="src/app.ts"');
    expect(html).toContain('data-file-display-path="src/app.ts:42:7"');
    expect(html).toContain('data-file-line="42"');
    expect(html).toContain('data-file-column="7"');
  });

  it('marks markdown links that point to files as file paths', () => {
    const html = service.renderSync('[myplan.md](myplan.md)');

    expect(html).toContain('class="file-path"');
    expect(html).toContain('data-file-path="myplan.md"');
    expect(html).toContain('href="myplan.md"');
  });

  it('does not mark plain codespan text as a file path', () => {
    expect(service.renderSync('`hello`')).not.toContain('data-file-path');
  });

  it('preserves the start attribute on ordered lists that do not begin at 1', () => {
    // Regression: typing "2) do this" was rendering as "1. do this" because
    // DOMPurify stripped the `start="2"` that marked emitted on the <ol>.
    const html = service.renderSync('2) do this, and do this properly and thoroughly');

    expect(html).toMatch(/<ol[^>]*\sstart="2"/);
    expect(html).toContain('do this, and do this properly and thoroughly');
  });

  it('preserves the start attribute when an ordered list starts with a dot', () => {
    const html = service.renderSync('5. pick option five');
    expect(html).toMatch(/<ol[^>]*\sstart="5"/);
  });

  it('preserves non-sequential written numbers on ordered list items', () => {
    // Regression: replying to numbered questions with "2) ok\n4) why..." was
    // rendered as "2. ok / 3. why..." because CommonMark renumbers items
    // sequentially from the first marker, discarding the written numbers.
    const html = service.renderSync('2) ok\n4) Why not just paste in the rewrite?');

    expect(html).toMatch(/<ol[^>]*\sstart="2"/);
    expect(html).toMatch(/<li value="2">/);
    expect(html).toMatch(/<li value="4">/);
  });

  it('does not add value attributes to sequentially numbered lists', () => {
    const html = service.renderSync('2. first\n3. second\n4. third');

    expect(html).toMatch(/<ol[^>]*\sstart="2"/);
    expect(html).not.toContain('value=');
  });

  it('keeps lazy all-same numbering ("1. / 1. / 1.") sequential', () => {
    const html = service.renderSync('1. first\n1. second\n1. third');

    expect(html).not.toContain('value=');
    expect(html).toContain('<ol>');
  });

  it('does not add a start attribute for lists that begin at 1', () => {
    const html = service.renderSync('1. first\n2. second');
    // marked omits start="1" for lists beginning at 1; just confirm the items
    // render and we don't accidentally inject a stray start attribute.
    expect(html).toContain('<ol>');
    expect(html).toContain('first');
    expect(html).toContain('second');
  });

  it('formats streamed assistant text before rendering markdown', () => {
    const html = service.renderSync(
      "I'll read the plan. Now let me explore `loop-coordinator.ts`:Now add imports.",
    );

    expect(html).toContain('loop-coordinator.ts');
    expect(html).toContain('Now add imports');
    expect(html).toMatch(/plan\.|<br>|Now let me/);
  });

  it('uses ClipboardService for code-block copy buttons', async () => {
    document.body.innerHTML = [
      '<button data-copy-id="copy-1">Copy</button>',
      '<pre data-code-id="copy-1"><code>const x = 1;</code></pre>',
    ].join('');

    await service.handleCopyClick('copy-1');

    expect(clipboard.copyText).toHaveBeenCalledWith('const x = 1;', { label: 'code' });
    document.body.innerHTML = '';
  });
});

describe('MarkdownService block-memoized rendering', () => {
  let service: MarkdownService;

  beforeEach(() => {
    const clipboard: ClipboardService = {
      lastResult: signal<ClipboardCopyResult | null>(null).asReadonly(),
      copyText: vi.fn().mockResolvedValue({ ok: true }),
      copyJSON: vi.fn().mockResolvedValue({ ok: true }),
      copyImage: vi.fn().mockResolvedValue({ ok: true }),
      copyMessage: vi.fn().mockResolvedValue({ ok: true }),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: CLIPBOARD_SERVICE, useValue: clipboard }],
    });
    service = TestBed.inject(MarkdownService);
  });

  it('renders every block of a multi-block document', () => {
    const md = [
      '# Heading',
      '',
      'A paragraph with **bold** text.',
      '',
      '- item one',
      '- item two',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');

    const html = service.renderSync(md);

    expect(html).toContain('Heading');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('item one');
    expect(html).toContain('item two');
    expect(html).toContain('const x = 1;');
    expect(html).toContain('code-block-wrapper');
  });

  it('produces identical HTML for a block whether or not later blocks are appended', () => {
    // The memoized first block must render the same as when parsed standalone —
    // this guards against block-splitting changing a block's output.
    const first = service.renderSync('First paragraph.');
    const grown = service.renderSync('First paragraph.\n\nSecond paragraph.');

    expect(first).toContain('First paragraph.');
    expect(grown).toContain('First paragraph.');
    expect(grown).toContain('Second paragraph.');
    // The rendered <p> for the first paragraph is byte-identical in both.
    expect(grown).toContain(first.trim());
  });

  it('reuses cached block HTML across streaming growth (only the tail re-parses)', () => {
    const lexSpy = vi.spyOn(marked, 'parser');

    service.renderSync('# Stable title\n\nStable body.\n\nTail v1');
    const callsAfterFirst = lexSpy.mock.calls.length;

    // Grow only the final block; the two leading blocks must come from cache.
    service.renderSync('# Stable title\n\nStable body.\n\nTail v2 with more text');
    const callsAfterSecond = lexSpy.mock.calls.length - callsAfterFirst;

    // Second render parses strictly fewer blocks than the 3 it contains,
    // because the stable leading blocks are served from the cache.
    expect(callsAfterSecond).toBeLessThan(3);
    expect(callsAfterSecond).toBeGreaterThan(0);

    lexSpy.mockRestore();
  });

  it('resolves reference-style links via the whole-document fallback path', () => {
    const md = 'See [the docs][1] for details.\n\n[1]: https://example.com/docs';
    const html = service.renderSync(md);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('the docs');
  });

  it('renders a still-open (streaming) code fence without corrupting earlier blocks', () => {
    const md = '# Title\n\nIntro paragraph.\n\n```ts\nconst partial = ';
    const html = service.renderSync(md);
    expect(html).toContain('Title');
    expect(html).toContain('Intro paragraph.');
    expect(html).toContain('const partial =');
  });
});
