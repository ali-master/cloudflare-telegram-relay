import type {NotificationInput, SourceContext} from './types';
import type {Incident} from './automation';

// The subset of Bot API 10.3 blocks used by the notification template.
// https://core.telegram.org/bots/api#inputrichmessage
export type RichText = string | RichText[] | { type: 'bold' | 'code'; text: string };
export type RichMessageButton = { text: string; style?: 'primary' | 'success' | 'danger' } & (
  { url: string; copy_text?: never; callback_data?: never } | { copy_text: { text: string }; url?: never; callback_data?: never } | {callback_data: string; url?: never; copy_text?: never}
  );
export type InputRichBlock =
  | { type: 'paragraph'; text: RichText }
  | { type: 'heading'; size: number; text: RichText }
  | { type: 'photo'; photo: { type: 'photo'; media: string } }
  | { type: 'buttons'; buttons: RichMessageButton[]; align: 'right' };

export interface InputRichMessage {
  blocks: InputRichBlock[];
  is_rtl: false;
  skip_entity_detection: true;
}

const LEVELS = {
  info: {icon: 'ℹ️', label: 'Info'},
  success: {icon: '✅', label: 'Success'},
  warning: {icon: '⚠️', label: 'Warning'},
  error: {icon: '🔴', label: 'Error'},
  critical: {icon: '🚨', label: 'Critical'},
} as const;

export const NOTIFICATION_TIME_ZONE = 'Asia/Tehran';
const dateOptions: Intl.DateTimeFormatOptions = {
  timeZone: NOTIFICATION_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
};
const persianDate = new Intl.DateTimeFormat('fa-IR', {...dateOptions, calendar: 'persian', numberingSystem: 'latn'});
const gregorianDate = new Intl.DateTimeFormat('en-GB', {...dateOptions, calendar: 'gregory', numberingSystem: 'latn'});

/** Both calendars describe the event's instant in Tehran, independent of the Worker host timezone. */
export function notificationDates(timestamp: string): { persian: string; gregorian: string } {
  const instant = new Date(timestamp);
  const format = (formatter: Intl.DateTimeFormat, separator: string): string => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    return `${parts.year}${separator}${parts.month}${separator}${parts.day} · ${parts.hour}:${parts.minute}:${parts.second}`;
  };
  return {persian: format(persianDate, '/'), gregorian: format(gregorianDate, '-')};
}

