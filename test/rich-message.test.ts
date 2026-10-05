import {describe, expect, it} from 'vitest';
import {formatNotification, formatRichDigest, formatRichNotification, notificationDates} from '../src/rich-message';
import type {Incident} from '../src/automation';
import {notificationInput} from '../src/validation';
import {LEVELS, type NotificationInput} from '../src/types';

const source = {ip: '203.0.113.8', country: 'DE', source: 'api'};
const input: NotificationInput = {
  application: 'Payments', event: 'deploy.succeeded', level: 'success',
  timestamp: '2026-09-12T10:30:00Z', text: 'نسخهٔ جدید آماده است.\nAll checks passed.',
};
const notificationId = 'd06f2076-cc51-4219-b604-a344c46a36da';

describe('notification calendars in the Worker runtime', () => {
  it('renders both calendars from the same instant in Tehran', () => {
    expect(notificationDates(input.timestamp)).toEqual({
      persian: '1405/06/21 · 14:00:00', gregorian: '2026-09-12 · 14:00:00',
    });
    expect(notificationDates('2026-09-12T14:00:00+03:30')).toEqual(notificationDates(input.timestamp));
  });

  it.each([
    ['2025-03-20T20:29:59Z', '1403/12/30 · 23:59:59', '2025-03-20 · 23:59:59'],
    ['2025-03-20T20:30:00Z', '1404/01/01 · 00:00:00', '2025-03-21 · 00:00:00'],
    ['2026-12-31T20:30:00Z', '1405/10/11 · 00:00:00', '2027-01-01 · 00:00:00'],
  ])('handles calendar boundaries at %s', (timestamp, persian, gregorian) => {
    expect(notificationDates(timestamp)).toEqual({persian, gregorian});
  });
});

