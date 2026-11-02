import {env} from 'cloudflare:workers';
import {evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject, SELF} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type Env, hubName} from '../src/types';

const bindings = env as unknown as Env;
const registry = () => bindings.TENANTS.getByName('registry');
const rejected = (work: () => PromiseLike<unknown>) => (async () => await work())();
const origin = 'https://relay.test';
const adminKey = 'test-admin-key-which-is-not-a-production-secret';

/** Answer Telegram management requests locally; deletion never contacts a real bot. */
function telegram(input: RequestInfo | URL): Response {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const id = Number(/\/bot(\d+):/.exec(url)?.[1]);
  return new Response(JSON.stringify({
    ok: true,
    result: url.endsWith('/getMe') ? {id, is_bot: true, username: `fixture_${id}`} : true
  }));
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => telegram(input));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** Send an API operation with an explicit browser origin and optional admin session. */
function request(path: string, method = 'GET', body?: unknown, cookie?: string, requestOrigin = origin) {
  return SELF.fetch(`${origin}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: requestOrigin, ...(cookie ? {Cookie: cookie} : {})
    }, ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
}

/** Obtain the existing dashboard session without relying on any bot's lifecycle. */
async function login(): Promise<string> {
  const result = await request('/api/admin/login', 'POST', {apiKey: adminKey});
  expect(result.status).toBe(200);
  return result.headers.get('Set-Cookie')!.split(';')[0];
}

/** Advance already-persisted deletion work without waiting for wall-clock retry backoff. */
async function cleanup(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const pending = await runInDurableObject(registry(), (_, state) => {
      state.storage.sql.exec('UPDATE resource_cleanup_jobs SET not_before=0');
      return state.storage.sql.exec<{
        count: number
      }>('SELECT COUNT(*) AS count FROM resource_cleanup_jobs').one().count;
    });
    if (!pending) return;
    await runDurableObjectAlarm(registry());
  }
  throw new Error('Cleanup did not finish within bounded passes.');
}

describe('resource deletion registry', () => {
  it('requires the reviewed version and protects the system tenant', async () => {
    const stub = registry();
    const {application} = await stub.createApplication('default', {id: 'guarded-app', name: 'Guarded'});
    await expect(rejected(() => stub.deleteApplication('default', application.id, {} as never))).rejects.toThrow('INVALID_DELETION:');
    await expect(rejected(() => stub.deleteApplication('default', application.id, {expectedVersion: application.version + 1}))).rejects.toThrow('STALE_APPLICATION:');
    const tenant = (await stub.getTenant('default'))!;
    await expect(rejected(() => stub.deleteTenant('default', {expectedVersion: tenant.version}))).rejects.toThrow('DEFAULT_RESOURCE_PROTECTED:');
    expect(await stub.getApplication('default', application.id)).not.toBeNull();
  });
  
  it('revokes keys and permanently retires application IDs across registry eviction', async () => {
    const stub = registry();
    const {application, apiKey} = await stub.createApplication('default', {
      id: 'retired-app',
      name: 'Removed application'
    });
    const sibling = await stub.createApplication('default', {id: 'retained-app', name: 'Retained application'});
    expect(await stub.verifyApplicationKey('default', apiKey)).toMatchObject({id: application.id});
    expect(await stub.deleteApplication('default', application.id, {expectedVersion: application.version})).toMatchObject({deleted: true});
    await cleanup();
    expect(await stub.getApplication('default', application.id)).toBeNull();
    expect(await stub.verifyApplicationKey('default', apiKey)).toBeNull();
    expect(await stub.verifyApplicationKey('default', sibling.apiKey)).toMatchObject({id: sibling.application.id});
    expect(await stub.deleteApplication('default', application.id, {expectedVersion: application.version})).toEqual({
      deleted: true,
      cleanupPending: false
    });
    await evictDurableObject(stub);
    await expect(rejected(() => stub.createApplication('default', {
      id: application.id,
      name: 'Reused ID'
    }))).rejects.toThrow('RESOURCE_ID_RETIRED:');
    const tenant = (await stub.getTenant('default'))!;
    await expect(rejected(() => stub.deleteTenant('default', {expectedVersion: tenant.version}))).rejects.toThrow('DEFAULT_RESOURCE_PROTECTED:');
  });
  
  it('caches pending application fences across eviction and clears them after cleanup', async () => {
    const stub = registry(), hub = bindings.HUB.getByName(hubName('default'));
    const {application} = await stub.createApplication('default', {id: 'pending-app', name: 'Pending'});
    await runInDurableObject(hub, instance => {
      vi.spyOn(Object.getPrototypeOf(instance), 'removeApplication').mockResolvedValue(false);
    });
    expect(await stub.deleteApplication('default', application.id, {expectedVersion: application.version})).toEqual({
      deleted: true,
      cleanupPending: true
    });
    expect((await stub.getRuntime('default'))?.deletedApplicationIds).toEqual([application.id]);
    await runInDurableObject(stub, async (instance, state) => {
      const sql = vi.spyOn(state.storage.sql, 'exec');
      try {
        for (let index = 0; index < 5; index++) expect((await instance.getRuntime('default'))?.deletedApplicationIds).toEqual([application.id]);
        expect(sql).not.toHaveBeenCalled();
      } finally {
        sql.mockRestore();
      }
    });
    await evictDurableObject(stub);
    expect((await stub.getRuntime('default'))?.deletedApplicationIds).toEqual([application.id]);
    await runInDurableObject(hub, instance => {
      vi.mocked(Object.getPrototypeOf(instance).removeApplication).mockRestore();
    });
    await cleanup();
    expect((await stub.getRuntime('default'))?.deletedApplicationIds).toEqual([]);
    await evictDurableObject(stub);
    expect((await stub.getRuntime('default'))?.deletedApplicationIds).toEqual([]);
  });
  
  it('continues cleanup while an unrelated tenant wake fails and retains its retry alarm', async () => {
    const stub = registry(), hub = bindings.HUB.getByName(hubName('default'));
    const {application} = await stub.createApplication('default', {id: 'wake-pending-app', name: 'Pending'});
    await runInDurableObject(hub, instance => {
      vi.spyOn(Object.getPrototypeOf(instance), 'removeApplication').mockResolvedValue(false);
    });
    expect(await stub.deleteApplication('default', application.id, {expectedVersion: application.version})).toEqual({
      deleted: true,
      cleanupPending: true
    });
    await runInDurableObject(hub, instance => {
      vi.mocked(Object.getPrototypeOf(instance).removeApplication).mockRestore();
    });
    await stub.createTenant({id: 'wake-space', name: 'Wake retry'});
    await stub.updateTenant('wake-space', {name: 'Wake queued'});
    const otherHub = bindings.HUB.getByName(hubName('wake-space'));
    await runInDurableObject(otherHub, instance => {
      vi.spyOn(Object.getPrototypeOf(instance), 'wake').mockRejectedValue(new Error('Hub temporarily unavailable'));
    });
    await runDurableObjectAlarm(stub);
    expect((await stub.getRuntime('default'))?.deletedApplicationIds).toEqual([]);
    const result = await runInDurableObject(stub, async (_, state) => ({
      pending: state.storage.sql.exec('SELECT 1 FROM resource_cleanup_jobs').toArray().length,
      wake: state.storage.sql.exec('SELECT 1 FROM tenant_wake_jobs').toArray().length,
      alarm: await state.storage.getAlarm(),
    }));
    expect(result).toMatchObject({pending: 0, wake: 1});
    expect(result.alarm).toBeGreaterThan(Date.now());
  });
  
  it('deletes the default bot without resurrecting it or blocking login and new bot creation', async () => {
    const stub = registry();
    await stub.configureBot('default', '730001:default-fixture');
    const hub = bindings.HUB.getByName(hubName('default'));
    await hub.updateSettings({...await hub.getSettings(), ipMode: 'allow', ipRules: ['203.0.113.0/24']});
    const bot = (await stub.getBot('default', 'default'))!;
    const app = await stub.createApplication('default', {id: 'default-app', name: 'Default app'});
    expect(await stub.deleteBot('default', 'default', {expectedVersion: bot.version})).toMatchObject({deleted: true});
    await cleanup();
    expect(await stub.getBot('default', 'default')).toBeNull();
    expect(await stub.getRuntime('default')).toBeNull();
    expect(await stub.verifyApplicationKey('default', app.apiKey)).toBeNull();
    expect((await stub.listBots('default')).items).toEqual([]);
    expect(await stub.getInheritedAccess('default')).toMatchObject({ipMode: 'allow', ipRules: ['203.0.113.0/24']});
    expect(await stub.getTenant('default')).toMatchObject({botConfigured: false, hasInheritedAccess: true});
    await evictDurableObject(stub);
    expect(await stub.getBot('default', 'default')).toBeNull();
    expect(await login()).toBeTruthy();
    const created = await stub.createBot('default', {
      id: 'replacement',
      name: 'Replacement',
      botToken: '730001:default-fixture'
    });
    expect(created.bot.configured).toBe(true);
    expect(await stub.getTenantUsage('default')).toMatchObject({activeSubscribers: 0});
    const tenant = (await stub.getTenant('default'))!;
    await expect(rejected(() => stub.updateTenant('default', {clearInheritedAccess: true}))).rejects.toThrow('INVALID_TENANT:');
    expect(await stub.updateTenant('default', {
      clearInheritedAccess: true,
      expectedVersion: tenant.version
    })).toMatchObject({hasInheritedAccess: false});
    expect(await stub.getInheritedAccess('default')).toBeNull();
  });
  
  it('cascades a tenant across all bot hubs, credentials and quota rows while leaving another tenant intact', async () => {
    const stub = registry();
    await stub.createTenant({id: 'removed-space', name: 'Deleted space'});
    await stub.configureBot('removed-space', '730002:default-fixture');
    await stub.createBot('removed-space', {id: 'alerts', name: 'Alerts', botToken: '730003:alerts-fixture'});
    const removed = await stub.createApplication('removed-space', {
      id: 'removed-app',
      name: 'Removed',
      botId: 'alerts'
    });
    const retained = await stub.createApplication('default', {id: 'keep-app', name: 'Keep'});
    const control = bindings.HUB.getByName('tenant-control:removed-space');
    await control.rateLimit('fixture', 3, 60);
    const tenant = (await stub.getTenant('removed-space'))!;
    expect(await stub.deleteTenant(tenant.id, {expectedVersion: tenant.version})).toMatchObject({deleted: true});
    expect(await stub.getTenant(tenant.id)).toBeNull();
    expect(await stub.verifyApplicationKey(tenant.id, removed.apiKey)).toBeNull();
    expect(await stub.getRuntime(tenant.id, undefined, 'alerts')).toBeNull();
    await cleanup();
    const counts = await runInDurableObject(stub, (_, state) => ['tenants', 'tenant_bots', 'tenant_applications', 'tenant_bot_usage'].map(table => state.storage.sql.exec<{
      count: number
    }>(`SELECT COUNT(*) AS count
        FROM ${table}
        WHERE ${table === 'tenants' ? 'id' : 'tenant_id'}=?`, tenant.id).one().count));
    expect(counts).toEqual([0, 0, 0, 0]);
    expect(await runInDurableObject(control, (_, state) => state.storage.sql.exec('SELECT 1 FROM rate_limits').toArray().length)).toBe(0);
    expect(await stub.verifyApplicationKey('default', retained.apiKey)).toMatchObject({id: retained.application.id});
    await evictDurableObject(stub);
    await expect(rejected(() => stub.createTenant({
      id: tenant.id,
      name: 'Cannot reuse'
    }))).rejects.toThrow('RESOURCE_ID_RETIRED:');
    expect(await stub.deleteTenant(tenant.id, {expectedVersion: tenant.version})).toEqual({
      deleted: true,
      cleanupPending: false
    });
  });
  
  it('reserves Telegram identity until durable webhook cleanup completes after an upstream failure', async () => {
    const stub = registry();
    const {bot} = await stub.createBot('default', {
      id: 'pending-bot',
      name: 'Pending bot',
      botToken: '730004:pending-fixture'
    });
    vi.mocked(globalThis.fetch).mockImplementation(async input => String(input).endsWith('/deleteWebhook') ? new Response(JSON.stringify({ok: false}), {status: 503}) : telegram(input));
    expect(await stub.deleteBot('default', bot.id, {expectedVersion: bot.version})).toEqual({
      deleted: true,
      cleanupPending: true
    });
    expect(await stub.getBot('default', bot.id)).toBeNull();
    await evictDurableObject(stub);
    await expect(rejected(() => stub.createBot('default', {
      id: 'new-owner',
      name: 'New owner',
      botToken: '730004:pending-fixture'
    }))).rejects.toThrow('BOT_ALREADY_ASSIGNED:');
    expect(await stub.getBot('default', bot.id)).toBeNull();
    vi.mocked(globalThis.fetch).mockImplementation(async input => telegram(input));
    await cleanup();
    expect(await stub.createBot('default', {
      id: 'new-owner',
      name: 'New owner',
      botToken: '730004:pending-fixture'
    })).toMatchObject({bot: {configured: true}});
    await expect(rejected(() => stub.createBot('default', {
      id: bot.id,
      name: 'Reused',
      botToken: '730005:other-fixture'
    }))).rejects.toThrow('RESOURCE_ID_RETIRED:');
    await expect(rejected(() => stub.reportQuotaUsage('default', bot.id, 2, {
      day: '2026-11-02',
      notificationsToday: 0,
      activeSubscribers: 0,
      pendingDeliveries: 0
    }) as unknown as PromiseLike<unknown>)).rejects.toThrow('BOT_NOT_FOUND:');
  });
  
  it('rechecks a bot after delayed token validation so deletion cannot recreate its credentials', async () => {
    const stub = registry();
    const {bot} = await stub.createBot('default', {
      id: 'racing-bot',
      name: 'Racing',
      botToken: '730006:original-fixture'
    });
    // Keep both sides of the controlled race in the object's I/O context.
    await runInDurableObject(stub, async instance => {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => entered = resolve),
        gate = new Promise<void>(resolve => release = resolve);
      vi.mocked(globalThis.fetch).mockImplementation(async input => {
        if (String(input).endsWith('/getMe')) {
          entered();
          await gate;
        }
        return telegram(input);
      });
      const pending = instance.updateBot('default', bot.id, {
        botToken: '730006:replacement-fixture',
        expectedVersion: bot.version
      });
      const outcome = pending.then(() => 'unexpected success', error => String(error));
      await started;
      await instance.deleteBot('default', bot.id, {expectedVersion: bot.version});
      release();
      expect(await outcome).toContain('BOT_NOT_FOUND:');
    });
    expect(await stub.getBot('default', bot.id)).toBeNull();
  });
});

describe('resource deletion administration API', () => {
  it('requires an admin browser session, exact origin and version, and exposes fresh application detail', async () => {
    const stub = registry(), cookie = await login();
    const {application} = await stub.createApplication('default', {id: 'api-deletion', name: 'API deletion'});
    const path = `/api/admin/tenants/default/applications/${application.id}?botId=default`;
    const detail = await request(path, 'GET', undefined, cookie);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({application: {id: application.id, version: application.version}});
    expect((await request(path, 'DELETE', {expectedVersion: application.version})).status).toBe(401);
    expect((await request(path, 'DELETE', {expectedVersion: application.version}, cookie, 'https://wrong.test')).status).toBe(403);
    expect((await request(path, 'DELETE', {}, cookie)).status).toBe(400);
    expect((await request(path, 'DELETE', {expectedVersion: 999}, cookie)).status).toBe(409);
    expect((await request(path, 'DELETE', {expectedVersion: application.version}, cookie)).status).toBe(200);
    expect((await request(path, 'GET', undefined, cookie)).status).toBe(404);
    expect((await request(path, 'DELETE', {expectedVersion: application.version}, cookie)).status).toBe(200);
  });
  
  it('names the existing tenant and bot on token conflict without including any token', async () => {
    const stub = registry(), cookie = await login();
    await stub.createTenant({id: 'owner-space', name: 'فضای عملیات'});
    await stub.createBot('owner-space', {id: 'owner-bot', name: 'بات هشدار', botToken: '730007:private-owner-token'});
    const response = await request('/api/admin/tenants/default/bots', 'POST', {
      id: 'duplicate-bot',
      name: 'Duplicate',
      botToken: '730007:private-owner-token'
    }, cookie);
    expect(response.status).toBe(409);
    const raw = await response.text();
    expect(raw).not.toContain('private-owner-token');
    expect(JSON.parse(raw)).toMatchObject({
      error: {
        code: 'BOT_ALREADY_ASSIGNED',
        owner: {tenantId: 'owner-space', tenantName: 'فضای عملیات', botId: 'owner-bot', botName: 'بات هشدار'}
      }
    });
    expect(JSON.parse(raw).error.message).toContain('فضای عملیات');
    expect((await request('/api/admin/tenants/default/bots', 'POST', {
      id: 'unauthorized',
      name: 'Duplicate',
      botToken: '730007:private-owner-token'
    })).status).toBe(401);
  });
});
