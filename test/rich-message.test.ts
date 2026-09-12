import {describe, expect, it} from 'vitest';
import {formatNotification, formatRichNotification, notificationDates} from '../src/rich-message';
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
    const context = message.blocks.find(block => block.type === 'pre' && block.text.startsWith('CONTEXT\n'));
    expect(context).toEqual({type: 'pre', text: 'CONTEXT\n\napp    : Payments\nevent  : deploy.succeeded\nenv    : production\nlevel  : success\norigin : 🇩🇪 DE'});
    const time = message.blocks.find(block => block.type === 'pre' && block.text.startsWith('TIME\n'));
    expect(time).toEqual({type: 'pre', text: 'TIME\n\njalali    : 1405/06/21\ngregorian : 2026-09-12\ntime      : 14:00:00\nzone      : Asia/Tehran'});
    const serialized = JSON.stringify(message);
    expect(serialized).toContain('🇩🇪');
    expect(serialized).not.toContain(source.ip);
    expect(serialized).not.toContain('SUCCESS');
    expect(serialized).not.toContain('"type":"table"');
    expect(serialized).not.toContain('"type":"details"');
    expect(message.blocks.filter(block => block.type !== 'buttons').some(block => JSON.stringify(block).includes(notificationId))).toBe(false);
    expect(message.blocks.length).toBeLessThanOrEqual(6);
  });

  it.each(LEVELS)('gives %s notifications a visible severity', level => {
    const message = formatRichNotification({...input, level});
    expect(message.blocks[0]).toMatchObject({type: 'heading', text: expect.stringMatching(/^(ℹ️|✅|⚠️|🔴|🚨) /u)});
    expect(JSON.stringify(message)).not.toContain(level.toUpperCase());
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
    expect(message.blocks).toContainEqual({type: 'pre', text: `METADATA\n\nduration : 0\nfailed   : false\ncommit:\n${longValue}`});
    expect(message.blocks).toContainEqual({type: 'pre', text: 'TAGS\n\nproduction\nci/cd'});
  });

  it('omits missing optional sections and hides country when disabled or unknown', () => {
    for (const [country, enabled] of [['DE', false], ['XX', true], ['T1', true], ['not-a-country', true]] as const) {
      const message = formatRichNotification(input, {...source, country}, enabled);
      expect(JSON.stringify(message)).not.toContain('origin :');
      expect(message.blocks.some(block => block.type === 'photo')).toBe(false);
      expect(message.blocks.filter(block => block.type === 'pre')).toHaveLength(2);
      expect(message.blocks.flatMap(block => block.type === 'buttons' ? block.buttons : [])).toHaveLength(1);
    }
  });

  it('puts RTL, multiline and long keys/values on separate lines without invisible controls or truncation', () => {
    const value = 'مقدار فارسی\nخط دوم';
    const key = 'technical-key-that-is-longer-than-twelve';
    const message = formatRichNotification({...input, application: 'پرداخت', metadata: {[key]: 'original-value', 'شناسه': value}});
    const content = message.blocks.filter(block => block.type === 'pre').map(block => block.text).join('\n');
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
