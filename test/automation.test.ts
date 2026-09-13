import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOMATION_POLICY, DEFAULT_SUBSCRIBER_PREFERENCES, automationPolicyInput,
  evaluateDelivery, incidentFingerprint, quietHoursEnd, subscriberPreferencesInput,
  type AutomationPolicy, type DeliveryRule, type SubscriberPreferences,
} from '../src/automation';
import { notificationInput } from '../src/validation';
import { alertmanagerInputs, grafanaInput } from '../src/integrations';
import type { NotificationInput } from '../src/types';

const input: NotificationInput = {
  application: 'Payments', applicationId: 'payments', event: 'latency.firing', level: 'warning',
  timestamp: '2026-09-13T12:00:00Z', text: 'Latency exceeds 500ms', environment: 'production', tags: ['slo', 'api'],
};
const source = { ip: '203.0.113.8', country: 'DE', source: 'api' };
const policy = (): AutomationPolicy => structuredClone(DEFAULT_AUTOMATION_POLICY);
const prefs = (): SubscriberPreferences => structuredClone(DEFAULT_SUBSCRIBER_PREFERENCES);
const rule = (id: string, mode: DeliveryRule['mode'], extra: Partial<DeliveryRule> = {}): DeliveryRule => ({
  id, name: id, enabled: true, levels: [], environments: [], tags: [], mode, digestMinutes: 15, ...extra,
});
const at = Date.parse('2026-09-13T12:02:30Z');
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();

