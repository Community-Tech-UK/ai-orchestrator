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
