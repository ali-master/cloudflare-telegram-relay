import { AppError, DEFAULT_SETTINGS, LEVELS, type NotificationInput, type Settings, type SourceContext } from './types';
import { validIpRule } from './security';
import { formatNotification } from './telegram';
import { COUNTRY_CODES } from './countries';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_BODY', 'بدنه درخواست باید یک شیء JSON باشد.');
  return value as Record<string, unknown>;
}
function invalid(field: string): never { throw new AppError(400, 'VALIDATION_ERROR', `مقدار فیلد ${field} معتبر نیست.`); }
function string(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(field);
  return value.trim();
}
function safeUrl(value: unknown, field: string): string | undefined {
  const raw = string(value, field, 2048, false);
  if (!raw) return;
  try { const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password) invalid(field); } catch { invalid(field); }
  return raw;
}
export function notificationInput(value: unknown, source: SourceContext): NotificationInput {
  const data = object(value);
  const allowed = ['application', 'event', 'level', 'timestamp', 'text', 'title', 'image', 'url', 'environment', 'metadata', 'tags', 'silent'];
  for (const key of Object.keys(data)) if (!allowed.includes(key)) invalid(key);
  const level = data.level ?? 'info';
  if (!LEVELS.includes(level as never)) invalid('level');
  let timestamp = data.timestamp === undefined ? new Date().toISOString() : string(data.timestamp, 'timestamp', 40)!;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) invalid('timestamp');
  const [year, month, day] = timestamp.slice(0, 10).split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1] || +timestamp.slice(11, 13) > 23) invalid('timestamp');
  timestamp = new Date(timestamp).toISOString();
  const input: NotificationInput = {
    application: string(data.application, 'application', 80)!, event: string(data.event, 'event', 80)!,
    text: string(data.text, 'text', 3000)!, level: level as NotificationInput['level'], timestamp,
  };
  for (const [key, max] of [['title', 160], ['environment', 80]] as const) {
    const val = string(data[key], key, max, false); if (val) input[key] = val;
  }
  const url = safeUrl(data.url, 'url'); if (url) input.url = url;
  const image = string(data.image, 'image', 2048, false);
  if (image) {
    if (!/^[A-Za-z0-9_-]{10,512}$/.test(image)) safeUrl(image, 'image');
    input.image = image;
  }
  if (data.silent !== undefined) { if (typeof data.silent !== 'boolean') invalid('silent'); input.silent = data.silent; }
  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags) || data.tags.length > 10) invalid('tags');
    input.tags = data.tags.map(value => string(value, 'tags', 40)!);
  }
  if (data.metadata !== undefined) {
    const metadata = object(data.metadata);
    if (Object.keys(metadata).length > 20) invalid('metadata');
    const entries = Object.entries(metadata).map(([key, value]) => {
      string(key, 'metadata key', 40);
      if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 500 || (typeof value === 'number' && !Number.isFinite(value))) invalid('metadata');
      return [key, value] as [string, string | number | boolean];
    });
    input.metadata = Object.fromEntries(entries);
  }
  if (formatNotification(input, source, true).length > 4000) invalid('text + metadata (maximum 4000 formatted characters)');
  return input;
}
export function settingsInput(value: unknown, current: Settings): Settings {
  const data = object(value);
  for (const key of Object.keys(data)) if (!Object.hasOwn(DEFAULT_SETTINGS, key)) invalid(key);
  const settings = { ...current, ...data } as Settings;
  settings.projectName = string(settings.projectName, 'projectName', 80)!;
  if (typeof settings.welcomeMessage !== 'string' || settings.welcomeMessage.trim().length > 1000) invalid('welcomeMessage');
  settings.welcomeMessage = settings.welcomeMessage.trim();
  for (const key of ['paused', 'showCountryFlag'] as const) if (typeof settings[key] !== 'boolean') invalid(key);
  for (const key of ['ipMode', 'countryMode'] as const) if (!['off', 'allow', 'deny'].includes(settings[key])) invalid(key);
  if (!Array.isArray(settings.ipRules) || settings.ipRules.length > 100 || settings.ipRules.some(rule => typeof rule !== 'string' || !validIpRule(rule))) invalid('ipRules');
  settings.ipRules = [...new Set(settings.ipRules)];
  if (!Array.isArray(settings.countries) || settings.countries.length > 250 || settings.countries.some(code => typeof code !== 'string' || !COUNTRY_CODES.has(code))) invalid('countries');
  settings.countries = [...new Set(settings.countries)];
  if (settings.ipMode === 'allow' && !settings.ipRules.length) invalid('ipRules (allow list cannot be empty)');
  if (settings.countryMode === 'allow' && !settings.countries.length) invalid('countries (allow list cannot be empty)');
  if (!Number.isInteger(settings.deliveryPerSecond) || settings.deliveryPerSecond < 1 || settings.deliveryPerSecond > 20) invalid('deliveryPerSecond');
  if (!Number.isInteger(settings.retentionDays) || settings.retentionDays < 7 || settings.retentionDays > 90) invalid('retentionDays');
  return settings;
}
export function idempotencyKey(value?: string): string | undefined {
  if (value !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) invalid('Idempotency-Key');
  return value;
}
export function pageNumber(value?: string): number {
  if (value !== undefined && !/^\d{1,6}$/.test(value)) invalid('page');
  return Math.max(1, Number(value || 1));
}