describe('automation configuration', () => {
  it('starts compatible with existing immediate delivery and creates independent validated copies', () => {
    expect(evaluateDelivery(input, policy(), prefs(), at)).toEqual({ mode: 'immediate', reason: 'default', nextAt: null });
    const result = automationPolicyInput({ expectedVersion: 0, grouping: { enabled: true } }, policy());
    expect(result.grouping).toEqual({ enabled: true, windowSeconds: 300 });
    expect(result.version).toBe(1);
    result.responders.push('42');
    result.grouping.windowSeconds = 60;
    expect(DEFAULT_AUTOMATION_POLICY.responders).toEqual([]);
    expect(DEFAULT_AUTOMATION_POLICY.grouping.windowSeconds).toBe(300);
  });

  it('requires optimistic versions and reports stale writes as conflicts', () => {
    for (const update of [{}, { expectedVersion: '0' }, { expectedVersion: -1 }, { expectedVersion: 0, version: 99 }]) {
      expect(() => automationPolicyInput(update, policy())).toThrow();
      expect(() => subscriberPreferencesInput(update, prefs())).toThrow();
    }
    expect(() => automationPolicyInput({ expectedVersion: 1 }, policy())).toThrow(expect.objectContaining({ status: 409, code: 'VERSION_CONFLICT' }));
    expect(() => subscriberPreferencesInput({ expectedVersion: 0 }, { ...prefs(), version: 3 })).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('bounds policies and rejects malformed nested fields and duplicate rule identifiers', () => {
    for (const update of [
      { grouping: { windowSeconds: 29 } }, { grouping: { windowSeconds: 86401 } }, { grouping: { enabled: 'true' } },
      { grouping: { color: 'red' } }, { responders: ['@username'] }, { responders: ['0'] }, { responders: ['9007199254740993'] },
      { escalation: { enabled: true } }, { escalation: { afterMinutes: 0 } }, { escalation: { afterMinutes: 1441 } },
      { rules: [rule('one', 'digest', { digestMinutes: 4 })] }, { rules: [rule('one', 'mute'), rule('one', 'immediate')] },
      { rules: [rule('one', 'mute', { levels: ['fatal' as never] })] }, { rules: Array.from({ length: 51 }, (_, i) => rule(`r${i}`, 'mute')) },
    ]) expect(() => automationPolicyInput({ expectedVersion: 0, ...update }, policy())).toThrow();
    const valid = automationPolicyInput({ expectedVersion: 0, responders: ['42', '42'], escalation: { enabled: true, targetChatIds: ['-1001234567890'] }, rules: [rule('r1', 'digest')] }, policy());
    expect(valid.responders).toEqual(['42']);
    expect(valid.escalation.targetChatIds).toEqual(['-1001234567890']);
  });

  it('validates timezones and rejects accidental full-day quiet hours', () => {
    for (const update of [
      { timezone: 'Mars/Olympus' }, { quietHours: { start: '24:00' } }, { quietHours: { end: '8:00' } },
      { quietHours: { enabled: true, start: '08:00', end: '08:00' } }, { quietHours: { start: '08:60' } },
      { levels: ['Warning'] }, { delivery: 'mute' }, { criticalBypass: 'true' }, { digestMinutes: 4 },
      { environments: ['production\nsecret'] }, { timezone: null },
    ]) expect(() => subscriberPreferencesInput({ expectedVersion: 0, ...update }, prefs())).toThrow();
    const valid = subscriberPreferencesInput({ expectedVersion: 0, timezone: 'America/New_York', levels: [], quietHours: { enabled: true }, delivery: 'digest', digestMinutes: 30 }, prefs());
    expect(valid.levels).toEqual([]);
    expect(valid.version).toBe(1);
    expect(valid.quietHours).toEqual({ enabled: true, start: '22:00', end: '08:00' });
  });
});

describe('delivery rules and subscriber choices', () => {
  it('uses the first enabled matching rule with all tags and exact environment', () => {
    const settings = { ...policy(), rules: [
      rule('disabled', 'mute', { enabled: false }),
      rule('staging', 'mute', { environments: ['staging'] }),
      rule('two-tags', 'mute', { tags: ['slo', 'database'] }),
      rule('slo', 'digest', { tags: ['slo', 'api'], levels: ['warning'] }),
      rule('later', 'mute'),
    ] };
    expect(evaluateDelivery(input, settings, prefs(), at)).toEqual({ mode: 'digest', reason: 'rule:slo', nextAt: Date.parse('2026-09-13T12:15:00Z') });
    settings.rules.unshift(rule('first', 'immediate'));
    expect(evaluateDelivery(input, settings, prefs(), at).mode).toBe('immediate');
  });

  it('never lets critical bypass override subscriber filters or a mute rule', () => {
    const critical = { ...input, level: 'critical' as const };
    expect(evaluateDelivery(critical, policy(), { ...prefs(), levels: ['warning'] }, at).reason).toBe('level_filter');
    expect(evaluateDelivery(critical, policy(), { ...prefs(), environments: ['staging'] }, at).reason).toBe('environment_filter');
    expect(evaluateDelivery(critical, { ...policy(), rules: [rule('mute', 'mute')] }, prefs(), at).mode).toBe('mute');
    expect(evaluateDelivery(input, policy(), { ...prefs(), levels: [] }, at).mode).toBe('mute');
  });

  it('lets critical bypass remove digest and quiet-hours delays only when opted in', () => {
    const critical = { ...input, level: 'critical' as const };
    const personal = { ...prefs(), delivery: 'digest' as const, quietHours: { enabled: true, start: '00:00', end: '23:59' } };
    expect(evaluateDelivery(critical, policy(), personal, at)).toEqual({ mode: 'immediate', reason: 'critical_bypass', nextAt: null });
    expect(evaluateDelivery(critical, policy(), { ...personal, criticalBypass: false }, at).mode).toBe('digest');
  });

  it('respects a subscriber digest even when a matching rule requests immediate delivery', () => {
    const result = evaluateDelivery(input, { ...policy(), rules: [rule('immediate', 'immediate')] }, { ...prefs(), delivery: 'digest', digestMinutes: 60 }, at);
    expect(result).toEqual({ mode: 'digest', reason: 'subscriber_digest', nextAt: Date.parse('2026-09-13T13:00:00Z') });
  });

  it('uses the longer requested digest interval and always schedules after now', () => {
    const settings = { ...policy(), rules: [rule('rule', 'digest', { digestMinutes: 120 })] };
    const personal = { ...prefs(), delivery: 'digest' as const, digestMinutes: 60 };
    const boundary = Date.parse('2026-09-13T12:00:00Z');
    expect(evaluateDelivery(input, settings, personal, boundary).nextAt).toBe(Date.parse('2026-09-13T14:00:00Z'));
    expect(() => evaluateDelivery(input, settings, personal, NaN)).toThrow();
  });

  it('postpones a digest whose future boundary falls in quiet hours', () => {
    const personal = { ...prefs(), timezone: 'UTC', delivery: 'digest' as const, digestMinutes: 60, quietHours: { enabled: true, start: '22:00', end: '08:00' } };
    expect(evaluateDelivery(input, policy(), personal, Date.parse('2026-09-13T21:45:00Z')).nextAt).toBe(Date.parse('2026-09-14T08:00:00Z'));
    expect(evaluateDelivery(input, policy(), personal, Date.parse('2026-09-13T23:45:00Z')).nextAt).toBe(Date.parse('2026-09-14T08:00:00Z'));
  });
});

describe('quiet hours across dates and daylight-saving transitions', () => {
  it.each([
    ['Asia/Tehran', '22:00', '08:00', '2026-09-13T19:00:00Z', '2026-09-14T04:30:00.000Z'],
    ['Asia/Tehran', '22:00', '08:00', '2026-09-14T03:00:00Z', '2026-09-14T04:30:00.000Z'],
    ['Asia/Tehran', '22:00', '08:00', '2026-09-14T04:30:00Z', null],
    ['UTC', '09:00', '17:00', '2026-09-13T09:00:00Z', '2026-09-13T17:00:00.000Z'],
    ['UTC', '09:00', '17:00', '2026-09-13T17:00:00Z', null],
    ['America/New_York', '22:00', '08:00', '2026-03-08T04:00:00Z', '2026-03-08T12:00:00.000Z'],
    ['America/New_York', '22:00', '08:00', '2026-11-01T03:00:00Z', '2026-11-01T13:00:00.000Z'],
    ['America/New_York', '00:00', '02:30', '2026-03-08T06:00:00Z', '2026-03-08T07:00:00.000Z'],
    ['America/New_York', '00:00', '01:30', '2026-11-01T05:10:00Z', '2026-11-01T05:30:00.000Z'],
    ['America/New_York', '00:00', '01:30', '2026-11-01T06:10:00Z', '2026-11-01T06:30:00.000Z'],
    ['America/New_York', '01:30', '02:00', '2026-11-01T05:45:00Z', '2026-11-01T06:00:00.000Z'],
    ['America/New_York', '01:30', '01:15', '2026-11-01T05:45:00Z', '2026-11-01T06:15:00.000Z'],
    ['Australia/Lord_Howe', '00:00', '02:15', '2026-10-03T15:00:00Z', '2026-10-03T15:30:00.000Z'],
  ])('computes %s quiet %s–%s at %s', (timezone, start, end, timestamp, expected) => {
    const personal = { ...prefs(), timezone, quietHours: { enabled: true, start, end } };
    expect(iso(quietHoursEnd(personal, Date.parse(timestamp)))).toBe(expected);
    const result = evaluateDelivery(input, policy(), personal, Date.parse(timestamp));
    expect(result.mode).toBe(expected ? 'defer' : 'immediate');
    expect(iso(result.nextAt)).toBe(expected);
  });
});

describe('incident ingestion identity', () => {
  it('accepts bounded explicit incident identity and status without inferring successful deployment resolution', () => {
    const normalized = notificationInput({ application: 'app', event: 'service', text: 'Recovered', fingerprint: 'db:primary', incidentStatus: 'resolved', level: 'success' }, source);
    expect(normalized.fingerprint).toBe('db:primary');
    expect(normalized.incidentStatus).toBe('resolved');
    expect(notificationInput({ application: 'app', event: 'deploy.succeeded', text: 'Deployed', level: 'success' }, source).incidentStatus).toBeUndefined();
    for (const extra of [{ fingerprint: '' }, { fingerprint: 'x'.repeat(161) }, { fingerprint: 'a\nb' }, { incidentStatus: 'success' }]) {
      expect(() => notificationInput({ application: 'app', event: 'e', text: 'test', ...extra }, source)).toThrow();
    }
  });

  it('matches explicit firing/resolved event suffixes and keeps environments distinct', () => {
    expect(incidentFingerprint(input)).toBe(incidentFingerprint({ ...input, event: 'latency.resolved' }));
    expect(incidentFingerprint(input)).not.toBe(incidentFingerprint({ ...input, environment: 'staging' }));
    expect(incidentFingerprint({ ...input, fingerprint: 'provider-id' })).toBe('provider-id');
    expect(incidentFingerprint({ ...input, event: 'deploy.succeeded' })).not.toBe(incidentFingerprint({ ...input, event: 'deploy.failed' }));
  });

  it('preserves Alertmanager provider fingerprints and resolves using the same identity', () => {
    const alerts = ['firing', 'resolved'].map(status => ({ status, fingerprint: '8a157f2', labels: { alertname: 'HighLatency', instance: 'api-1' }, annotations: {} }));
    const result = alertmanagerInputs({ alerts }, source);
    expect(result.map(alert => alert.fingerprint)).toEqual(['8a157f2', '8a157f2']);
    expect(result.map(alert => alert.incidentStatus)).toEqual(['firing', 'resolved']);
  });

  it('keeps fallback Alertmanager identities stable across label order and distinct across instances', () => {
    const result = alertmanagerInputs({ alerts: [
      { status: 'firing', labels: { alertname: 'Latency', instance: 'api-1' } },
      { status: 'resolved', labels: { instance: 'api-1', alertname: 'Latency' } },
      { status: 'firing', labels: { alertname: 'Latency', instance: 'api-2' } },
    ] }, source);
    expect(result[0].fingerprint).toBe(result[1].fingerprint);
    expect(result[0].fingerprint).not.toBe(result[2].fingerprint);
  });

  it('keeps Grafana group identity independent of status/title and bounds long group keys', () => {
    const groupKey = '{production}:{alertname="Latency",instance="' + 'api'.repeat(100) + '"}';
    const firing = grafanaInput({ status: 'firing', groupKey, title: 'Firing', commonLabels: { instance: 'api-1' } }, source);
    const resolved = grafanaInput({ status: 'resolved', groupKey, title: 'Resolved', commonLabels: {} }, source);
    expect(firing.fingerprint).toBe(resolved.fingerprint);
    expect(firing.fingerprint!.length).toBeLessThanOrEqual(160);
    expect(firing.incidentStatus).toBe('firing');
    expect(resolved.incidentStatus).toBe('resolved');
    expect(grafanaInput({ groupKey: groupKey + 'different' }, source).fingerprint).not.toBe(firing.fingerprint);
  });
});
