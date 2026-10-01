import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { marked, Marked, Tokenizer } from 'marked';

import { MarkdownService } from './markdown.service';
import { codexFollowupExtension, transformTextWithFollowups } from './codex-followup-markdown';
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

  it('renders the reported follow-up list as labelled copy buttons', () => {
    const content = [
      'Both requests are achievable.',
      '',
      '- :codex-followup[Draft a reply]{prompt="Draft a reply. Do not send it."}',
      '- :codex-followup[Implement the additions]{prompt="Implement and verify the additions."}',
      '- :codex-followup[Prepare the HR data request]{prompt="Prepare the HR checklist."}',
    ].join('\n');
    const container = document.createElement('div');
    container.innerHTML = service.renderSync(content);
    const buttons = Array.from(container.querySelectorAll('button'));

    expect(container.textContent).toContain('Both requests are achievable.');
    expect(container.textContent).not.toContain('codex-followup');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Draft a reply', 'Implement the additions', 'Prepare the HR data request',
    ]);
    expect(buttons.map((button) => JSON.parse(button.dataset['followupPrompt']!))).toEqual([
      'Draft a reply. Do not send it.', 'Implement and verify the additions.', 'Prepare the HR checklist.',
    ]);
    expect(buttons.every((button) => button.type === 'button')).toBe(true);
    expect(buttons[0].getAttribute('aria-label')).toBe('Copy follow-up prompt: Draft a reply');
  });

  it('preserves escaped and narration-like prompt text exactly', () => {
    const prompt = 'Check types:Now fix it. Next validate "quotes", {braces}, C:\\drafts, &amp; and\na new line.';
    const container = document.createElement('div');
    container.innerHTML = service.renderSync(`::codex-followup[Check \\] details]{prompt=${JSON.stringify(prompt)}}`);

    expect(JSON.parse(container.querySelector('button')!.dataset['followupPrompt']!)).toBe(prompt);
    expect(container.querySelector('button')?.textContent).toBe('Check ] details');
  });

  it('escapes HTML in follow-up labels and prompt attributes', () => {
    const prompt = '"><img src=x onerror="alert(1)">';
    const container = document.createElement('div');
    container.innerHTML = service.renderSync(`:codex-followup[<img src=x onerror=alert(1)>]{prompt=${JSON.stringify(prompt)}}`);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(JSON.parse(container.querySelector('button')!.dataset['followupPrompt']!)).toBe(prompt);
    expect(container.querySelector('button')?.getAttribute('onerror')).toBeNull();
  });

  it('keeps directives literal in inline and fenced code examples', () => {
    const directive = ':codex-followup[Example]{prompt="An example"}';
    const html = service.renderSync(`\`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``);

    expect(html).not.toContain('data-followup-prompt');
    expect(html).toContain('codex-followup');
  });

  it('leaves malformed or empty directives visible and completes a streaming tail', () => {
    for (const content of [
      ':codex-followup[Draft]{prompt="unfinished',
      ':codex-followup[Draft]{prompt="invalid\\q"}',
      ':codex-followup[outer [inner]{prompt="text"}',
      ':codex-followup[Draft]{prompt=""}',
      ':codex-followup[ ]{prompt="text"}',
    ]) {
      const html = service.renderSync(content);
      expect(html).not.toContain('data-followup-prompt');
      expect(html).toContain('codex-followup');
    }
    const container = document.createElement('div');
    container.innerHTML = service.renderSync(':codex-followup[Draft]{prompt="finished"}');
    expect(JSON.parse(container.querySelector('button')!.dataset['followupPrompt']!)).toBe('finished');
  });

  it('copies the prompt through ClipboardService and records success or failure on the control', async () => {
    const container = document.createElement('div');
    container.innerHTML = service.renderSync(':codex-followup[Draft]{prompt="Write the reply."}');
    const button = container.querySelector('button')!;

    await service.handleFollowupClick(button);
    expect(clipboard.copyText).toHaveBeenCalledWith('Write the reply.', { label: 'follow-up prompt' });
    expect(button.classList.contains('copied')).toBe(true);

    vi.mocked(clipboard.copyText).mockResolvedValueOnce({ ok: false, reason: 'permission-denied' });
    await service.handleFollowupClick(button);
    expect(button.classList.contains('copied')).toBe(false);
    expect(button.title).toContain('retry');
  });

  it.each([
    'Keep [Orchestrator Response]this[/Orchestrator Response] exactly',
    'Keep :::ORCHESTRATOR_COMMAND::: this :::END_COMMAND::: exactly',
    'x\r\ny',
    'literal\u0000null',
    'unpaired\ud800character',
  ])('copies the complete original payload %j', async (prompt) => {
    const container = document.createElement('div');
    container.innerHTML = service.renderSync(`:codex-followup[Copy]{prompt=${JSON.stringify(prompt)}}`);
    const button = container.querySelector('button')!;
    await service.handleFollowupClick(button);
    expect(clipboard.copyText).toHaveBeenCalledExactlyOnceWith(prompt, { label: 'follow-up prompt' });
  });

  it('renders follow-ups and other inline markdown in table headers and cells', () => {
    const container = document.createElement('div');
    container.innerHTML = service.renderSync([
      '| **Options** :codex-followup[Header]{prompt="Header choice"} |',
      '| --- |',
      '| :codex-followup[Draft]{prompt="Body choice"} [docs](https://example.com) |',
    ].join('\n'));
    expect(container.querySelector('th strong')?.textContent).toBe('Options');
    expect(container.querySelector('th button')?.textContent).toBe('Header');
    expect(container.querySelector('td button')?.textContent).toBe('Draft');
    expect(container.querySelector('td a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.textContent).not.toContain('codex-followup');
  });

  it.each(['not JSON', '42', 'null', '[]', '""'])('rejects invalid copied-prompt data %j', async (encoded) => {
    const button = document.createElement('button');
    button.setAttribute('data-followup-prompt', encoded);
    await service.handleFollowupClick(button);
    expect(clipboard.copyText).not.toHaveBeenCalled();
    expect(button.title).toBe('Invalid follow-up prompt');
  });

  it('strips enclosing command blocks while preserving spaces and authored placeholder-like text', () => {
    const literal = '\uE000codex-followup-0:0\uE001';
    const html = service.renderSync([
      ':::ORCHESTRATOR_COMMAND:::',
      ':codex-followup[Hidden]{prompt="Hidden choice"}',
      ':::END_COMMAND:::',
      `Pick ${literal} :codex-followup[Visible]{prompt="Visible choice"} now.`,
    ].join('\n'));
    const container = document.createElement('div');
    container.innerHTML = html;
    expect(container.textContent).toBe(`Pick ${literal} Visible now.\n`);
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('does not amplify long authored placeholder-like text during document cleanup', () => {
    const literal = '\uE000codex-followup-' + '_'.repeat(10000);
    const content = `${literal} :codex-followup[Copy]{prompt="Original prompt"}`;
    let intermediate = '';
    const restored = transformTextWithFollowups(content, (text) => {
      intermediate = text;
      return text;
    });

    expect(restored).toBe(content);
    expect(intermediate.length).toBeLessThan(content.length);
  });

  it.each(['**x** ', ':'])('bounds directive look-ahead across repeated %j segments', (segment) => {
    const content = segment.repeat(2000);
    const searches = vi.spyOn(String.prototype, 'search');
    const indexes = vi.spyOn(String.prototype, 'indexOf');
    const matches = vi.spyOn(String.prototype, 'matchAll');
    const text = vi.spyOn(Tokenizer.prototype, 'inlineText');
    let scanned = 0;
    try {
      new Marked({ extensions: [codexFollowupExtension] }).parse(content);
      searches.mock.calls.forEach(([pattern], index) => {
        if (String(pattern).includes('codex-followup')) scanned += String(searches.mock.contexts[index]).length;
      });
      indexes.mock.calls.forEach(([pattern], index) => {
        if (pattern === ':' || pattern.includes('codex-followup')) scanned += String(indexes.mock.contexts[index]).length;
      });
      matches.mock.calls.forEach(([pattern], index) => {
        if (String(pattern).includes('codex-followup')) scanned += String(matches.mock.contexts[index]).length;
      });
      text.mock.results.forEach((result) => {
        if (result.type === 'return') scanned += result.value?.raw.length ?? 0;
      });
    } finally {
      searches.mockRestore();
      indexes.mockRestore();
      matches.mockRestore();
      text.mockRestore();
    }
    expect(scanned).toBeLessThan(content.length * 4);
  });

  it('keeps directive positions independent across nested inline contexts and paragraphs', () => {
    const container = document.createElement('div');
    container.innerHTML = service.renderSync([
      '**Choose :codex-followup[Inner]{prompt="Nested prompt"}** then :codex-followup[Outer]{prompt="Outer prompt"}.',
      '',
      '> Next :codex-followup[Quoted]{prompt="Quoted prompt"}.',
      '',
      'See https://example.com and :codex-followup[Last]{prompt="Last prompt"}.',
    ].join('\n'));
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['Inner', 'Outer', 'Quoted', 'Last']);
    expect(buttons.map((button) => JSON.parse(button.dataset['followupPrompt']!))).toEqual([
      'Nested prompt', 'Outer prompt', 'Quoted prompt', 'Last prompt',
    ]);
    expect(container.querySelector('strong button')?.textContent).toBe('Inner');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
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

  it('marks relative links to files with unlisted extensions as file paths', () => {
    // Regression: a `.docx` link was not recognised, rendered as a plain
    // anchor, and navigated the whole app window to a missing file:// URL.
    const html = service.renderSync(
      '[KPI Testing Guide](docs/2026-09-go-ahead/KPI-Testing-Guide.docx)',
    );

    expect(html).toContain('class="file-path"');
    expect(html).toContain('data-file-path="docs/2026-09-go-ahead/KPI-Testing-Guide.docx"');
  });

  it('marks extensionless relative link targets as file paths', () => {
    expect(service.renderSync('[readme](docs/README)')).toContain('data-file-path="docs/README"');
  });

  it('keeps absolute and Windows drive link targets as file paths', () => {
    expect(service.renderSync('[a](/Users/someone/report.docx)'))
      .toContain('data-file-path="/Users/someone/report.docx"');
    expect(service.renderSync('[a](C:\\Users\\someone\\report.docx)'))
      .toContain('class="file-path"');
  });

  it('does not mark scheme or fragment links as file paths', () => {
    for (const markdown of [
      '[a](https://example.com/report.docx)',
      '[a](mailto:someone@example.com)',
      '[a](vscode://file/tmp/x)',
      '[a](#section)',
    ]) {
      expect(service.renderSync(markdown), markdown).not.toContain('data-file-path');
    }
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
