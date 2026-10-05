import { QuoteType, Tokenizer } from 'htmlparser2';
import type { InputRichBlock, RichText } from './rich-message';
import { AppError } from './types';

type HtmlNode = string | HtmlElement;
interface HtmlElement { tag: string; attributes: Record<string, string>; children: HtmlNode[] }
interface InlineContent { text: RichText; plainText: string }
interface BlockContent { blocks: InputRichBlock[]; plainText: string }

const INLINE_STYLES = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline', ins: 'underline',
  s: 'strikethrough', strike: 'strikethrough', del: 'strikethrough', code: 'code',
  'tg-spoiler': 'spoiler', span: 'spoiler', mark: 'marked', sub: 'subscript', sup: 'superscript',
} as const;
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'footer', 'hr', 'ul', 'ol', 'blockquote', 'details']);
const ALLOWED_TAGS = new Set([...Object.keys(INLINE_STYLES), ...BLOCK_TAGS, 'a', 'br', 'li', 'summary']);
const VOID_TAGS = new Set(['br', 'hr']);
const MAX_DEPTH = 12;
const MAX_BLOCKS = 200;

function invalid(message = 'ساختار HTML معتبر نیست؛ تگ‌ها را کامل و به ترتیب ببندید.'): never {
  throw new AppError(400, 'INVALID_HTML', message);
}

function validateAttributes(element: HtmlElement, parent: HtmlElement): void {
  const { tag, attributes } = element;
  const allowed = tag === 'a' ? ['href'] : tag === 'span' || tag === 'code' ? ['class']
    : tag === 'ol' ? ['start'] : tag === 'blockquote' ? ['expandable'] : tag === 'details' ? ['open'] : [];
  if (Object.keys(attributes).some((name) => !allowed.includes(name))) {
    invalid(`ویژگی نامعتبر برای تگ ${tag}؛ از ویژگی‌های مستندشده استفاده کنید.`);
  }
  if (tag === 'a' && !attributes.href) invalid('تگ a باید یک href معتبر داشته باشد.');
  if (tag === 'span' && attributes.class !== 'tg-spoiler') invalid('تگ span فقط با class="tg-spoiler" پشتیبانی می‌شود.');
  if (tag === 'code' && attributes.class !== undefined &&
      (parent.tag !== 'pre' || !/^language-[A-Za-z0-9_+#.-]{1,40}$/.test(attributes.class))) {
    invalid('زبان کد را فقط با class="language-..." داخل pre مشخص کنید.');
  }
  if (tag === 'ol' && attributes.start !== undefined && !/^[1-9][0-9]{0,5}$/.test(attributes.start)) {
    invalid('ویژگی start فهرست باید عدد صحیح بین ۱ و ۹۹۹۹۹۹ باشد.');
  }
  for (const flag of ['expandable', 'open']) {
    if (attributes[flag] !== undefined && !['', flag].includes(attributes[flag].toLowerCase())) {
      invalid(`ویژگی ${flag} باید بدون مقدار نوشته شود.`);
    }
  }
}

/** Uses tokenizer events directly so malformed HTML cannot be silently repaired by a browser-style parser. */
function parseTree(html: string): HtmlNode[] {
  const root: HtmlElement = { tag: '', attributes: {}, children: [] };
  const stack = [root];
  let pending: HtmlElement | undefined;
  let attributeName = '';
  let attributeValue = '';
  let consumed = 0;
  let attributeEnd = 0;
  const appendText = (text: string) => {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) invalid('متن HTML شامل نویسهٔ کنترلی نامعتبر است.');
    const children = stack[stack.length - 1].children;
    const last = children.length - 1;
    if (typeof children[last] === 'string') children[last] += text;
    else children.push(text);
  };
  const finishOpen = (end: number, selfClosing: boolean) => {
    if (!pending || (selfClosing && !VOID_TAGS.has(pending.tag))) invalid();
    if (!/^[\t\n\r ]*\/?[\t\n\r ]*$/.test(html.slice(attributeEnd, end))) invalid();
    const parent = stack[stack.length - 1];
    validateAttributes(pending, parent);
    if (stack.length > MAX_DEPTH) invalid('عمق تو در توی HTML نباید بیشتر از ۱۲ باشد.');
    parent.children.push(pending);
    if (!VOID_TAGS.has(pending.tag)) stack.push(pending);
    pending = undefined;
    consumed = end + 1;
  };
  const tokenizer = new Tokenizer({ decodeEntities: true, recognizeSelfClosing: true }, {
    onopentagname(start, end) {
      if (pending || start - 1 !== consumed) invalid();
      const tag = html.slice(start, end).toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) invalid('این تگ HTML پشتیبانی نمی‌شود؛ از تگ‌های راهنمای API استفاده کنید.');
      pending = { tag, attributes: Object.create(null) as Record<string, string>, children: [] };
      attributeEnd = end;
    },
    onattribname(start, end) {
      if (!pending || !/^[\t\n\r ]+$/.test(html.slice(attributeEnd, start))) invalid();
      attributeName = html.slice(start, end).toLowerCase();
      if (Object.hasOwn(pending.attributes, attributeName)) invalid('ویژگی تکراری در HTML مجاز نیست.');
      attributeValue = '';
    },
    onattribdata(start, end) { attributeValue += html.slice(start, end); },
    onattribentity(codepoint) { attributeValue += String.fromCodePoint(codepoint); },
    onattribend(quote, end) {
      if (!pending) invalid();
      if (quote === QuoteType.Unquoted) invalid('مقدار ویژگی‌های HTML را داخل کوتیشن بنویسید.');
      pending.attributes[attributeName] = attributeValue;
      attributeEnd = end;
    },
    onopentagend(end) { finishOpen(end, false); },
    onselfclosingtag(end) { finishOpen(end, true); },
    onclosetag(start, end) {
      const closeEnd = html.indexOf('>', end);
      const name = html.slice(start, end).toLowerCase();
      if (pending || start - 2 !== consumed || closeEnd === -1 || !/^[\t\n\r ]*$/.test(html.slice(end, closeEnd)) ||
          stack.length === 1 || stack[stack.length - 1].tag !== name) invalid();
      stack.pop();
      consumed = closeEnd + 1;
    },
    ontext(start, end) {
      if (start !== consumed || html.slice(start, end).includes('<')) invalid();
      appendText(html.slice(start, end));
      consumed = end;
    },
    ontextentity(codepoint, end) {
      appendText(String.fromCodePoint(codepoint));
      consumed = end;
    },
    oncdata() { invalid('CDATA در محتوای اعلان پشتیبانی نمی‌شود.'); },
    oncomment() { invalid('کامنت HTML در محتوای اعلان پشتیبانی نمی‌شود.'); },
    ondeclaration() { invalid(); },
    onprocessinginstruction() { invalid(); },
    onend() {
      if (pending || stack.length !== 1 || consumed !== html.length) invalid();
    },
  });
  tokenizer.write(html);
  tokenizer.end();
  return root.children;
}

