import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
