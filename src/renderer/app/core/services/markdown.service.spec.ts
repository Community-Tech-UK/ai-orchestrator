import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { MarkdownService } from './markdown.service';

describe('MarkdownService.renderSync command stripping', () => {
  let service: MarkdownService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
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
});