function checkedUrl(value: string): string {
  if (value !== value.trim() || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) invalid('آدرس لینک HTML معتبر نیست.');
  let url: URL;
  try { url = new URL(value); } catch { invalid('آدرس لینک HTML باید کامل و معتبر باشد.'); }
  if (url.username || url.password) invalid('اطلاعات ورود در آدرس لینک HTML مجاز نیست.');
  if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return value;
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
    let destination: string;
    try { destination = decodeURIComponent(url.pathname); } catch { invalid('کدگذاری آدرس لینک HTML معتبر نیست.'); }
    if (/[\u0000-\u0020\u007f-\u009f]/u.test(destination)) invalid('آدرس لینک HTML معتبر نیست.');
    if (url.protocol === 'mailto:' && /^[^\s@?]+@[^\s@?]+$/.test(destination) && !url.search && !url.hash) return value;
    if (url.protocol === 'tel:' && /^\+?[0-9().-]+$/.test(destination) && /[0-9]/.test(destination) && !url.search && !url.hash) return value;
  }
  if (/^tg:\/\/user\?id=[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(url.searchParams.get('id')))) return value;
  invalid('لینک HTML باید از نوع http، https، mailto، tel یا شناسهٔ کاربر تلگرام باشد.');
}

function inlineContent(nodes: HtmlNode[], insideLink = false): InlineContent {
  const pieces: RichText[] = [];
  let plainText = '';
  for (const node of nodes) {
    if (typeof node === 'string') { pieces.push(node); plainText += node; continue; }
    if (node.tag === 'br') { pieces.push('\n'); plainText += '\n'; continue; }
    if (node.tag === 'a' && insideLink) invalid('لینک‌های HTML نباید تو در تو باشند.');
    if (node.tag !== 'a' && !Object.hasOwn(INLINE_STYLES, node.tag)) {
      invalid('درون این بخش فقط متن و تگ‌های قالب‌بندی درون‌خطی مجاز است.');
    }
    const content = inlineContent(node.children, insideLink || node.tag === 'a');
    if (node.tag === 'a') {
      const url = checkedUrl(node.attributes.href);
      const parsed = new URL(url);
      if (parsed.protocol === 'mailto:') pieces.push({ type: 'email_address', text: content.text, email_address: decodeURIComponent(parsed.pathname) });
      else if (parsed.protocol === 'tel:') pieces.push({ type: 'phone_number', text: content.text, phone_number: decodeURIComponent(parsed.pathname) });
      else pieces.push({ type: 'url', text: content.text, url });
    } else pieces.push({ type: INLINE_STYLES[node.tag as keyof typeof INLINE_STYLES], text: content.text });
    plainText += content.plainText;
  }
  return { text: pieces.length === 1 ? pieces[0] : pieces, plainText };
}

