import {env} from 'cloudflare:workers';
import {reset, SELF} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hubName, type Env} from '../src/types';

const origin = 'https://relay.test';
const bindings = env as unknown as Env;
let session: string;
let applicationKey: string;

async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${origin}${path}`, {
    method,
    headers: {Cookie: session, Origin: origin, 'Content-Type': 'application/json', ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
}

async function data(path: string, method = 'GET', body?: unknown) {
  const response = await request(path, method, body);
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

const path = (suffix: string, tenant = 'default') => `/api/admin/tenants/${tenant}/${suffix}`;

beforeEach(async () => {
  const login = await SELF.fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({apiKey: 'test-admin-key-which-is-not-a-production-secret'}),
  });
  session = login.headers.get('Set-Cookie')!.split(';')[0];
  const registry = bindings.TENANTS.getByName('registry');
  applicationKey = (await registry.createApplication('default', {id: 'payments', name: 'Payments'})).apiKey;
  await registry.createTenant({id: 'operations', name: 'Operations'});
  await registry.createApplication('operations', {id: 'private-app', name: 'Private operations app'});
  const hub = bindings.HUB.getByName(hubName('default'));
  await hub.initializeTenant('default');
  await hub.updateSettings({...await hub.getSettings(), paused: true, welcomeMessage: ''});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('automation administration boundaries', () => {
  it('requires the dashboard session and same-origin writes', async () => {
    for (const resource of ['automation', 'incidents', 'incidents/overview', 'subscribers/123/preferences']) {
      const response = await request(path(resource), 'GET', undefined, {Cookie: '', 'X-API-Key': applicationKey});
      expect(response.status).toBe(401);
    }
    for (const [resource, method, body] of [
      ['automation', 'PUT', {expectedVersion: 0}],
      ['automation?applicationId=payments&expectedVersion=0', 'DELETE', undefined],
      ['automation/preview', 'POST', {applicationId: 'payments', level: 'info'}],
      ['incidents/missing/actions', 'POST', {action: 'resolve', expectedVersion: 0}],
      ['subscribers/123/preferences', 'PUT', {expectedVersion: 0}],
    ] as const) {
      expect((await request(path(resource), method, body, {Origin: 'https://other.test'})).status).toBe(403);
    }
  });

  it('versions tenant defaults and application overrides independently, including reset', async () => {
    const initial = await data(path('automation'));
    expect(initial.policy.grouping.enabled).toBe(false);
    const updated = await data(path('automation'), 'PUT', {expectedVersion: initial.policy.version, grouping: {enabled: true, windowSeconds: 300}});
    expect(updated.policy.grouping.enabled).toBe(true);
    expect((await request(path('automation'), 'PUT', {expectedVersion: initial.policy.version, grouping: {enabled: false, windowSeconds: 300}})).status).toBe(409);
    const inherited = await data(path('automation?applicationId=payments'));
    expect(inherited.inherited).toBe(true);
    expect(inherited.policy.grouping.enabled).toBe(true);
    const override = await data(path('automation?applicationId=payments'), 'PUT', {expectedVersion: inherited.policy.version, grouping: {enabled: false, windowSeconds: 60}});
    expect(override.inherited).toBe(false);
    expect((await data(path('automation'))).policy.grouping.enabled).toBe(true);
    const restored = await data(path(`automation?applicationId=payments&expectedVersion=${override.policy.version}`), 'DELETE');
    expect(restored.inherited).toBe(true);
    expect(restored.policy.grouping.enabled).toBe(true);
    expect((await data(path('automation', 'operations'))).policy.grouping.enabled).toBe(false);
    expect((await request(path('automation?applicationId=private-app'))).status).toBe(404);
    expect((await request(path('automation?applicationId=private-app'), 'PUT', {expectedVersion: 0})).status).toBe(404);
  });

  it('stores subscriber preferences with conflicts and validates preview without enqueuing', async () => {
    const hub = bindings.HUB.getByName(hubName('default'));
    await hub.handleUpdate({update_id: 1, message: {chat: {id: 123, type: 'private'}, from: {id: 123, first_name: 'Tester'}, text: '/start'}});
    const initial = await data(path('subscribers/123/preferences'));
    const updated = await data(path('subscribers/123/preferences'), 'PUT', {
      expectedVersion: initial.preferences.version, levels: ['error', 'critical'], environments: ['production'],
    });
    expect(updated.preferences.levels).toEqual(['error', 'critical']);
    expect((await request(path('subscribers/123/preferences'), 'PUT', {expectedVersion: initial.preferences.version, levels: ['info']})).status).toBe(409);
    expect((await request(path('subscribers/999/preferences'))).status).toBe(404);
    expect((await request(path('subscribers/missing/preferences'))).status).toBe(400);
    const before = await data(path('notifications'));
    const muted = await data(path('automation/preview'), 'POST', {applicationId: 'payments', chatId: '123', level: 'info', environment: 'production'});
    expect(muted.mode).toBe('mute');
    const immediate = await data(path('automation/preview'), 'POST', {applicationId: 'payments', chatId: '123', level: 'error', environment: 'production'});
    expect(immediate.mode).toBe('immediate');
    expect((await data(path('notifications'))).total).toBe(before.total);
    expect((await data(path('incidents'))).total).toBe(0);
    expect((await request(path('automation/preview'), 'POST', {applicationId: 'payments', level: 'invalid'})).status).toBe(400);
    expect((await request(path('subscribers/123/preferences'), 'PUT', {expectedVersion: updated.preferences.version, timezone: 'not/a-zone'})).status).toBe(400);
  });

  it('groups authenticated producer events, preserves request idempotency and isolates incident actions', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ok: true, result: {id: 123456, is_bot: true, username: 'fixture_bot'}})));
    await bindings.TENANTS.getByName('registry').configureBot('default', '123456:test-token');
    const config = await data(path('automation'));
    await data(path('automation'), 'PUT', {expectedVersion: config.policy.version, grouping: {enabled: true, windowSeconds: 300}});
    const input = {event: 'database.firing', level: 'critical', text: 'Database unreachable', fingerprint: 'db:primary', incidentStatus: 'firing'};
    const send = (body: unknown, key: string) => request('/api/v1/tenants/default/notifications', 'POST', body, {Cookie: '', 'X-API-Key': applicationKey, 'Idempotency-Key': key});
    expect((await send(input, 'first')).status).toBe(202);
    expect((await send(input, 'first')).status).toBe(200);
    expect((await send({...input, text: 'Still unreachable'}, 'second')).status).toBe(202);
    const list = await data(path('incidents'));
    expect(list.total).toBe(1);
    const incident = list.items[0];
    expect(incident.occurrences).toBe(2);
    expect(incident.applicationId).toBe('payments');
    expect((await data(path('incidents', 'operations'))).total).toBe(0);
    expect((await request(path(`incidents/${incident.id}`, 'operations'))).status).toBe(404);
    expect((await request(path(`incidents/${incident.id}/actions`, 'operations'), 'POST', {action: 'resolve', expectedVersion: incident.version})).status).toBe(404);
    const acknowledged = await data(path(`incidents/${incident.id}/actions`), 'POST', {action: 'acknowledge', expectedVersion: incident.version});
    expect(acknowledged.incident.status).toBe('acknowledged');
    expect((await request(path(`incidents/${incident.id}/actions`), 'POST', {action: 'resolve', expectedVersion: incident.version})).status).toBe(409);
    const resolved = await data(path(`incidents/${incident.id}/actions`), 'POST', {action: 'resolve', expectedVersion: acknowledged.incident.version});
    expect(resolved.incident.status).toBe('resolved');
    const detail = await data(path(`incidents/${incident.id}`));
    expect(detail.timeline.some((entry: any) => entry.action === 'acknowledge')).toBe(true);
    expect(detail.timeline.some((entry: any) => entry.action === 'resolve')).toBe(true);
    expect((await request(path('incidents?status=bad'))).status).toBe(400);
    expect((await data(path('incidents/overview'))).resolved).toBe(1);
  });
});
