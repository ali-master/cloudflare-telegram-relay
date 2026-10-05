import { describe, expect, it } from 'vitest';
import { parseNotificationHtml } from '../src/notification-html';
import { AppError } from '../src/types';

describe('notification HTML parsing', () => {
  it('maps nested inline styles to native RichText without sending raw HTML', () => {
    expect(parseNotificationHtml('<p>Release <b>ready <i>now</i></b><br><code>a1b2c3</code></p>')).toEqual({
      blocks: [{ type: 'paragraph', text: ['Release ', { type: 'bold', text: ['ready ', { type: 'italic', text: 'now' }] }, '\n', { type: 'code', text: 'a1b2c3' }] }],
      plainText: 'Release ready now\na1b2c3',
    });
  });

  it('supports formatting aliases, spoilers and rich text styles', () => {
    const result = parseNotificationHtml('<strong>B</strong><em>I</em><ins>U</ins><strike>S</strike><del>D</del><tg-spoiler>X</tg-spoiler><span class="tg-spoiler">Y</span><mark>M</mark><sub>2</sub><sup>3</sup>');
    expect(result.blocks).toEqual([{ type: 'paragraph', text: [
      { type: 'bold', text: 'B' }, { type: 'italic', text: 'I' }, { type: 'underline', text: 'U' },
      { type: 'strikethrough', text: 'S' }, { type: 'strikethrough', text: 'D' }, { type: 'spoiler', text: 'X' },
      { type: 'spoiler', text: 'Y' }, { type: 'marked', text: 'M' }, { type: 'subscript', text: '2' }, { type: 'superscript', text: '3' },
    ] }]);
    expect(result.plainText).toBe('BIUSDXYM23');
  });

  it('decodes numerical and named entities once and preserves Persian and emoji', () => {
    const result = parseNotificationHtml('<p>سلام &#x1f680; &lt;b&gt; &amp;lt; &nbsp; &hellip; &NotEqualTilde;</p>');
    expect(result.plainText).toBe('سلام 🚀 <b> &lt; \u00a0 … ≂̸');
    expect(result.blocks[0]).toEqual({ type: 'paragraph', text: 'سلام 🚀 <b> &lt; \u00a0 … ≂̸' });
  });

  it('keeps code whitespace and an optional explicit language intact', () => {
    expect(parseNotificationHtml('<pre><code class="language-typescript">  if (x &lt; 2) {\n    deploy();\n  }\n</code></pre>')).toEqual({
      blocks: [{ type: 'pre', language: 'typescript', text: '  if (x < 2) {\n    deploy();\n  }\n' }],
      plainText: '  if (x < 2) {\n    deploy();\n  }\n',
    });
    expect(parseNotificationHtml('<pre>  x\r\n  y</pre>').plainText).toBe('  x\n  y');
    expect(parseNotificationHtml('<pre>  <code class="language-sh">echo ready</code>  \n</pre>')).toEqual({
      blocks: [{ type: 'pre', language: 'sh', text: '  echo ready  \n' }],
      plainText: '  echo ready  \n',
    });
  });

  it('creates headings, paragraphs, footers and dividers without empty whitespace blocks', () => {
    expect(parseNotificationHtml('\n<h2>Deploy</h2>\n<p>Ready<br/>Healthy</p>\n<hr/>\n<footer>CI</footer>\n')).toEqual({
      blocks: [
        { type: 'heading', size: 2, text: 'Deploy' },
        { type: 'paragraph', text: ['Ready', '\n', 'Healthy'] },
        { type: 'divider' }, { type: 'footer', text: 'CI' },
      ],
      plainText: 'Deploy\n\nReady\nHealthy\n\nCI',
    });
  });

  it('preserves ordered and nested unordered lists in both projections', () => {
    const result = parseNotificationHtml('<ol start="3"><li>Deploy<ul><li>API</li><li>Web</li></ul></li><li>Verify</li></ol>');
    expect(result.blocks).toEqual([{ type: 'list', items: [
      { value: 3, type: '1', blocks: [
        { type: 'paragraph', text: 'Deploy' },
        { type: 'list', items: [{ blocks: [{ type: 'paragraph', text: 'API' }] }, { blocks: [{ type: 'paragraph', text: 'Web' }] }] },
      ] },
      { value: 4, type: '1', blocks: [{ type: 'paragraph', text: 'Verify' }] },
    ] }]);
    expect(result.plainText).toBe('3. Deploy\n\n• API\n• Web\n4. Verify');
  });

  it('supports quotations, expandable quotations and expandable details', () => {
    const result = parseNotificationHtml('<blockquote><p>One</p><p>Two</p></blockquote><blockquote expandable>Details<br>More</blockquote><details open><summary><b>Logs</b></summary><pre>All good</pre></details>');
    expect(result.blocks).toEqual([
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'One' }, { type: 'paragraph', text: 'Two' }] },
      { type: 'expandable_blockquote', text: ['Details', '\n', 'More'] },
      { type: 'details', summary: { type: 'bold', text: 'Logs' }, blocks: [{ type: 'pre', text: 'All good' }], is_open: true },
    ]);
    expect(result.plainText).toBe('One\n\nTwo\n\nDetails\nMore\n\nLogs\nAll good');
  });

  it('preserves meaningful spaces between formatted words in details', () => {
    const result = parseNotificationHtml('<details>\n<summary>Details</summary><b>one</b> <i>two</i></details>');
    expect(result.plainText).toBe('Details\none two');
    expect(result.blocks).toEqual([{ type: 'details', summary: 'Details', blocks: [{ type: 'paragraph', text: [{ type: 'bold', text: 'one' }, ' ', { type: 'italic', text: 'two' }] }] }]);
  });

  it.each(['https://example.com/path?x=1&y=2', 'http://example.com', 'mailto:ops@example.com', 'tel:+123456789', 'tg://user?id=123456789'])('allows the supported link %s', (url) => {
    const result = parseNotificationHtml(`<a href="${url.replaceAll('&', '&amp;')}"><b>Open</b></a>`);
    const target = url.startsWith('mailto:') ? { type: 'email_address', email_address: url.slice(7) }
      : url.startsWith('tel:') ? { type: 'phone_number', phone_number: url.slice(4) } : { type: 'url', url };
    expect(result.blocks).toEqual([{ type: 'paragraph', text: { ...target, text: { type: 'bold', text: 'Open' } } }]);
    expect(result.plainText).toBe('Open');
  });

  it('decodes URL-encoded email and phone destinations for native Telegram entities', () => {
    expect(parseNotificationHtml('<a href="mailto:ops%2Balerts@example.com">Email</a> <a href="tel:%2B1234567">Call</a>').blocks).toEqual([
      { type: 'paragraph', text: [{ type: 'email_address', email_address: 'ops+alerts@example.com', text: 'Email' }, ' ', { type: 'phone_number', phone_number: '+1234567', text: 'Call' }] },
    ]);
  });

  it.each([
    'javascript:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/html,hello', 'file:///tmp/private',
    '//example.com', '/relative', '#anchor', 'https://user:password@example.com', 'https://example.com&#10;evil',
    'tg://resolve?domain=someone', 'tg://user?id=123456789&other=1', 'mailto:ops@example.com?body=secret',
    'mailto:ops%0D%0ABcc:other@example.com', 'mailto:ops%ZZ@example.com', 'tel:...', 'tel:--', 'tel:%0A123',
  ])('rejects unsafe or unsupported link %s', (url) => {
    expect(() => parseNotificationHtml(`<a href="${url}">link</a>`)).toThrow(AppError);
  });

  it.each([
    '<b>unclosed', '<b><i>misnested</b></i>', '</b>orphan', '<b>x</b></b>', '<b/>x', '<p>one<p>two</p>',
    '<p>x</p ignored>', '<p>x</p', '<b', '<b attr="unfinished', 'literal < sign', '<p>x</>',
    '<p><h1>bad child</h1></p>', '<a href="https://example.com"><a href="https://example.com">nested</a></a>',
    '<ul>bad</ul>', '<ul><li>one<li>two</li></ul>', '<li>orphan</li>', '<summary>orphan</summary>',
    '<details>no summary</details>', '<details><summary>title</summary></details>', '<blockquote expandable><p>block</p></blockquote>',
  ])('rejects malformed or structurally unsupported HTML: %s', (html) => {
    expect(() => parseNotificationHtml(html)).toThrow(AppError);
  });

  it.each([
    '<script>alert(1)</script>', '<style>b{color:red}</style>', '<iframe src="https://example.com"></iframe>',
    '<img src="https://example.com/x.png">', '<tg-button type="callback_data" data="menu:stop">Stop</tg-button>',
    '<b style="color:red">red</b>', '<b onclick="alert(1)">click</b>', '<a href="https://example.com" href="https://evil.example">duplicate</a>',
    '<a href=https://example.com>unquoted</a>', '<span class="custom">x</span>', '<code class="language-js">x</code>',
    '<pre><b>markup</b></pre>', '<ol start="0"><li>x</li></ol>', '<details open="false"><summary>x</summary>y</details>',
    '<!-- comment --><p>x</p>', '<!DOCTYPE html><p>x</p>', '<![CDATA[<p>x</p>]]>', '<p>bad\u0000</p>',
  ])('rejects unsupported tags, attributes or content: %s', (html) => {
    expect(() => parseNotificationHtml(html)).toThrow(AppError);
  });

  it.each(['', ' \n ', '<b></b>', '<p> </p>', '<br><hr>', '<pre> </pre>', '<ul><li> </li></ul>'])('rejects render-empty HTML: %s', (html) => {
    expect(() => parseNotificationHtml(html)).toThrow(AppError);
  });

  it('enforces depth, raw length, visible length and block budgets', () => {
    expect(parseNotificationHtml('<b>'.repeat(12) + 'x' + '</b>'.repeat(12)).plainText).toBe('x');
    expect(() => parseNotificationHtml('<b>'.repeat(13) + 'x' + '</b>'.repeat(13))).toThrow(AppError);
    expect(() => parseNotificationHtml('<b>' + ' '.repeat(12000) + 'x</b>')).toThrow(AppError);
    expect(parseNotificationHtml('a'.repeat(3000)).plainText).toHaveLength(3000);
    expect(() => parseNotificationHtml('a'.repeat(3001))).toThrow(AppError);
    expect(() => parseNotificationHtml('<p>' + ' '.repeat(3100) + 'x</p>')).toThrow(AppError);
    expect(parseNotificationHtml('<p> x </p>').plainText).toBe(' x ');
    expect(parseNotificationHtml('<p>x</p>'.repeat(200)).blocks).toHaveLength(200);
    expect(() => parseNotificationHtml('<p>x</p>'.repeat(201))).toThrow(AppError);
    expect(() => parseNotificationHtml('<ul>' + '<li>x</li>'.repeat(100) + '</ul>')).toThrow(AppError);
  });

  it('returns a stable public error without reflecting submitted payload', () => {
    try {
      parseNotificationHtml('<private-secret>token-content</private-secret>');
      expect.fail('Must reject unsupported HTML');
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'INVALID_HTML' });
      expect((error as Error).message).not.toMatch(/private-secret|token-content/);
    }
  });
});
