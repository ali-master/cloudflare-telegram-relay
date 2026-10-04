import {env} from 'cloudflare:workers';
import {reset, SELF} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hubName, type Env, type TelegramBot} from '../src/types';
import {TELEGRAM_BOT_COMMANDS} from '../src/bot-commands';

const origin = 'https://relay.test';
const bindings = env as unknown as Env;
const registry = () => bindings.TENANTS.getByName('registry');
const botHub = (id = 'default') => bindings.HUB.getByName(hubName('default', id));
const event = {event: 'deployment.completed', text: 'A local fixture notification.', level: 'success'};
let cookie: string;
let primaryKey: string;
let operationsKey: string;
let operationsBot: TelegramBot;

async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${origin}${path}`, {
    method, headers: {'Content-Type': 'application/json', ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
}
const admin = (path: string, method = 'GET', body?: unknown) => request(path, method, body, {Cookie: cookie, Origin: origin});
const send = (key: string, path = '/api/v1/tenants/default/notifications', body: unknown = event) => request(path, 'POST', body, {'X-API-Key': key});

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const id = Number(/\/bot(\d+):/.exec(url)?.[1]);
    return new Response(JSON.stringify({ok: true, result: url.endsWith('/getMe')
      ? {id, is_bot: true, username: `fixture_${id}_bot`}
      : /\/(setWebhook|setMyCommands|setChatMenuButton)$/.test(url) ? true : url.endsWith('/getWebhookInfo') ? {url: ''} : {message_id: 42}}));
  });
  const session = await request('/api/admin/login', 'POST', {apiKey: 'test-admin-key-which-is-not-a-production-secret'}, {Origin: origin});
  cookie = session.headers.get('Set-Cookie')!.split(';')[0];
  await registry().configureBot('default', '123456:fixture-default-token');
  await botHub().initializeTenant('default', 'Telegram Relay');
  await botHub().updateSettings({...await botHub().getSettings(), paused: true, welcomeMessage: ''});
  operationsBot = (await registry().createBot('default', {id: 'operations', name: 'Operations', botToken: '234567:fixture-operations-token'})).bot;
  await botHub('operations').initializeTenant('default', 'Telegram Relay', 'operations');
  await botHub('operations').updateSettings({...await botHub('operations').getSettings(), paused: true, welcomeMessage: ''});
  primaryKey = (await registry().createApplication('default', {id: 'website', name: 'Website'})).apiKey;
  operationsKey = (await registry().createApplication('default', {id: 'deployments', name: 'Deployments', botId: 'operations'})).apiKey;
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe('multi-bot management and authenticated routing', () => {
  it('registers commands only for the selected bot, including a configured disabled bot', async () => {
    await registry().updateBot('default', 'operations', {enabled: false});
    const telegram = vi.mocked(globalThis.fetch);
    telegram.mockClear();
    const response = await admin('/api/admin/tenants/default/bots/operations/commands', 'POST');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ok: true, commands: TELEGRAM_BOT_COMMANDS});
    const calls = telegram.mock.calls.filter(([input]) => String(input).startsWith('https://api.telegram.org/'));
    expect(calls).toHaveLength(3);
    expect(calls.every(([input]) => String(input).includes('/bot234567:'))).toBe(true);
    expect(await registry().getBot('default', 'operations')).toMatchObject({enabled: false});
    telegram.mockClear();
    expect((await admin('/api/admin/bots/default/commands', 'POST')).status).toBe(200);
    expect(telegram.mock.calls.every(([input]) => String(input).includes('/bot123456:'))).toBe(true);
  });

  it('protects command registration with admin session, exact origin and tenant ownership', async () => {
    const path = '/api/admin/tenants/default/bots/operations/commands';
    const telegram = vi.mocked(globalThis.fetch);
    telegram.mockClear();
    expect((await request(path, 'POST')).status).toBe(401);
    expect((await request(path, 'POST', undefined, {'X-API-Key': operationsKey, Origin: origin})).status).toBe(401);
    expect((await request(path, 'POST', undefined, {Cookie: cookie, Origin: 'https://other.test'})).status).toBe(403);
    expect((await request(path, 'POST', undefined, {Cookie: cookie})).status).toBe(403);
    await registry().createTenant({id: 'other', name: 'Other tenant'});
    expect((await admin('/api/admin/tenants/other/bots/operations/commands', 'POST')).status).toBe(404);
    const unconfigured = await admin('/api/admin/tenants/other/bots/default/commands', 'POST');
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({error: {code: 'BOT_NOT_CONFIGURED'}});
    expect(telegram).not.toHaveBeenCalled();
  });

  it('reports Telegram command registration failures without leaking credentials and permits retry', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('https://api.telegram.org/bot234567:fixture-operations-token/setMyCommands'));
    const path = '/api/admin/tenants/default/bots/operations/commands';
    const failed = await admin(path, 'POST');
    expect(failed.status).toBe(502);
    const raw = await failed.text();
    expect(raw).not.toContain('fixture-operations-token');
    expect(raw).not.toContain('api.telegram.org');
    expect(JSON.parse(raw)).toMatchObject({error: {code: 'TELEGRAM_COMMANDS_SYNC_FAILED'}});
    expect((await admin(path, 'POST')).status).toBe(200);
  });

  it('rate limits command registration before making more Telegram calls', async () => {
    const path = '/api/admin/tenants/default/bots/operations/commands';
    for (let attempt = 0; attempt < 5; attempt++) expect((await admin(path, 'POST')).status).toBe(200);
    vi.mocked(globalThis.fetch).mockClear();
    const limited = await admin(path, 'POST');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({error: {code: 'RATE_LIMITED'}});
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('lists only public bot metadata and binds applications to the selected bot', async () => {
    const response = await admin('/api/admin/tenants/default/bots');
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain('fixture-default-token');
    expect(raw).not.toContain('fixture-operations-token');
    expect(raw).not.toContain('webhookSecret');
    expect(JSON.parse(raw).items.map((bot: TelegramBot) => bot.id).sort()).toEqual(['default', 'operations']);
    const apps = await (await admin('/api/admin/tenants/default/applications?botId=operations')).json() as any;
    expect(apps.applications).toHaveLength(1);
    expect(apps.applications[0]).toMatchObject({id: 'deployments', botId: 'operations'});
    const created = await admin('/api/admin/tenants/default/applications?botId=operations', 'POST', {id: 'monitoring', name: 'Monitoring'});
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({application: {botId: 'operations'}});
    expect((await admin('/api/admin/tenants/default/applications/deployments?botId=default', 'PATCH', {enabled: false})).status).toBe(404);
    expect((await admin('/api/admin/tenants/default/applications?botId=default', 'POST', {id: 'mismatch', name: 'Mismatch', botId: 'operations'})).status).toBe(400);
    const moved = await admin('/api/admin/tenants/default/applications/deployments?botId=operations', 'PATCH', {botId: 'default'});
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({error: {code: 'APPLICATION_BOT_IMMUTABLE'}});
  });

  it('rejects every notification adapter clearly when the application bot is disabled, while reports remain readable', async () => {
    const initial = await send(operationsKey);
    expect(initial.status).toBe(202);
    const notificationId = (await initial.json() as any).notification.id;
    const disabled = await admin('/api/admin/tenants/default/bots/operations', 'PATCH', {enabled: false, expectedVersion: operationsBot.version});
    expect(disabled.status).toBe(200);
    const bot = (await disabled.json() as any).bot;
    for (const path of ['/notifications', '/integrations/grafana', '/integrations/alertmanager']) {
      const response = await send(operationsKey, `/api/v1/tenants/default${path}`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({error: {code: 'BOT_DISABLED', message: 'بات این اپلیکیشن غیرفعال است؛ برای ارسال اعلان، بات را در داشبورد فعال کنید.'}});
    }
    const dashboardSend = await admin('/api/admin/tenants/default/notifications?botId=operations', 'POST', {...event, applicationId: 'deployments'});
    expect(dashboardSend.status).toBe(409);
    expect((await request(`/api/v1/tenants/default/notifications/${notificationId}`, 'GET', undefined, {'X-API-Key': operationsKey})).status).toBe(200);
    expect((await send(primaryKey)).status).toBe(202);
    const enabled = await admin('/api/admin/tenants/default/bots/operations', 'PATCH', {enabled: true, expectedVersion: bot.version});
    expect(enabled.status).toBe(200);
    expect((await send(operationsKey)).status).toBe(202);
  });

  it('routes by the authenticated application and rejects cross-bot notification and subscriber access', async () => {
    const response = await send(operationsKey, '/api/v1/tenants/default/notifications?botId=default');
    expect(response.status).toBe(202);
    const id = (await response.json() as any).notification.id;
    expect(await botHub().getNotification(id)).toBeNull();
    expect(await botHub('operations').getNotification(id)).not.toBeNull();
    expect((await request(`/api/v1/tenants/default/notifications/${id}`, 'GET', undefined, {'X-API-Key': primaryKey})).status).toBe(404);
    expect((await admin(`/api/admin/tenants/default/notifications/${id}?botId=default`)).status).toBe(404);
    expect((await admin(`/api/admin/tenants/default/notifications/${id}?botId=operations`)).status).toBe(200);
    const runtime = (await registry().getRuntime('default', undefined, 'operations'))!;
    const webhook = '/telegram/default/bots/operations/webhook';
    const update = {update_id: 501, message: {chat: {id: 99801, type: 'private', first_name: 'Operations only'}, from: {id: 99801}, text: '/start'}};
    expect((await request(webhook, 'POST', update, {'X-Telegram-Bot-Api-Secret-Token': runtime.webhookSecret})).status).toBe(200);
    expect((await admin('/api/admin/tenants/default/subscribers?botId=operations').then(res => res.json()) as any).total).toBe(1);
    expect((await admin('/api/admin/tenants/default/subscribers?botId=default').then(res => res.json()) as any).total).toBe(0);
    expect((await admin('/api/admin/tenants/default/subscribers/99801?botId=default')).status).toBe(404);
  });

  it('authenticates each webhook secret and prevents enrollment while disabled but preserves opt-outs', async () => {
    const primary = (await registry().getRuntime('default'))!;
    const operations = (await registry().getRuntime('default', undefined, 'operations'))!;
    const update = {update_id: 900, message: {chat: {id: 99802, type: 'private', first_name: 'Fixture'}, text: '/start'}};
    const path = '/telegram/default/bots/operations/webhook';
    expect((await request(path, 'POST', update, {'X-Telegram-Bot-Api-Secret-Token': primary.webhookSecret})).status).toBe(401);
    await registry().updateBot('default', 'operations', {enabled: false, expectedVersion: operationsBot.version});
    expect((await request(path, 'POST', update, {'X-Telegram-Bot-Api-Secret-Token': operations.webhookSecret})).status).toBe(200);
    expect(await botHub('operations').getSubscriber('99802')).toBeNull();
    expect((await request('/telegram/default/webhook', 'POST', update, {'X-Telegram-Bot-Api-Secret-Token': primary.webhookSecret})).status).toBe(200);
    expect(await botHub().getSubscriber('99802')).not.toBeNull();
    const subscriberUpdate = {update_id: 901, message: {chat: {id: 99803, type: 'private', first_name: 'Opt out'}, text: '/start'}};
    await registry().updateBot('default', 'operations', {enabled: true});
    const headers = {'X-Telegram-Bot-Api-Secret-Token': operations.webhookSecret};
    expect((await request(path, 'POST', subscriberUpdate, headers)).status).toBe(200);
    await registry().updateBot('default', 'operations', {enabled: false});
    expect((await request(path, 'POST', {...subscriberUpdate, update_id: 902, message: {...subscriberUpdate.message, text: '/stop'}}, headers)).status).toBe(200);
    expect(await botHub('operations').getSubscriber('99803')).toMatchObject({active: false});
    await registry().updateBot('default', 'operations', {enabled: true});
    const afterResume = await send(operationsKey);
    expect(afterResume.status).toBe(202);
    expect(await afterResume.json()).toMatchObject({notification: {total: 0}});
  });

  it('protects bot management with session, origin, tenant ownership, and optimistic versions', async () => {
    for (const path of ['/api/admin/tenants/default/bots', '/api/admin/tenants/default/bots/operations/status']) {
      expect((await request(path)).status).toBe(401);
      expect((await request(path, 'GET', undefined, {'X-API-Key': operationsKey})).status).toBe(401);
    }
    const stale = await admin('/api/admin/tenants/default/bots/operations', 'PATCH', {enabled: false, expectedVersion: 999});
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({error: {code: 'STALE_BOT'}});
    const badOrigin = await request('/api/admin/tenants/default/bots/operations', 'PATCH', {enabled: false}, {Cookie: cookie, Origin: 'https://other.test'});
    expect(badOrigin.status).toBe(403);
    await registry().createTenant({id: 'other', name: 'Other tenant'});
    expect((await admin('/api/admin/tenants/other/bots/operations')).status).toBe(404);
    expect((await admin('/api/admin/tenants/other/bots/operations', 'PATCH', {enabled: false})).status).toBe(404);
    expect((await admin('/api/admin/tenants/default/overview?botId=missing')).status).toBe(404);
    const localWebhook = await admin('/api/admin/tenants/default/bots/operations/webhook', 'POST', {url: 'http://localhost/telegram/default/bots/operations/webhook'});
    expect(localWebhook.status).toBe(400);
    expect(await localWebhook.json()).toMatchObject({error: {code: 'HTTPS_REQUIRED'}});
  });

  it('shares the tenant request cap across bot-scoped application keys and retains tenant network restrictions', async () => {
    const tenant = (await registry().getTenant('default'))!;
    await registry().updateTenant('default', {limits: {...tenant.limits, requestsPerMinute: 2}, expectedVersion: tenant.version});
    expect((await send(primaryKey)).status).toBe(202);
    expect((await send(operationsKey)).status).toBe(202);
    const limited = await send(operationsKey);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({error: {code: 'RATE_LIMITED'}});
    await botHub().updateSettings({...await botHub().getSettings(), ipMode: 'allow', ipRules: ['203.0.113.254']});
    const blocked = await send(operationsKey);
    expect(blocked.status).toBe(403);
  });
});
