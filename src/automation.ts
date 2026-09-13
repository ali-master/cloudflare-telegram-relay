import { AppError, LEVELS, type Level, type NotificationInput } from './types';

export interface DeliveryRule {
  id: string;
  name: string;
  enabled: boolean;
  levels: Level[];
  environments: string[];
  tags: string[];
  mode: 'immediate' | 'digest' | 'mute';
  digestMinutes: number;
}

export interface AutomationPolicy {
  version: number;
  grouping: { enabled: boolean; windowSeconds: number };
  responders: string[];
  escalation: { enabled: boolean; afterMinutes: number; targetChatIds: string[] };
  rules: DeliveryRule[];
}

export interface SubscriberPreferences {
  version: number;
  levels: Level[];
  environments: string[];
  timezone: string;
  quietHours: { enabled: boolean; start: string; end: string };
  delivery: 'immediate' | 'digest';
  digestMinutes: number;
  criticalBypass: boolean;
}

export interface DeliveryDecision {
  mode: 'immediate' | 'digest' | 'mute' | 'defer';
  reason: string;
  nextAt: number | null;
}

export interface Incident {
  id: string;
  notificationId: string;
  applicationId: string | null;
  application: string;
  title: string;
  event: string;
  level: Level;
  environment: string | null;
  fingerprint: string;
  status: 'open' | 'acknowledged' | 'snoozed' | 'resolved';
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  assigneeChatId: string | null;
  snoozedUntil: string | null;
  nextEscalationAt: string | null;
  escalationCount: number;
  version: number;
}

export interface IncidentEvent {
  id: string;
  action: string;
  actorChatId: string | null;
  actorName: string | null;
  createdAt: string;
  detail: string;
}

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  version: 0,
  grouping: { enabled: false, windowSeconds: 300 },
  responders: [],
  escalation: { enabled: false, afterMinutes: 5, targetChatIds: [] },
  rules: [],
};

export const DEFAULT_SUBSCRIBER_PREFERENCES: SubscriberPreferences = {
  version: 0,
  levels: [...LEVELS],
  environments: [],
  timezone: 'Asia/Tehran',
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  delivery: 'immediate',
  digestMinutes: 60,
  criticalBypass: true,
};

function invalid(field: string): never {
  throw new AppError(400, 'VALIDATION_ERROR', `VALIDATION_ERROR: مقدار فیلد ${field} معتبر نیست.`);
}

function object(value: unknown, field: string, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) if (!allowed.includes(key)) invalid(`${field}.${key}`);
  return data;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(field);
  return value;
}

function string(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(field);
  return value.trim();
}

function strings(value: unknown, field: string, count: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > count) invalid(field);
  return [...new Set(value.map(item => string(item, field, length)))];
}

function levels(value: unknown, field: string): Level[] {
  const result = strings(value, field, LEVELS.length, 8);
  if (result.some(level => !LEVELS.includes(level as Level))) invalid(field);
  return result as Level[];
}

