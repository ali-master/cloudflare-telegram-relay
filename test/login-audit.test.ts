import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import type { Env, LoginAuditInput, LoginAuditPage } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://relay.test';
const adminKey = 'test-admin-key-which-is-not-a-production-secret';
const registry = () => bindings.TENANTS.getByName('registry');
const sample: LoginAuditInput = { ip: '203.0.113.8', country: 'DE', userAgent: 'Test browser', requestId: null, outcome: 'invalid_key' };
async function login(body: unknown, headers: Record<string, string> = {}, country?: string, context = bindings) {
  const request = new Request(`${origin}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
    ...(country === undefined ? {} : { cf: { country } }),
  });
  return app.fetch(request, context);
}
async function report(cookie?: string, query = '') {
  return app.fetch(new Request(`${origin}/api/admin/login-audit${query}`, { headers: cookie ? { Cookie: cookie } : {} }), bindings);
}
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe('failed login audit', () => {
  it('records bounded trusted metadata for incorrect and missing keys without credentials or successful logins', async () => {
    const headers = {
      'CF-Connecting-IP': '203.0.113.18', 'CF-IPCountry': 'US', 'X-Forwarded-For': '1.2.3.4',
      'User-Agent': 'Browser/'.repeat(100), 'CF-Ray': '0123456789abcdef-FRA', Cookie: 'private-session-cookie',
      Authorization: 'Bearer private-authorization-header',
    };
    expect((await login({ apiKey: 'submitted-invalid-credential', password: 'never-store-body' }, headers, 'de')).status).toBe(401);
    expect((await login({}, headers, 'de')).status).toBe(401);
    expect((await login({ apiKey: adminKey }, headers, 'de')).status).toBe(200);
    const page = await registry().listLoginAudit();
    expect(page.total).toBe(2);
    expect(page.entries[0]).toMatchObject({ ip: '203.0.113.18', country: 'DE', requestId: '0123456789abcdef-FRA', outcome: 'invalid_key' });
    expect(page.entries[0].userAgent.length).toBe(512);
    expect(Date.parse(page.entries[0].createdAt)).toBeGreaterThan(Date.now() - 10_000);
    const stored = await runInDurableObject(registry(), async (_instance, state) => JSON.stringify(state.storage.sql.exec('SELECT * FROM login_audit').toArray()));
    for (const secret of ['submitted-invalid-credential', 'never-store-body', 'private-session-cookie', 'private-authorization-header', adminKey, 'apiKey', 'key_hash']) expect(stored).not.toContain(secret);
  });

  it('does not trust spoofed forwarding and country headers without edge metadata', async () => {
    await login({ apiKey: 'wrong' }, { 'CF-Connecting-IP': '8.8.8.8', 'CF-IPCountry': 'IR', 'CF-Ray': '0123456789abcdef-IKA' });
    expect((await registry().listLoginAudit()).entries[0]).toMatchObject({ ip: '127.0.0.1', country: 'XX', requestId: null });
  });

  it('protects the report with admin authentication and paginates and filters persisted entries', async () => {
    expect((await report()).status).toBe(401);
    expect((await report(undefined, '?limit=invalid')).status).toBe(401);
    const session = (await login({ apiKey: adminKey })).headers.get('Set-Cookie')!.split(';')[0];
    await registry().recordLoginAttempt(sample);
    await registry().recordLoginAttempt({ ...sample, ip: '203.0.113.9', country: 'IR' });
    await registry().recordLoginAttempt({ ...sample, ip: '203.0.113.9', country: 'IR', outcome: 'rate_limited' });
    const all = await report(session);
    expect(all.status).toBe(200);
    expect(all.headers.get('Cache-Control')).toBe('no-store');
    expect(await all.json()).toMatchObject({ total: 3, limit: 25, offset: 0 });
    const first = await (await report(session, '?limit=1')).json() as LoginAuditPage;
    const second = await (await report(session, '?limit=1&offset=1')).json() as LoginAuditPage;
    expect(first.entries[0].id).not.toBe(second.entries[0].id);
    expect(first.entries[0].outcome).toBe('rate_limited');
    const filtered = await (await report(session, '?country=ir&ip=203.0.113.9&outcome=invalid_key')).json() as LoginAuditPage;
    expect(filtered.total).toBe(1);
    expect(filtered.entries[0]).toMatchObject({ country: 'IR', ip: '203.0.113.9', outcome: 'invalid_key' });
    for (const query of ['?limit=101', '?limit=0', '?offset=-1', '?offset=5001', '?country=wrong', '?outcome=success', '?ip=' + 'x'.repeat(65)]) expect((await report(session, query)).status).toBe(400);
  });

  it('labels rate-limited requests separately because their keys were not verified', async () => {
    for (let attempt = 0; attempt < 10; attempt++) expect((await login({ apiKey: 'wrong' })).status).toBe(401);
    const limited = await login({ apiKey: adminKey });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    const page = await registry().listLoginAudit();
    expect(page.total).toBe(11);
    expect(page.entries.filter(entry => entry.outcome === 'invalid_key')).toHaveLength(10);
    expect(page.entries[0].outcome).toBe('rate_limited');
  });

  it('keeps authentication failures generic if audit storage fails and logs no error details', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context = { ...bindings, TENANTS: { getByName: () => ({ recordLoginAttempt: async () => { throw new Error('private-storage-diagnostic'); } }) } } as unknown as Env;
    const result = await login({ apiKey: 'submitted-credential' }, {}, undefined, context);
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: { code: 'INVALID_KEY', message: 'اطلاعات ورود معتبر نیست.' } });
    expect(warning.mock.calls).toEqual([['Login audit write failed.']]);
  });

  it('retains audit records across eviction and expires them in bounded alarm batches', async () => {
    await registry().recordLoginAttempt(sample);
    await evictDurableObject(registry());
    expect((await registry().listLoginAudit()).total).toBe(1);
    await runInDurableObject(registry(), async (_instance, state) => {
      const expired = new Date(Date.now() - 31 * 86_400_000).toISOString();
      state.storage.sql.exec(`INSERT INTO login_audit (created_at, ip, country, user_agent, request_id, outcome)
        WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 205)
        SELECT ?, 'old-ip', 'XX', '', NULL, 'invalid_key' FROM seq`, expired);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    // Expired rows are invisible immediately, before physical batch deletion finishes.
    expect((await registry().listLoginAudit()).total).toBe(1);
    expect(await runDurableObjectAlarm(registry())).toBe(true);
    const remaining = await runInDurableObject(registry(), async (_instance, state) => ({
      count: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM login_audit').one().count,
      next: await state.storage.getAlarm(),
    }));
    expect(remaining.count).toBe(106);
    expect(remaining.next).not.toBeNull();
    await runDurableObjectAlarm(registry());
    await runDurableObjectAlarm(registry());
    expect(await runInDurableObject(registry(), async (_instance, state) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM login_audit').one().count)).toBe(1);
  });

  it('caps physical storage at 5000 newest attempts and bounds arbitrary RPC metadata', async () => {
    await registry().recordLoginAttempt(sample);
    await runInDurableObject(registry(), async (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO login_audit (created_at, ip, country, user_agent, request_id, outcome)
        WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 4999)
        SELECT ?, 'prior-ip', 'XX', '', NULL, 'invalid_key' FROM seq`, new Date().toISOString());
    });
    await registry().recordLoginAttempt({ ...sample, ip: 'x'.repeat(100), country: 'INVALID', requestId: 'arbitrary-secret', userAgent: 'x'.repeat(1000), ...({ apiKey: 'discard-extra-property' } as object) });
    const page = await registry().listLoginAudit();
    expect(page.total).toBe(5000);
    expect(page.entries[0]).toMatchObject({ ip: 'x'.repeat(64), country: 'XX', requestId: null, userAgent: 'x'.repeat(512) });
    const rows = await runInDurableObject(registry(), async (_instance, state) => state.storage.sql.exec<{ count: number; first: number }>('SELECT COUNT(*) AS count, MIN(id) AS first FROM login_audit').one());
    expect(rows).toEqual({ count: 5000, first: 2 });
    expect((await registry().listLoginAudit({ limit: 100, offset: 5000 })).entries).toEqual([]);
  });
});
