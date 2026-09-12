import {env} from 'cloudflare:workers';
import type {Env} from '../src/types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {reset, SELF} from 'cloudflare:test';
import app from '../src/index';

const origin = 'https://relay.test';
const adminKey = 'test-admin-key-which-is-not-a-production-secret';
let ingestKey: string;
const payload = {application: 'payments', event: 'deploy.succeeded', level: 'success', text: 'Version 1 is ready.'};

async function request(path: string, init: RequestInit = {}) {
  return SELF.fetch(`${origin}${path}`, init);
}

async function login(key = adminKey) {
  return request('/api/admin/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: origin},
    body: JSON.stringify({apiKey: key})
  });
}

async function cookie() {
  return (await login()).headers.get('Set-Cookie')!.split(';')[0];
}

let authHeaders: Record<string, string>;
beforeEach(async () => {
  const registry = (env as unknown as Env).TENANTS.getByName('registry');
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    ok: true,
    result: {id: 123456, is_bot: true, username: 'fixture_bot'}
  })));
  try {
    await registry.configureBot('default', '123456:test-token');
  } finally {
    mock.mockRestore();
  }
  ingestKey = (await registry.createApplication('default', {id: 'test-integration', name: 'Test integration'})).apiKey;
  authHeaders = {Authorization: `Bearer ${ingestKey}`, 'Content-Type': 'application/json'};
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('HTTP API and persistent state', () => {
  it('preserves the fresh dashboard nonce through middleware without weakening API authentication', async () => {
    const bindings = {
      ...env, ASSETS: {
        fetch: async () => new Response('<!doctype html><script src="/app.js"></script>', {
          headers: {'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self'", ETag: '"static"'},
        })
      }
    } as unknown as Env;
    const res = await app.fetch(new Request(`${origin}/`), bindings);
    const policy = res.headers.get('Content-Security-Policy')!;
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(await res.text()).toContain(`nonce="${nonce}"`);
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain(',');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('ETag')).toBeNull();
    expect((await request('/api/admin/overview')).status).toBe(401);
  });
  it('requires auth and rejects an ingestion key from admin login', async () => {
    expect((await request('/api/admin/overview')).status).toBe(401);
    expect((await request('/api/v1/notifications', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    })).status).toBe(401);
    expect((await login('bad')).status).toBe(401);
    expect((await login(ingestKey)).status).toBe(401);
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toMatch(/HttpOnly/);
    expect(res.headers.get('Set-Cookie')).toMatch(/Secure/);
    expect(res.headers.get('Set-Cookie')).toMatch(/SameSite=Strict/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
  it('returns generic login errors for invalid and missing credentials', async () => {
    for (const body of [{apiKey: 'submitted-invalid-secret'}, {}, {apiKey: ''}, {apiKey: null}]) {
      const res = await request('/api/admin/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Origin: origin},
        body: JSON.stringify(body)
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({error: {code: 'INVALID_KEY', message: 'اطلاعات ورود معتبر نیست.'}});
      expect(res.headers.get('Set-Cookie')).toBeNull();
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('keeps login and session bootstrap errors generic when authentication is unavailable', async () => {
    const bindings = {...env, API_KEY: ''} as unknown as Env;
    for (const path of ['/api/admin/login', '/api/admin/session']) {
      const init = path.endsWith('/login') ? {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Origin: origin},
        body: JSON.stringify({apiKey: 'submitted-secret'})
      } : {};
      const res = await app.fetch(new Request(`${origin}${path}`, init), bindings);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: {
          code: 'AUTH_UNAVAILABLE',
          message: 'امکان ورود وجود ندارد؛ کمی بعد دوباره تلاش کنید.'
        }
      });
      expect(res.headers.get('Set-Cookie')).toBeNull();
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('reports an absent or invalid session without an authentication error', async () => {
    for (const session of [undefined, '__Host-relay_session=invalid', '__Host-relay_session=1.invalid']) {
      const res = await request('/api/admin/session', {headers: session ? {Cookie: session} : {}});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({authenticated: false});
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Set-Cookie')).toBeNull();
      expect((await request('/api/admin/overview', {headers: session ? {Cookie: session} : {}})).status).toBe(401);
    }
    const res = await request('/api/admin/session', {headers: {Cookie: await cookie()}});
    expect(await res.json()).toEqual({authenticated: true});
  });
  it('preserves login origin checks and the ten-attempt rate limit', async () => {
    const rejectedOrigin = await request('/api/admin/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: 'https://evil.test'},
      body: JSON.stringify({apiKey: adminKey})
    });
    expect(rejectedOrigin.status).toBe(403);
    expect(rejectedOrigin.headers.get('Set-Cookie')).toBeNull();
    for (let attempt = 0; attempt < 10; attempt++) expect((await login('bad')).status).toBe(401);
    const limited = await login();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.headers.get('Set-Cookie')).toBeNull();
    expect(await limited.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'تلاش‌های ورود زیاد است؛ یک دقیقه صبر کنید.'
      }
    });
  });
  it('requires same-origin mutations and clears login on logout', async () => {
    const session = await cookie();
    expect((await request('/api/admin/session', {headers: {Cookie: session}})).status).toBe(200);
    expect((await request('/api/admin/settings', {
      method: 'PUT',
      headers: {Cookie: session, 'Content-Type': 'application/json', Origin: 'https://evil.test'},
      body: '{}'
    })).status).toBe(403);
    const logout = await request('/api/admin/logout', {method: 'POST', headers: {Cookie: session, Origin: origin}});
    expect(logout.status).toBe(200);
    expect(logout.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
  });
  it('accepts an empty audience honestly, deduplicates retries and rejects key reuse with changed payload', async () => {
    const headers = {...authHeaders, 'Idempotency-Key': 'deploy-123'};
    const first = await request('/api/v1/notifications', {method: 'POST', headers, body: JSON.stringify(payload)});
    expect(first.status).toBe(202);
    const body = await first.json() as any;
    expect(body.notification.total).toBe(0);
    expect(body.notification.status).toBe('empty');
    const retry = await request('/api/v1/notifications', {method: 'POST', headers, body: JSON.stringify(payload)});
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).notification.id).toBe(body.notification.id);
    const conflict = await request('/api/v1/notifications', {
      method: 'POST',
      headers,
      body: JSON.stringify({...payload, text: 'Different content'})
    });
    expect(conflict.status).toBe(409);
    const detail = await request(`/api/v1/notifications/${body.notification.id}`, {headers: authHeaders});
    expect((await detail.json() as any).notification.id).toBe(body.notification.id);
  });
  it('persists settings, blocks ingest via country, leaves admin and Telegram webhook accessible', async () => {
    const session = await cookie();
    const changed = await request('/api/admin/settings', {
      method: 'PUT',
      headers: {Cookie: session, Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({projectName: 'My project', countryMode: 'allow', countries: ['AQ']})
    });
    expect(changed.status).toBe(200);
    expect((await request('/api/v1/notifications', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(payload)
    })).status).toBe(403);
    expect((await request('/api/admin/settings', {headers: {Cookie: session}})).status).toBe(200);
    expect((await request('/telegram/webhook', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'},
      body: JSON.stringify({update_id: 1})
    })).status).toBe(200);
    expect((await request('/telegram/webhook', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({update_id: 2})
    })).status).toBe(401);
  });
  it('rejects invalid and oversized input before creating any notifications', async () => {
    expect((await request('/api/v1/notifications', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({text: 'Missing fields'})
    })).status).toBe(400);
    expect((await request('/api/v1/notifications', {
      method: 'POST',
      headers: authHeaders,
      body: '{invalid'
    })).status).toBe(400);
    expect((await request('/api/v1/notifications', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({...payload, text: 'x'.repeat(66000)})
    })).status).toBe(413);
    const result = await request('/api/admin/overview', {headers: {Cookie: await cookie()}});
    expect((await result.json() as any).notifications.total).toBe(0);
  });
  it('ingests native integrations', async () => {
    const am = await request('/api/v1/integrations/alertmanager', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        alerts: [{
          status: 'firing',
          labels: {alertname: 'HighLatency'},
          annotations: {summary: 'Slow API'}
        }]
      })
    });
    expect(am.status).toBe(202);
    const grafana = await request('/api/v1/integrations/grafana', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({status: 'resolved', title: 'Recovered', message: 'All clear'})
    });
    expect(grafana.status).toBe(202);
  });
  it('includes resolved Alertmanager event time in idempotency conflicts', async () => {
    const headers = {...authHeaders, 'Idempotency-Key': 'resolved-event'};
    const alert = {status: 'resolved', labels: {alertname: 'Recovered'}, endsAt: '2026-09-12T12:00:00.123456789Z'};
    const first = await request('/api/v1/integrations/alertmanager', {
      method: 'POST',
      headers,
      body: JSON.stringify({alerts: [alert]})
    });
    expect(first.status).toBe(202);
    const changed = await request('/api/v1/integrations/alertmanager', {
      method: 'POST',
      headers,
      body: JSON.stringify({alerts: [{...alert, endsAt: '2026-09-12T13:00:00Z'}]})
    });
    expect(changed.status).toBe(409);
  });
});


