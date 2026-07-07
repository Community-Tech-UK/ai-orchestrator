import { renderMobileMarkdown } from './mobile-markdown';

describe('renderMobileMarkdown', () => {
  it('renders common assistant markdown into html', () => {
    const html = renderMobileMarkdown([
      '## Plan',
      '',
      '- **Ship** `code`',
      '',
      '> quoted note',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| A | 1 |',
      '',
      '![Diagram](https://example.com/diagram.png)',
      '',
      '```ts',
      'const ok = true;',
      '```',
    ].join('\n'));

    expect(html).toContain('<h2>Plan</h2>');
    expect(html).toContain('<li><strong>Ship</strong> <code>code</code></li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<table>');
    expect(html).toContain('<img src="https://example.com/diagram.png" alt="Diagram">');
    expect(html).toContain('<code class="language-ts">const ok = true;');
  });

  it('wraps fenced code blocks with a language bar and copy chip', () => {
    const html = renderMobileMarkdown('```ts\nconst ok = true;\n```');

    expect(html).toContain('<div class="md-code">');
    expect(html).toContain('<span class="md-code-lang">ts</span>');
    expect(html).toContain('class="md-code-copy"');
    expect(html).toContain('role="button"');
    expect(html).toContain('<pre><code class="language-ts">const ok = true;');
  });

  it('labels language-less code blocks generically and escapes their content', () => {
    const html = renderMobileMarkdown('```\n<script>alert(1)</script>\n```');

    expect(html).toContain('<span class="md-code-lang">code</span>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('removes unsafe html before Angular binds it into the transcript', () => {
    const html = renderMobileMarkdown([
      '<script>alert("x")</script>',
      '<img src="x" onerror="alert(1)">',
      '<a href="javascript:alert(1)">bad</a>',
      '[bad](javascript:alert(1))',
    ].join('\n'));

    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('href="javascript:');
  });
});
