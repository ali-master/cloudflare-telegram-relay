import { describe, expect, it } from 'vitest';
import { checkAccess, createSession, equalSecret, matchesIp, sourceContext, verifySession } from '../src/security';
import { DEFAULT_SETTINGS } from '../src/types';
import { notificationInput, settingsInput } from '../src/validation';
import { alertmanagerInputs, grafanaInput } from '../src/integrations';
const source = { ip: '203.0.113.8', country: 'DE', source: 'api' };
const payload = { application: 'MOM', event: 'deploy', text: 'All done' };

describe('authentication and edge policy', () => {
  it('signs expiring sessions and rejects tampering and rotated keys', async () => {
    const token = await createSession('master');
    expect(await verifySession(token, 'master')).toBe(true);
    expect(await verifySession(token, 'rotated')).toBe(false);
    expect(await verifySession(token.replace(/^\d+/, '99999999999999'), 'master')).toBe(false);
    expect(await verifySession(token + 'extra', 'master')).toBe(false);
    expect(await equalSecret('', '')).toBe(false);
    expect(await equalSecret('correct', 'correct')).toBe(true);
  });
  it('matches IPv4, IPv6, mapped addresses and CIDR boundaries', () => {
    expect(matchesIp('203.0.113.8', '203.0.113.0/24')).toBe(true);
    expect(matchesIp('203.0.114.8', '203.0.113.0/24')).toBe(false);
    expect(matchesIp('2001:db8:abcd::1', '2001:db8::/32')).toBe(true);
    expect(matchesIp('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(matchesIp('::ffff:192.0.2.7', '192.0.2.0/24')).toBe(true);
    expect(matchesIp('unknown', '0.0.0.0/0')).toBe(false);
  });
  it('does not trust local spoofed forwarding headers', () => {
    const context = sourceContext(new Request('http://localhost', { headers: { 'CF-Connecting-IP': '8.8.8.8', 'CF-IPCountry': 'US', 'X-Forwarded-For': '8.8.8.8' } }));
    expect(context).toEqual({ ip: '127.0.0.1', country: 'XX', source: 'api' });
  });
  it('applies both policies and fails closed with unknown geolocation', () => {
    expect(() => checkAccess({ ...DEFAULT_SETTINGS, ipMode: 'allow', ipRules: ['203.0.113.0/24'], countryMode: 'allow', countries: ['DE'] }, source)).not.toThrow();
    expect(() => checkAccess({ ...DEFAULT_SETTINGS, ipMode: 'deny', ipRules: ['203.0.113.8'] }, source)).toThrow();
    expect(() => checkAccess({ ...DEFAULT_SETTINGS, countryMode: 'deny', countries: ['IR'] }, { ...source, country: 'XX' })).toThrow();
  });
});

describe('payload validation', () => {
  it('normalizes defaults, dates and harmless plain text', () => {
    const result = notificationInput({ ...payload, text: '<script>alert(1)</script>', timestamp: '2026-09-12T10:30:00+03:30' }, source);
    expect(result.timestamp).toBe('2026-09-12T07:00:00.000Z');
    expect(result.level).toBe('info');
    expect(result.text).toContain('<script>');
  });
  it('rejects invalid levels, URLs, oversized content and non-scalar metadata', () => {
    for (const bad of [{ level: 'fatal' }, { image: 'http://bad.test/image.png' }, { url: 'javascript:alert(1)' }, { text: 'x'.repeat(3001) }, { metadata: { nested: {} } }, { timestamp: 'yesterday' }, { timestamp: '2026-02-30T12:00:00Z' }, { chat_id: 123 }, { silent: 'yes' }])
      expect(() => notificationInput({ ...payload, ...bad }, source)).toThrow();
    expect(() => notificationInput({ ...payload, metadata: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, 'x'.repeat(500)])) }, source)).toThrow();
  });
  it('rejects malformed policies and accepts a valid partial settings update', () => {
    expect(settingsInput({ paused: true }, DEFAULT_SETTINGS).paused).toBe(true);
    for (const bad of [{ ipMode: 'allow', ipRules: [] }, { ipRules: ['256.1.1.1'] }, { countries: ['garbage'] }, { retentionDays: 2 }, { deliveryPerSecond: 30 }, { paused: 'false' }])
      expect(() => settingsInput(bad, DEFAULT_SETTINGS)).toThrow();
  });
  it('adapts firing/resolved Alertmanager and Grafana requests', () => {
    const [firing, resolved] = alertmanagerInputs({ alerts: [
      { status: 'firing', labels: { app: 'api', alertname: 'DiskFull', severity: 'critical' }, annotations: { description: 'Disk is full' }, startsAt: '2026-09-12T10:30:00.123456789Z' },
      { status: 'resolved', labels: { alertname: 'DiskFull' }, annotations: {}, endsAt: '2026-09-12T12:00:00Z' },
    ] }, source);
    expect(firing.level).toBe('critical'); expect(resolved.level).toBe('success');
    expect(firing.timestamp).toBe('2026-09-12T10:30:00.123Z');
    expect(grafanaInput({ status: 'resolved', title: 'Recovered', message: 'API is healthy' }, source).event).toBe('alert.resolved');
    expect(() => alertmanagerInputs({ alerts: [] }, source)).toThrow();
  });
});