/** Converts an explicitly opted-in HTML fragment into Telegram's native rich blocks and a plain-text projection. */
export function parseNotificationHtml(html: string): BlockContent {
  if (html.length > 12_000) invalid('طول کد HTML نباید بیشتر از ۱۲۰۰۰ نویسه باشد.');
  const nodes = parseTree(html.replace(/\r\n?/g, '\n'));
  let blockCount = 0;
  const count = () => { if (++blockCount > MAX_BLOCKS) invalid('HTML نباید بیشتر از ۲۰۰ بلوک و آیتم فهرست داشته باشد.'); };
  const build = (children: HtmlNode[]): BlockContent => {
    const blocks: InputRichBlock[] = [];
    const plain: string[] = [];
    let pending: HtmlNode[] = [];
    const push = (block: InputRichBlock, text: string) => { count(); blocks.push(block); plain.push(text); };
    const flush = () => {
      if (!pending.length) return;
      const content = inlineContent(pending);
      if (content.plainText.trim()) push({ type: 'paragraph', text: content.text }, content.plainText);
      pending = [];
    };
    for (const node of children) {
      if (typeof node === 'string' || !BLOCK_TAGS.has(node.tag)) { pending.push(node); continue; }
      flush();
      if (node.tag === 'hr') { push({ type: 'divider' }, ''); continue; }
      if (node.tag === 'pre') {
        const significant = node.children.filter((child) => typeof child !== 'string' || child.trim());
        const code = significant.length === 1 && typeof significant[0] !== 'string' && significant[0].tag === 'code' ? significant[0] : undefined;
        const source = code ? node.children.flatMap((child) => child === code ? code.children : [child]) : node.children;
        if (source.some((child) => typeof child !== 'string')) invalid('داخل pre فقط متن یا یک تگ code مجاز است.');
        const text = source.join('');
        if (!text.trim()) invalid('بلوک pre نباید خالی باشد.');
        const language = code?.attributes.class?.slice('language-'.length);
        push({ type: 'pre', text, ...(language ? { language } : {}) }, text);
      } else if (node.tag === 'ul' || node.tag === 'ol') {
        const items = node.children.filter((child) => typeof child !== 'string' || child.trim());
        if (!items.length || items.some((child) => typeof child === 'string' || child.tag !== 'li')) invalid('فهرست باید شامل تگ‌های li باشد.');
        const ordered = node.tag === 'ol';
        const start = Number(node.attributes.start ?? 1);
        const itemTexts: string[] = [];
        const result = items.map((item, index) => {
          count();
          const content = build((item as HtmlElement).children);
          if (!content.plainText.trim()) invalid('آیتم فهرست نباید خالی باشد.');
          itemTexts.push(`${ordered ? `${start + index}.` : '•'} ${content.plainText}`);
          return { blocks: content.blocks, ...(ordered ? { value: start + index, type: '1' as const } : {}) };
        });
        push({ type: 'list', items: result }, itemTexts.join('\n'));
      } else if (node.tag === 'blockquote' && node.attributes.expandable === undefined) {
        const content = build(node.children);
        if (!content.plainText.trim()) invalid('نقل‌قول نباید خالی باشد.');
        push({ type: 'blockquote', blocks: content.blocks }, content.plainText);
      } else if (node.tag === 'details') {
        const summaryIndex = node.children.findIndex((child) => typeof child !== 'string' || child.trim());
        const summary = node.children[summaryIndex];
        if (typeof summary !== 'object' || summary.tag !== 'summary') invalid('details باید با یک تگ summary شروع شود.');
        const title = inlineContent(summary.children);
        const content = build(node.children.slice(summaryIndex + 1));
        if (!title.plainText.trim() || !content.plainText.trim()) invalid('عنوان و محتوای details نباید خالی باشند.');
        push({ type: 'details', summary: title.text, blocks: content.blocks, ...(node.attributes.open !== undefined ? { is_open: true as const } : {}) }, `${title.plainText}\n${content.plainText}`);
      } else {
        const content = inlineContent(node.children);
        if (!content.plainText.trim()) continue;
        if (node.tag === 'blockquote') push({ type: 'expandable_blockquote', text: content.text }, content.plainText);
        else if (/^h[1-6]$/.test(node.tag)) push({ type: 'heading', size: Number(node.tag[1]), text: content.text }, content.plainText);
        else push({ type: node.tag === 'footer' ? 'footer' : 'paragraph', text: content.text }, content.plainText);
      }
    }
    flush();
    return { blocks, plainText: plain.filter(Boolean).join('\n\n') };
  };
  const content = build(nodes);
  if (!content.plainText.trim()) invalid('محتوای HTML باید متن قابل نمایش داشته باشد.');
  if (content.plainText.length > 3000) invalid('متن قابل نمایش HTML نباید بیشتر از ۳۰۰۰ نویسه باشد.');
  return content;
}