export function countryFlag(country: string): string {
  if (!/^[A-Z]{2}$/.test(country) || ['XX', 'T1'].includes(country)) return '';
  return [...country].map(letter => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
}

/** Keep the existing plain representation for ingestion limits and queued legacy deliveries. */
export function formatNotification(input: NotificationInput, source?: SourceContext, showCountryFlag = false): string {
  const level = LEVELS[input.level];
  const lines = [
    `${level.icon} ${input.level.toUpperCase()} · ${input.application}`,
    ...(input.title ? [input.title] : []),
    `Event: ${input.event}`,
    ...(input.environment ? [`Environment: ${input.environment}`] : []),
    `Time: ${input.timestamp}`,
    ...(showCountryFlag && source && countryFlag(source.country) ? [`Origin: ${countryFlag(source.country)} ${source.country}`] : []),
    '', input.text,
  ];
  if (input.metadata && Object.keys(input.metadata).length) {
    lines.push('', ...Object.entries(input.metadata).map(([key, value]) => `${key}: ${value}`));
  }
  if (input.tags?.length) lines.push('', `Tags: ${input.tags.join(', ')}`);
  if (input.url) lines.push('', input.url);
  return lines.join('\n');
}

/** Use monowidth text without the client's themed preformatted block background. */
function monospaceSection(title: string, text: string): InputRichBlock {
  return {type: 'paragraph', text: ['\n', {type: 'bold', text: title}, '\n\n', {type: 'code', text}]};
}

/** Align short technical fields; keep long or RTL values on their own line without changing their contents. */
function technicalSection(title: string, entries: [string, string][]): InputRichBlock {
  const width = Math.min(12, Math.max(...entries.map(([key]) => key.length)));
  const rows = entries.map(([key, value]) => {
    const compact = /^[a-zA-Z0-9_.-]{1,12}$/.test(key)
      && !/[\r\n\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u.test(value)
      && width + 3 + [...value].length <= 36;
    return compact ? `${key.padEnd(width)} : ${value}` : `${key}:\n${value}`;
  });
  return monospaceSection(title, rows.join('\n'));
}

/** Explicit blocks keep application-controlled strings literal, including HTML, Markdown and mentions. */
export function formatRichNotification(
  input: NotificationInput,
  source?: SourceContext,
  showCountryFlag = false,
  notificationId?: string,
  incident?: Incident,
): InputRichMessage {
  const level = LEVELS[input.level];
  const dates = notificationDates(input.timestamp);
  const context: [string, string][] = [['app', input.application], ['event', input.event]];
  if (input.environment) context.push(['env', input.environment]);
  context.push(['level', input.level]);
  if (showCountryFlag && source && countryFlag(source.country)) context.push(['origin', `${countryFlag(source.country)} ${source.country}`]);
  const blocks: InputRichBlock[] = [
    {type: 'heading', size: 3, text: `${level.icon} ${input.title || level.label}`},
    {type: 'paragraph', text: input.text},
    technicalSection('CONTEXT', context),
  ];
  if (incident) {
    blocks.splice(2, 0, technicalSection('INCIDENT', [
      ['status', incident.status], ['occurrences', String(incident.occurrences)],
      ['first seen', incident.firstSeenAt], ['last seen', incident.lastSeenAt],
      ...(incident.assigneeChatId ? [['owner', incident.assigneeChatId] as [string, string]] : []),
      ...(incident.snoozedUntil ? [['snoozed to', incident.snoozedUntil] as [string, string]] : []),
    ]));
    if (incident.status !== 'resolved') blocks.push({type: 'buttons', align: 'right', buttons: [
      {text: 'Acknowledge', style: 'primary', callback_data: `inc:ack:${incident.id}`},
      {text: 'Snooze 15m', callback_data: `inc:snooze:${incident.id}`},
      {text: 'Resolve', style: 'success', callback_data: `inc:resolve:${incident.id}`},
    ]});
  }
  if (input.image) blocks.push({type: 'photo', photo: {type: 'photo', media: input.image}});
  const [persianDay] = dates.persian.split(' · ');
  const [gregorianDay, time] = dates.gregorian.split(' · ');
  blocks.push(technicalSection('TIME', [
    ['jalali', persianDay], ['gregorian', gregorianDay], ['time', time], ['zone', NOTIFICATION_TIME_ZONE],
  ]));
  if (input.metadata && Object.keys(input.metadata).length) {
    blocks.push(technicalSection('METADATA', Object.entries(input.metadata).map(([key, value]) => [key, String(value)])));
  }
  if (input.tags?.length) blocks.push(monospaceSection('TAGS', input.tags.join('\n')));
  if (input.url) {
    blocks.push({
      type: 'buttons',
      align: 'right',
      buttons: [{text: 'مشاهدهٔ جزئیات ↗', style: 'primary', url: input.url}]
    });
  }
  // CopyTextButton accepts 1–256 characters. Validated events are <=80 and IDs are UUIDs.
  const actions: RichMessageButton[] = [{text: 'کپی رویداد', copy_text: {text: input.event}}];
  if (notificationId) actions.push({text: 'کپی شناسه', copy_text: {text: notificationId}});
  blocks.push({type: 'buttons', align: 'right', buttons: actions});
  return {blocks, is_rtl: false, skip_entity_detection: true};
}

/** A bounded digest retains literal event titles and identifiers, with no themed pre backgrounds. */
export function formatRichDigest(items: Array<{input: NotificationInput; incident?: Incident}>, timestamp: string): InputRichMessage {
  const blocks: InputRichBlock[] = [{type: 'heading', size: 3, text: `📬 Notification digest · ${items.length}`}];
  for (const {input, incident} of items.slice(0, 20)) {
    blocks.push({type: 'paragraph', text: ['\n', {type: 'bold', text: `${LEVELS[input.level].icon} ${input.application} · ${input.title || input.event}`}, '\n', {type: 'code', text: `${input.level} · ${input.environment || 'all environments'}${incident ? ` · ${incident.occurrences} occurrences` : ''}`}, '\n', input.text.slice(0, 300)]});
    if (input.url) blocks.push({type: 'buttons', align: 'right', buttons: [{text: 'View details ↗', url: input.url}]});
    if (incident && incident.status !== 'resolved') blocks.push({type: 'buttons', align: 'right', buttons: [{text: 'Acknowledge', callback_data: `inc:ack:${incident.id}`}, {text: 'Resolve', style: 'success', callback_data: `inc:resolve:${incident.id}`} ]});
  }
  const dates = notificationDates(timestamp);
  blocks.push(technicalSection('DELIVERED', [['jalali', dates.persian], ['gregorian', dates.gregorian], ['zone', NOTIFICATION_TIME_ZONE]]));
  return {blocks, is_rtl: false, skip_entity_detection: true};
}