describe('tenant and application boundaries', () => {
  async function admin(session: string, path: string, method = 'GET', data?: unknown) {
    return request(`/api/admin${path}`, {
      method,
      headers: {
        Cookie: session,
        Origin: origin,
        'Content-Type': 'application/json'
      }, ...(data === undefined ? {} : {body: JSON.stringify(data)})
    });
  }

  it('creates isolated tenants/apps and authenticates the application from its header key', async () => {
    const session = await cookie();
    const created = await admin(session, '/tenants', 'POST', {id: 'team-one', name: 'Team One'});
    expect(created.status).toBe(201);
    expect(Object.keys(await created.json() as object)).toEqual(['tenant']);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      result: {id: 987654, is_bot: true, username: 'team_one_bot'}
    })));
    const configured = await admin(session, '/tenants/team-one/bot', 'PUT', {botToken: '987654:test-token'});
    expect(configured.status).toBe(200);
    expect(await configured.text()).not.toContain('987654:test-token');
    const first = await (await admin(session, '/tenants/team-one/applications', 'POST', {
      id: 'deploy',
      name: 'Deployments'
    })).json() as any;
    const second = await (await admin(session, '/tenants/team-one/applications', 'POST', {
      id: 'monitor',
      name: 'Monitoring'
    })).json() as any;
    const path = '/api/v1/tenants/team-one/notifications';
    for (const key of [ingestKey, adminKey]) expect((await request(path, {
      method: 'POST',
      headers: {...authHeaders, Authorization: `Bearer ${key}`},
      body: JSON.stringify(payload)
    })).status).toBe(401);
    const headers = {'X-API-Key': first.apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': 'same-build'};
    const result = await request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({...payload, application: 'Spoofed name'})
    });
    expect(result.status).toBe(202);
    const notice = (await result.json() as any).notification;
    expect(notice).toMatchObject({application: 'Deployments', applicationId: 'deploy', total: 0});
    const other = await request(path, {
      method: 'POST',
      headers: {...headers, 'X-API-Key': second.apiKey},
      body: JSON.stringify(payload)
    });
    expect(other.status).toBe(202);
    expect((await other.json() as any).notification.id).not.toBe(notice.id);
    expect((await request(`${path}/${notice.id}`, {headers: {'X-API-Key': second.apiKey}})).status).toBe(404);
    expect((await request('/api/v1/notifications', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })).status).toBe(401);
    const defaultReport = await (await admin(session, '/tenants/default/overview')).json() as any;
    const tenantReport = await (await admin(session, '/tenants/team-one/overview')).json() as any;
    expect(defaultReport.notifications.total).toBe(0);
    expect(tenantReport.notifications.total).toBe(2);
    const composed = await admin(session, '/tenants/team-one/notifications', 'POST', {
      ...payload,
      applicationId: 'deploy'
    });
    expect(composed.status).toBe(202);
    expect((await composed.json() as any).notification.applicationId).toBe('deploy');
    await admin(session, '/tenants/team-one', 'PATCH', {enabled: false});
    expect((await request(path, {method: 'POST', headers, body: JSON.stringify(payload)})).status).toBe(403);
    expect((await admin(session, '/tenants/missing/overview')).status).toBe(404);
  });
  it('enforces aggregate tenant request limits and exposes ban changes immediately', async () => {
    const session = await cookie();
    const created = await (await admin(session, '/tenants/default/applications', 'POST', {
      id: 'monitor',
      name: 'Monitoring'
    })).json() as any;
    await admin(session, '/tenants/default', 'PATCH', {limits: {requestsPerMinute: 1}});
    const headers = {'X-API-Key': created.apiKey, 'Content-Type': 'application/json'};
    expect((await request('/api/v1/tenants/default/notifications', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })).status).toBe(202);
    expect((await request('/api/v1/tenants/default/notifications', {
      method: 'POST',
      headers: {...headers, 'CF-Connecting-IP': '192.0.2.22'},
      body: JSON.stringify(payload)
    })).status).toBe(429);
    expect((await admin(session, '/tenants/default/settings', 'PUT', {
      paused: true,
      welcomeMessage: ''
    })).status).toBe(200);
    await request('/telegram/default/webhook', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'},
      body: JSON.stringify({update_id: 77, message: {chat: {id: 333, type: 'private'}, text: '/start'}})
    });
    expect((await admin(session, '/tenants/default/subscribers/ban', 'POST', {
      chatIds: ['333'],
      banned: true,
      reason: 'Abuse'
    })).status).toBe(200);
    const subscribers = await (await admin(session, '/tenants/default/subscribers')).json() as any;
    expect(subscribers.items[0]).toMatchObject({chatId: '333', active: false, banned: true, banReason: 'Abuse'});
    expect((await admin(session, '/tenants/default/subscribers/ban', 'POST', {
      chatIds: [],
      banned: true
    })).status).toBe(400);
  });
  it('edits subscriber profiles and policies through both scoped routes with stale-write protection', async () => {
    const session = await cookie();
    await admin(session, '/settings', 'PUT', {paused: true, welcomeMessage: ''});
    const webhook = (updateId: number, firstName: string) => request('/telegram/default/webhook', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'},
      body: JSON.stringify({update_id: updateId, message: {chat: {id: 333, type: 'private'}, from: {id: 333, first_name: firstName, username: 'operator'}, text: '/start'}})
    });
    expect((await webhook(700, 'Telegram name')).status).toBe(200);
    const original = (await (await admin(session, '/subscribers/333')).json() as any).subscriber;
    expect(original).toMatchObject({displayName: null, notes: '', accessMode: 'all', allowedApplicationIds: [], version: 1});
    const edited = await admin(session, '/tenants/default/subscribers/333', 'PATCH', {
      expectedVersion: original.version, displayName: '  تیم عملیات  ', notes: 'Internal support contact', accessMode: 'selected', allowedApplicationIds: ['test-integration']
    });
    expect(edited.status).toBe(200);
    expect(edited.headers.get('Cache-Control')).toBe('no-store');
    expect((await edited.json() as any).subscriber).toMatchObject({displayName: 'تیم عملیات', notes: 'Internal support contact', firstName: 'Telegram name', username: 'operator', version: 2, accessMode: 'selected', allowedApplicationIds: ['test-integration']});
    const stale = await admin(session, '/subscribers/333', 'PATCH', {expectedVersion: 1, notes: 'Stale overwrite'});
    expect(stale.status).toBe(409);
    expect((await stale.json() as any).error.code).toBe('STALE_SUBSCRIBER');
    expect((await webhook(701, 'Updated Telegram name')).status).toBe(200);
    const rejoined = (await (await admin(session, '/subscribers/333')).json() as any).subscriber;
    expect(rejoined).toMatchObject({firstName: 'Updated Telegram name', displayName: 'تیم عملیات', notes: 'Internal support contact', accessMode: 'selected', allowedApplicationIds: ['test-integration']});
    const searched = await admin(session, '/subscribers?search=' + encodeURIComponent('عملیات'));
    expect((await searched.json() as any)).toMatchObject({total: 1, items: [{chatId: '333', displayName: 'تیم عملیات'}]});
    expect((await (await admin(session, '/subscribers?search=%25')).json() as any).total).toBe(0);
    const restricted = await admin(session, '/subscribers/333', 'PATCH', {expectedVersion: rejoined.version, accessMode: 'selected', allowedApplicationIds: []});
    expect(restricted.status).toBe(200);
    const sent = await request('/api/v1/notifications', {method: 'POST', headers: authHeaders, body: JSON.stringify(payload)});
    expect((await sent.json() as any).notification.total).toBe(0);
  });

  it('protects subscriber updates and rejects invalid or cross-tenant access without partial writes', async () => {
    const session = await cookie();
    await admin(session, '/settings', 'PUT', {paused: true, welcomeMessage: ''});
    await request('/telegram/default/webhook', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'},
      body: JSON.stringify({update_id: 710, message: {chat: {id: 444, type: 'private'}, text: '/start'}})
    });
    expect((await request('/api/admin/subscribers/444')).status).toBe(401);
    expect((await request('/api/admin/subscribers/444', {method: 'PATCH', headers: {...authHeaders}, body: JSON.stringify({expectedVersion: 1, notes: 'No'})})).status).toBe(401);
    expect((await request('/api/admin/subscribers/444', {method: 'PATCH', headers: {Cookie: session, Origin: 'https://evil.test', 'Content-Type': 'application/json'}, body: JSON.stringify({expectedVersion: 1, notes: 'No'})})).status).toBe(403);
    await admin(session, '/tenants', 'POST', {id: 'other-team', name: 'Other team'});
    await admin(session, '/tenants/other-team/applications', 'POST', {id: 'private-app', name: 'Private app'});
    expect((await admin(session, '/tenants/other-team/subscribers/444')).status).toBe(404);
    for (const patch of [
      {notes: 'Missing version'}, {expectedVersion: 1, firstName: 'Overwritten'},
      {expectedVersion: 1, accessMode: 'selected'}, {expectedVersion: 1, allowedApplicationIds: []},
      {expectedVersion: 1, accessMode: 'all', allowedApplicationIds: ['test-integration']},
      {expectedVersion: 1, accessMode: 'selected', allowedApplicationIds: ['private-app']},
      {expectedVersion: 1, accessMode: 'selected', allowedApplicationIds: ['test-integration', 'test-integration']},
    ]) {
      const rejected = await admin(session, '/subscribers/444', 'PATCH', patch);
      expect(rejected.status).toBe(400);
      expect((await rejected.json() as any).error.code).toBe('INVALID_SUBSCRIBER');
    }
    expect((await (await admin(session, '/subscribers/444')).json() as any).subscriber).toMatchObject({version: 1, notes: '', accessMode: 'all'});
    for (const path of ['/subscribers/invalid', '/subscribers?search=' + 'x'.repeat(101)]) expect((await admin(session, path)).status).toBe(400);
    const missing = await admin(session, '/subscribers/999', 'PATCH', {expectedVersion: 1, notes: 'Missing'});
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error.code).toBe('SUBSCRIBER_NOT_FOUND');
  });

  it('creates application audiences atomically and preserves hidden applications for allowed deliveries', async () => {
    const session = await cookie();
    await admin(session, '/settings', 'PUT', {paused: true, welcomeMessage: ''});
    for (const id of [551, 552]) await request('/telegram/default/webhook', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'},
      body: JSON.stringify({update_id: id, message: {chat: {id, type: 'private'}, text: '/start'}})
    });
    const created = await admin(session, '/applications', 'POST', {id: 'private-release', name: 'Private release', audienceMode: 'selected', audienceChatIds: ['551'], showInDirectory: false});
    expect(created.status).toBe(201);
    const {application, apiKey} = await created.json() as any;
    expect(application).toMatchObject({audienceMode: 'selected', audienceChatIds: ['551'], showInDirectory: false});
    const send = async () => (await request('/api/v1/notifications', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-API-Key': apiKey}, body: JSON.stringify(payload)})).json() as Promise<any>;
    expect((await send()).notification.total).toBe(1);
    const updated = await admin(session, '/applications/private-release', 'PATCH', {expectedVersion: application.version, audienceMode: 'selected', audienceChatIds: []});
    expect(updated.status).toBe(200);
    expect((await send()).notification.total).toBe(0);
    expect((await admin(session, '/applications', 'POST', {id: 'bad-audience', name: 'Bad audience', audienceMode: 'selected', audienceChatIds: ['99999']})).status).toBe(400);
    const list = (await (await admin(session, '/applications')).json() as any).applications;
    expect(list.some((item: any) => item.id === 'bad-audience')).toBe(false);
  });

  it('routes Telegram application choices through the authenticated webhook before API fanout', async () => {
    const session = await cookie();
    expect((await admin(session, '/tenants/default/settings', 'PUT', {
      paused: true,
      welcomeMessage: ''
    })).status).toBe(200);
    const billing = await (await admin(session, '/tenants/default/applications', 'POST', {
      id: 'billing',
      name: 'Billing'
    })).json() as any;
    const ops = await (await admin(session, '/tenants/default/applications', 'POST', {
      id: 'operations',
      name: 'Operations'
    })).json() as any;
    let updateId = 100;
    const webhook = (data: object) => request('/telegram/default/webhook', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret'},
      body: JSON.stringify({update_id: ++updateId, ...data})
    });
    for (const id of [11, 22]) expect((await webhook({
      message: {
        chat: {id, type: 'private'},
        from: {id},
        text: '/start'
      }
    })).status).toBe(200);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      result: true
    })));
    expect((await webhook({
      callback_query: {
        id: 'choice-11',
        from: {id: 11},
        message: {message_id: 10, chat: {id: 11, type: 'private'}},
        data: 'apps:toggle:billing'
      }
    })).status).toBe(200);
    const send = async (apiKey: string) => (await request('/api/v1/tenants/default/notifications', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-API-Key': apiKey},
      body: JSON.stringify({event: 'test', text: 'Hello'})
    })).json() as Promise<any>;
    expect((await send(billing.apiKey)).notification.total).toBe(2);
    expect((await send(ops.apiKey)).notification.total).toBe(1);
    const subscribers = await (await admin(session, '/tenants/default/subscribers')).json() as any;
    expect(subscribers.items.find((row: any) => row.chatId === '11')).toMatchObject({
      applicationMode: 'selected',
      applicationIds: ['billing']
    });
    expect((await webhook({
      message: {
        chat: {id: 11, type: 'private'},
        from: {id: 11},
        text: '/all'
      }
    })).status).toBe(200);
    expect((await send(ops.apiKey)).notification.total).toBe(2);
  });

});