function chatIds(value: unknown, field: string): string[] {
  const result = strings(value, field, 100, 17);
  if (result.some(id => !/^-?[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) invalid(field);
  return result;
}

function nextVersion(value: unknown, current: number): number {
  integer(value, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER - 1);
  if (value !== current) throw new AppError(409, 'VERSION_CONFLICT', 'VERSION_CONFLICT: تنظیمات تغییر کرده است؛ صفحه را تازه کنید و دوباره تلاش کنید.');
  return current + 1;
}

function ruleInput(value: unknown): DeliveryRule {
  const data = object(value, 'rule', ['id', 'name', 'enabled', 'levels', 'environments', 'tags', 'mode', 'digestMinutes']);
  const id = string(data.id, 'rule.id', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) invalid('rule.id');
  if (!['immediate', 'digest', 'mute'].includes(data.mode as string)) invalid('rule.mode');
  return {
    id,
    name: string(data.name, 'rule.name', 80),
    enabled: boolean(data.enabled, 'rule.enabled'),
    levels: levels(data.levels, 'rule.levels'),
    environments: strings(data.environments, 'rule.environments', 20, 80),
    tags: strings(data.tags, 'rule.tags', 10, 40),
    mode: data.mode as DeliveryRule['mode'],
    digestMinutes: integer(data.digestMinutes, 'rule.digestMinutes', 5, 1440),
  };
}

export function automationPolicyInput(value: unknown, current: AutomationPolicy): AutomationPolicy {
  const data = object(value, 'policy', ['expectedVersion', 'grouping', 'responders', 'escalation', 'rules']);
  const version = nextVersion(data.expectedVersion, current.version);
  const grouping = { ...current.grouping, ...(data.grouping === undefined ? {} : object(data.grouping, 'grouping', ['enabled', 'windowSeconds'])) };
  const escalation = { ...current.escalation, ...(data.escalation === undefined ? {} : object(data.escalation, 'escalation', ['enabled', 'afterMinutes', 'targetChatIds'])) };
  const rawRules = data.rules === undefined ? current.rules : data.rules;
  if (!Array.isArray(rawRules) || rawRules.length > 50) invalid('rules');
  const rules = rawRules.map(ruleInput);
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) invalid('rules.id');
  const targetChatIds = chatIds(escalation.targetChatIds, 'escalation.targetChatIds');
  if (escalation.enabled === true && !targetChatIds.length) invalid('escalation.targetChatIds');
  return {
    version,
    grouping: { enabled: boolean(grouping.enabled, 'grouping.enabled'), windowSeconds: integer(grouping.windowSeconds, 'grouping.windowSeconds', 30, 86400) },
    responders: chatIds(data.responders === undefined ? current.responders : data.responders, 'responders'),
    escalation: { enabled: boolean(escalation.enabled, 'escalation.enabled'), afterMinutes: integer(escalation.afterMinutes, 'escalation.afterMinutes', 1, 1440), targetChatIds },
    rules,
  };
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let result = dateFormatters.get(timezone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    if (dateFormatters.size >= 128) dateFormatters.delete(dateFormatters.keys().next().value!);
    dateFormatters.set(timezone, result);
  }
  return result;
}

export function subscriberPreferencesInput(value: unknown, current: SubscriberPreferences): SubscriberPreferences {
  const data = object(value, 'preferences', ['expectedVersion', 'levels', 'environments', 'timezone', 'quietHours', 'delivery', 'digestMinutes', 'criticalBypass']);
  const version = nextVersion(data.expectedVersion, current.version);
  const prefs = { ...current, ...data };
  const quiet = { ...current.quietHours, ...(data.quietHours === undefined ? {} : object(data.quietHours, 'quietHours', ['enabled', 'start', 'end'])) };
  const timezone = string(prefs.timezone, 'timezone', 80);
  try { formatter(timezone); } catch { invalid('timezone'); }
  if (typeof quiet.start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.start)) invalid('quietHours.start');
  if (typeof quiet.end !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.end)) invalid('quietHours.end');
  if (quiet.enabled === true && quiet.start === quiet.end) invalid('quietHours.end');
  if (!['immediate', 'digest'].includes(prefs.delivery as string)) invalid('delivery');
  return {
    version,
    levels: levels(prefs.levels, 'levels'),
    environments: strings(prefs.environments, 'environments', 20, 80),
    timezone,
    quietHours: { enabled: boolean(quiet.enabled, 'quietHours.enabled'), start: quiet.start, end: quiet.end },
    delivery: prefs.delivery as SubscriberPreferences['delivery'],
    digestMinutes: integer(prefs.digestMinutes, 'digestMinutes', 5, 1440),
    criticalBypass: boolean(prefs.criticalBypass, 'criticalBypass'),
  };
}

function localTime(time: number, timezone: string): { wall: number; minutes: number } {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { wall: Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute), minutes: parts.hour * 60 + parts.minute };
}

const clockMinutes = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