describe('Telegram rich notification content', () => {
  it('renders an opted-in HTML body as native Telegram blocks while other fields stay literal', () => {
    const message = formatRichNotification({
      ...input,
      parseMode: 'HTML',
      text: '<h2>Release</h2><p><b>Ready</b> &amp; <i>healthy</i><br><code>a1b2c3d</code></p>',
      title: '<b>Literal title</b>',
      application: '<i>Literal app</i>',
      metadata: {commit: '<code>literal value</code>'},
      tags: ['<u>literal tag</u>'],
    });
    expect(message.blocks[0]).toEqual({type: 'heading', size: 3, text: '✅ <b>Literal title</b>'});
    expect(message.blocks[1]).toEqual({type: 'heading', size: 2, text: 'Release'});
    expect(message.blocks[2]).toMatchObject({type: 'paragraph'});
    const body = JSON.stringify(message.blocks[2]);
    expect(body).toContain('"type":"bold"');
    expect(body).toContain('"type":"italic"');
    expect(body).toContain('"type":"code"');
    expect(body).toContain(' & ');
    expect(body).not.toContain('<b>');
    expect(body).not.toContain('&amp;');
    const result = JSON.stringify(message);
    expect(result).toContain('<i>Literal app</i>');
    expect(result).toContain('<code>literal value</code>');
    expect(result).toContain('<u>literal tag</u>');
    expect(message).toMatchObject({skip_entity_detection: true, is_rtl: false});
    expect(message).not.toHaveProperty('html');
  });

  it('keeps HTML inline links and the separate details button alongside both calendars and photos', () => {
    const message = formatRichNotification({
      ...input, parseMode: 'HTML', text: '<p><a href="https://example.test/logs?env=prod&amp;limit=10">Logs</a></p>',
      url: 'https://example.test/deploy/42', image: 'https://example.test/chart.png',
    }, source, true, notificationId);
    expect(JSON.stringify(message.blocks[1])).toContain('"type":"url"');
    expect(JSON.stringify(message.blocks[1])).toContain('https://example.test/logs?env=prod&limit=10');
    expect(message.blocks).toContainEqual({type: 'photo', photo: {type: 'photo', media: 'https://example.test/chart.png'}});
    expect(JSON.stringify(message)).toContain('1405/06/21');
    expect(JSON.stringify(message)).toContain('2026-09-12');
    const buttons = message.blocks.flatMap(block => block.type === 'buttons' ? block.buttons : []);
    expect(buttons).toContainEqual({text: 'مشاهدهٔ جزئیات ↗', style: 'primary', url: 'https://example.test/deploy/42'});
    expect(buttons).toContainEqual({text: 'کپی شناسه', copy_text: {text: notificationId}});
  });

  it('places incident context after the complete HTML body without splitting its blocks', () => {
    const incident: Incident = {
      id: 'inc-test', notificationId, applicationId: 'payments', application: input.application,
      title: 'Deployment incident', event: input.event, level: 'error', environment: null,
      fingerprint: 'deploy', status: 'open', occurrences: 3, firstSeenAt: input.timestamp,
      lastSeenAt: input.timestamp, acknowledgedAt: null, resolvedAt: null, assigneeChatId: null,
      snoozedUntil: null, nextEscalationAt: null, escalationCount: 0, version: 1,
    };
    const message = formatRichNotification({
      ...input, parseMode: 'HTML', text: '<p>First paragraph</p><p>Second paragraph</p><p>Last paragraph</p>',
    }, source, false, notificationId, incident);
    expect(message.blocks.slice(1, 4)).toEqual([
      {type: 'paragraph', text: 'First paragraph'},
      {type: 'paragraph', text: 'Second paragraph'},
      {type: 'paragraph', text: 'Last paragraph'},
    ]);
    expect(JSON.stringify(message.blocks[4])).toContain('INCIDENT');
    expect(JSON.stringify(message.blocks[5])).toContain('CONTEXT');
    expect(message.blocks.flatMap(block => block.type === 'buttons' ? block.buttons : []))
      .toContainEqual({text: 'Acknowledge', style: 'primary', callback_data: 'inc:ack:inc-test'});
  });

  it('uses decoded plain content for the legacy representation without parsing other fields', () => {
    const text = formatNotification({
      ...input, parseMode: 'HTML', text: '<p><b>Ready</b> &amp; healthy</p><p>Build <code>a1b2c3d</code></p>',
      title: '<b>Literal title</b>', metadata: {commit: '<code>literal metadata</code>'},
    });
    expect(text).toContain('Ready & healthy');
    expect(text).toContain('Build a1b2c3d');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('&amp;');
    expect(text).toContain('<b>Literal title</b>');
    expect(text).toContain('<code>literal metadata</code>');
  });

  it('summarizes decoded HTML without markup and truncates on Unicode code point boundaries', () => {
    const message = formatRichDigest([{input: {
      ...input, parseMode: 'HTML', text: `<p><b>${'x'.repeat(299)}🚀end</b></p>`,
      title: '<b>Literal title</b>',
    }}], input.timestamp);
    expect(message.blocks[1]).toMatchObject({type: 'paragraph'});
    if (message.blocks[1].type !== 'paragraph' || !Array.isArray(message.blocks[1].text)) throw new Error('Expected digest paragraph');
    const excerpt = message.blocks[1].text.at(-1);
    expect(excerpt).toBe(`${'x'.repeat(299)}🚀`);
    expect(JSON.stringify(message.blocks[1])).toContain('<b>Literal title</b>');
    expect(JSON.stringify(message.blocks[1])).not.toContain('<p>');
  });

  it('retains a literal digest body unless HTML mode is explicitly selected', () => {
    const message = formatRichDigest([{input: {...input, text: '<b>Literal</b> &amp; unchanged'}}], input.timestamp);
    expect(message.blocks[1]).toMatchObject({type: 'paragraph'});
    if (message.blocks[1].type !== 'paragraph' || !Array.isArray(message.blocks[1].text)) throw new Error('Expected digest paragraph');
    expect(message.blocks[1].text.at(-1)).toBe('<b>Literal</b> &amp; unchanged');
  });

  it('leaves enough block capacity for the notification template around HTML content', () => {
    const message = formatRichNotification({
      ...input, parseMode: 'HTML', text: '<p>x</p>'.repeat(180),
      metadata: {commit: 'a1b2c3d'}, tags: ['production'], url: 'https://example.test/logs',
      image: 'https://example.test/chart.png',
    }, source, true, notificationId);
    expect(message.blocks.filter(block => block.type === 'paragraph' && block.text === 'x')).toHaveLength(180);
    expect(message.blocks.length).toBeLessThan(500);
  });

  it('uses native blocks, dual dates and literal monospace identifiers', () => {
    const message = formatRichNotification({
      ...input,
      title: 'انتشار موفق',
      environment: 'production'
    }, source, true, notificationId);
    expect(message).toMatchObject({is_rtl: false, skip_entity_detection: true});
    expect(message).not.toHaveProperty('html');
    expect(message).not.toHaveProperty('markdown');
    expect(message.blocks).toContainEqual({type: 'heading', size: 3, text: '✅ انتشار موفق'});
    expect(message.blocks).toContainEqual({type: 'paragraph', text: [
      '\n', {type: 'bold', text: 'CONTEXT'}, '\n\n',
      {type: 'code', text: 'app    : Payments\nevent  : deploy.succeeded\nenv    : production\nlevel  : success\norigin : 🇩🇪 DE'},
    ]});
    expect(message.blocks).toContainEqual({type: 'paragraph', text: [
      '\n', {type: 'bold', text: 'TIME'}, '\n\n',
      {type: 'code', text: 'jalali    : 1405/06/21\ngregorian : 2026-09-12\ntime      : 14:00:00\nzone      : Asia/Tehran'},
    ]});
    const serialized = JSON.stringify(message);
    expect(serialized).toContain('🇩🇪');
    expect(serialized).not.toContain(source.ip);
    expect(serialized).not.toContain('SUCCESS');
    expect(serialized).not.toContain('"type":"table"');
    expect(serialized).not.toContain('"type":"details"');
    expect(serialized).not.toContain('"type":"pre"');
    expect(message.blocks.filter(block => block.type !== 'buttons').some(block => JSON.stringify(block).includes(notificationId))).toBe(false);
    expect(message.blocks.length).toBeLessThanOrEqual(6);
  });

  it.each(LEVELS)('gives %s notifications an English severity title', level => {
    const headings = {
      info: 'ℹ️ Info',
      success: '✅ Success',
      warning: '⚠️ Warning',
      error: '🔴 Error',
      critical: '🚨 Critical',
    };
    const message = formatRichNotification({...input, level, metadata: {sample: true}, tags: ['test']});
    expect(message.blocks[0]).toEqual({type: 'heading', size: 3, text: headings[level]});
    expect(JSON.stringify(message)).not.toContain(level.toUpperCase());
    expect(JSON.stringify(message)).not.toContain('"type":"pre"');
  });

  it('preserves HTML, Markdown, mentions and control-like strings as data', () => {
    const hostile = '<b>❌</b> **admin** @all /stop [open](https://other.test) & "quoted"';
    const message = formatRichNotification({
      ...input,
      title: hostile,
      text: hostile,
      event: hostile,
      metadata: {'<script>': hostile}
    });
    expect(message.blocks).toContainEqual({type: 'paragraph', text: hostile});
    expect(message.blocks).toContainEqual({type: 'heading', size: 3, text: `✅ ${hostile}`});
    expect(message.skip_entity_detection).toBe(true);
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    expect(message.blocks.flatMap(block => block.type === 'buttons' ? block.buttons : []).some(button => button.url)).toBe(false);
  });

  it.each(['https://example.test/chart.png', 'AgACAgQAAxkBAAIBExampleFileId'])('embeds photo %s without a caption limit or truncation', image => {
    const text = 'متن '.repeat(700);
    const message = formatRichNotification({...input, text, image});
    expect(message.blocks).toContainEqual({type: 'photo', photo: {type: 'photo', media: image}});
    expect(message.blocks).toContainEqual({type: 'paragraph', text});
  });

  it('turns the URL into a primary button and provides explicit copy actions', () => {
    const url = 'https://example.test/deploy/42?tab=logs&from=telegram';
    const message = formatRichNotification({...input, url}, source, false, notificationId);
    const buttons = message.blocks.flatMap(block => block.type === 'buttons' ? block.buttons : []);
    expect(buttons).toContainEqual({text: 'مشاهدهٔ جزئیات ↗', style: 'primary', url});
    expect(buttons).toContainEqual({text: 'کپی رویداد', copy_text: {text: input.event}});
    expect(buttons).toContainEqual({text: 'کپی شناسه', copy_text: {text: notificationId}});
    for (const button of buttons) {
      expect(Boolean(button.url)).not.toBe(Boolean(button.copy_text));
      if (button.copy_text) expect(button.copy_text.text.length).toBeLessThanOrEqual(256);
    }
    expect(message.blocks.filter(block => block.type !== 'buttons').some(block => JSON.stringify(block).includes(url))).toBe(false);
  });

  it('keeps metadata scalars and long values fully visible in monospace sections', () => {
    const longValue = 'v'.repeat(500);
    const message = formatRichNotification({
      ...input,
      metadata: {duration: 0, failed: false, commit: longValue},
      tags: ['production', 'ci/cd']
    });
    expect(message.blocks).toContainEqual({type: 'paragraph', text: [
      '\n', {type: 'bold', text: 'METADATA'}, '\n\n',
      {type: 'code', text: `duration : 0\nfailed   : false\ncommit:\n${longValue}`},
    ]});
    expect(message.blocks).toContainEqual({type: 'paragraph', text: [
      '\n', {type: 'bold', text: 'TAGS'}, '\n\n', {type: 'code', text: 'production\nci/cd'},
    ]});
  });

  it('omits missing optional sections and hides country when disabled or unknown', () => {
    for (const [country, enabled] of [['DE', false], ['XX', true], ['T1', true], ['not-a-country', true]] as const) {
      const message = formatRichNotification(input, {...source, country}, enabled);
      expect(JSON.stringify(message)).not.toContain('origin :');
      expect(message.blocks.some(block => block.type === 'photo')).toBe(false);
      expect(message.blocks.filter(block => block.type === 'paragraph' && Array.isArray(block.text))).toHaveLength(2);
      expect(message.blocks.flatMap(block => block.type === 'buttons' ? block.buttons : [])).toHaveLength(1);
    }
  });

  it('puts RTL, multiline and long keys/values on separate lines without invisible controls or truncation', () => {
    const value = 'مقدار فارسی\nخط دوم';
    const key = 'technical-key-that-is-longer-than-twelve';
    const message = formatRichNotification({...input, application: 'پرداخت', metadata: {[key]: 'original-value', 'شناسه': value}});
    const content = message.blocks.flatMap(block => block.type === 'paragraph' && Array.isArray(block.text) ? block.text : [])
      .flatMap(text => typeof text === 'object' && !Array.isArray(text) && text.type === 'code' ? [text.text] : []).join('\n');
    expect(content).toContain('app:\nپرداخت');
    expect(content).toContain(`${key}:\noriginal-value`);
    expect(content).toContain(`شناسه:\n${value}`);
    expect(content).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(message.blocks.flatMap(block => block.type === 'buttons' ? block.buttons : [])).toContainEqual({text: 'کپی رویداد', copy_text: {text: input.event}});
  });

  it('retains existing input limits and bounds rich output without shortening input', () => {
    const validated = notificationInput({
      ...input,
      text: 'x'.repeat(3000),
      metadata: {commit: 'a'.repeat(500)}
    }, source);
    expect(formatNotification(validated, source, true).length).toBeLessThanOrEqual(4000);
    const rich = formatRichNotification(validated, source, true, notificationId);
    expect(rich.blocks).toContainEqual({type: 'paragraph', text: validated.text});
    expect(JSON.stringify(rich).length).toBeLessThan(32768);
    expect(rich.blocks.length).toBeLessThan(500);
    expect(() => notificationInput({...input, text: 'x'.repeat(3001)}, source)).toThrow();
  });
});