/** Return the first quiet-hours exit in epoch milliseconds, including clock changes. */
export function quietHoursEnd(prefs: SubscriberPreferences, now: number): number | null {
  if (!prefs.quietHours.enabled) return null;
  const start = clockMinutes(prefs.quietHours.start), end = clockMinutes(prefs.quietHours.end);
  const local = localTime(now, prefs.timezone);
  const inside = (minutes: number) => start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inside(local.minutes)) return null;
  const midnight = local.wall - local.minutes * 60_000;
  const offsets = new Set<number>();
  // Nearby offsets cover both occurrences of a repeated hour and skipped local end times.
  for (const days of [-2, -1, 0, 1, 2]) {
    const sample = midnight + days * 86_400_000;
    offsets.add(localTime(sample, prefs.timezone).wall - sample);
  }
  const exits: number[] = [];
  for (const days of [0, 1, 2]) {
    const target = midnight + days * 86_400_000 + end * 60_000;
    const candidates = [...offsets].map(offset => target - offset).sort((a, b) => a - b);
    const walls = candidates.map(candidate => localTime(candidate, prefs.timezone).wall);
    const exact = candidates.find((candidate, index) => candidate > now && walls[index] === target);
    if (exact !== undefined) { exits.push(exact); continue; }
    // An end inside a DST gap becomes the first valid local minute after the gap.
    if (!walls.some(wall => wall < target) || !walls.some(wall => wall > target)) continue;
    const first = Math.max(Math.floor(now / 60_000) * 60_000 + 60_000, candidates[0]);
    for (let candidate = first; candidate <= candidates[candidates.length - 1]; candidate += 60_000) {
      if (localTime(candidate, prefs.timezone).wall >= target) { exits.push(candidate); break; }
    }
  }
  if (!exits.length) throw new AppError(400, 'INVALID_TIMEZONE_TRANSITION', 'INVALID_TIMEZONE_TRANSITION: زمان پایان سکوت قابل محاسبه نیست.');
  const next = Math.min(...exits);
  const nowMinute = Math.floor(now / 60_000) * 60_000;
  const offset = local.wall - nowMinute;
  if (localTime(next, prefs.timezone).wall - next !== offset) {
    // A backward clock jump can leave a daytime quiet window before its nominal end.
    let low = nowMinute, high = next;
    while (high - low > 60_000) {
      const mid = Math.floor((low + high) / 120_000) * 60_000;
      if (localTime(mid, prefs.timezone).wall - mid === offset) low = mid; else high = mid;
    }
    if (!inside(localTime(high, prefs.timezone).minutes)) return high;
  }
  return next;
}

/** Resolve delivery only after the hub has enforced tenant, application, and subscriber access. */
export function evaluateDelivery(input: NotificationInput, policy: AutomationPolicy, prefs: SubscriberPreferences, now: number): DeliveryDecision {
  if (!Number.isFinite(now)) invalid('now');
  if (!prefs.levels.includes(input.level)) return { mode: 'mute', reason: 'level_filter', nextAt: null };
  if (prefs.environments.length && !prefs.environments.includes(input.environment || '')) return { mode: 'mute', reason: 'environment_filter', nextAt: null };
  const rule = policy.rules.find(rule => rule.enabled
    && (!rule.levels.length || rule.levels.includes(input.level))
    && (!rule.environments.length || rule.environments.includes(input.environment || ''))
    && rule.tags.every(tag => input.tags?.includes(tag)));
  if (rule?.mode === 'mute') return { mode: 'mute', reason: `rule:${rule.id}`, nextAt: null };
  if (input.level === 'critical' && prefs.criticalBypass) return { mode: 'immediate', reason: 'critical_bypass', nextAt: null };
  const quietEnd = quietHoursEnd(prefs, now);
  const digest = rule?.mode === 'digest' || prefs.delivery === 'digest';
  if (digest) {
    const minutes = Math.max(rule?.mode === 'digest' ? rule.digestMinutes : 0, prefs.delivery === 'digest' ? prefs.digestMinutes : 0);
    const interval = minutes * 60_000;
    let nextAt = (Math.floor(now / interval) + 1) * interval;
    if (quietEnd !== null) nextAt = Math.max(nextAt, quietEnd);
    nextAt = quietHoursEnd(prefs, nextAt) ?? nextAt;
    return { mode: 'digest', reason: quietEnd !== null ? 'quiet_hours' : rule?.mode === 'digest' ? `rule:${rule.id}` : 'subscriber_digest', nextAt };
  }
  if (quietEnd !== null) return { mode: 'defer', reason: 'quiet_hours', nextAt: quietEnd };
  return { mode: 'immediate', reason: rule ? `rule:${rule.id}` : 'default', nextAt: null };
}

/** This is a tenant/app-local identity; callers must retain both scope keys in storage. */
export function incidentFingerprint(input: NotificationInput): string {
  return input.fingerprint || JSON.stringify([input.event.replace(/\.(firing|resolved)$/u, ''), input.environment || '']);
}
