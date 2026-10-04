import {env} from 'cloudflare:workers';
import {evictDurableObject, runDurableObjectAlarm, runInDurableObject} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hubName, type Env, type NotificationInput, type TenantLimits} from '../src/types';
import type {NotificationHub} from '../src/hub';

const bindings = env as unknown as Env;
const source = {ip: '203.0.113.10', country: 'DE', source: 'api'};
const input: NotificationInput = {applicationId: 'primary-app', application: 'Primary', event: 'health.failed', level: 'error', timestamp: '2026-10-04T10:00:00.000Z', text: 'Service failed', fingerprint: 'health'};
type Hub = DurableObjectStub<NotificationHub>;
let now: number;
let updateId: number;
let telegramId = 7_000_000;
let receipt: number;
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  now = Date.now(); updateId = 0; receipt = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const id = Number(/bot(\d+):/.exec(String(request))?.[1] ?? 0);
    return new Response(JSON.stringify({ok: true, result: String(request).endsWith('/getMe')
      ? {id, is_bot: true, first_name: `Bot ${id}`, username: `bot_${id}`}
      : {message_id: ++receipt}}));
  });
});
afterEach(() => vi.restoreAllMocks());
async function setup(limits: Partial<TenantLimits> = {}) {
  const id = `multi-${crypto.randomUUID()}`;
  const registry = bindings.TENANTS.getByName('registry');
  await registry.createTenant({id, name: 'Multi bot tenant', limits});
  await registry.configureBot(id, `${++telegramId}:primary-token`);
  await registry.createBot(id, {id: 'secondary', name: 'Secondary bot', botToken: `${++telegramId}:secondary-token`});
  await registry.createApplication(id, {id: 'primary-app', name: 'Primary application'});
  await registry.createApplication(id, {id: 'secondary-app', name: 'Secondary application', botId: 'secondary'});
  const primary = bindings.HUB.getByName(hubName(id));
  const secondary = bindings.HUB.getByName(hubName(id, 'secondary'));
  for (const hub of [primary, secondary]) await hub.updateSettings({...await hub.getSettings(), paused: true, welcomeMessage: ''});
  network.mockClear();
  const toggle = async (botId: string, enabled: boolean) => {
    const activeRegistry = bindings.TENANTS.getByName('registry');
    const bot = (await activeRegistry.getBot(id, botId))!;
    await activeRegistry.updateBot(id, botId, {expectedVersion: bot.version, enabled});
  };
  return {id, registry, primary, secondary, toggle};
}
async function subscribe(hub: Hub, id: number, text = '/start', fixedId?: number) {
  await hub.handleUpdate({update_id: fixedId ?? ++updateId, message: {chat: {id, type: 'private'}, from: {id, first_name: `User ${id}`}, text}});
}
async function resume(hub: Hub) {await hub.updateSettings({...await hub.getSettings(), paused: false});}
async function tick(hub: Hub, ms = 1001) {now += ms; await runDurableObjectAlarm(hub);}
const secondaryInput = () => ({...input, applicationId: 'secondary-app', application: 'Secondary'});
const sends = () => network.mock.calls.filter((args: unknown[]) => /\/(send|edit)/.test(String(args[0])));
async function policy(hub: Hub, patch: Record<string, unknown>) {
  const {policy: current} = await hub.getAutomationPolicy();
  return hub.updateAutomationPolicy(null, {...patch, expectedVersion: current.version});
}

describe('isolated bot hubs and durable pause behavior', () => {
  it('preserves legacy identities and migrates queued work without allowing scope retargeting', async () => {
    expect(hubName('default')).toBe('primary'); expect(hubName('acme')).toBe('tenant:acme');
    const f = await setup(); await subscribe(f.primary, 1);
    const accepted = await f.primary.enqueue(input, source);
    await runInDurableObject(f.primary, (_, state) => state.storage.sql.exec('ALTER TABLE tenant_identity DROP COLUMN bot_id'));
    await evictDurableObject(f.primary);
    await f.primary.initializeTenant(f.id, 'Legacy', 'default');
    expect((await f.primary.getNotification(accepted.notification.id))?.notification.pending).toBe(1);
    await expect((async () => await f.primary.initializeTenant(f.id, 'Wrong', 'secondary'))()).rejects.toThrow('BOT_NOT_FOUND:');
    await expect((async () => await f.secondary.initializeTenant(f.id))()).rejects.toThrow('BOT_NOT_FOUND:');
  });

  it('keeps the same Telegram user, update IDs, preferences, apps, bans and notifications independent', async () => {
    const f = await setup();
    await subscribe(f.primary, 1, '/start', 55); await subscribe(f.secondary, 1, '/start', 55);
    const preferences = await f.primary.getSubscriberPreferences('1');
    await f.primary.updateSubscriberPreferences('1', {levels: ['critical'], expectedVersion: preferences.version});
    expect((await f.secondary.getSubscriberPreferences('1')).levels).toHaveLength(5);
    await expect((async () => await f.primary.enqueue(secondaryInput(), source))()).rejects.toThrow('APPLICATION_NOT_FOUND:');
    await expect((async () => await f.secondary.getAutomationPolicy('primary-app'))()).rejects.toThrow('APPLICATION_NOT_FOUND:');
    await f.primary.setSubscriberBan(['1'], true);
    const accepted = await f.secondary.enqueue(secondaryInput(), source);
    expect(accepted.notification.total).toBe(1); expect((await f.secondary.getSubscriber('1'))?.banned).toBe(false);
    expect(await f.primary.getNotification(accepted.notification.id)).toBeNull();
    await subscribe(f.secondary, 1, '/apps'); await resume(f.secondary); await tick(f.secondary); await tick(f.secondary);
    const menu = sends().find((args: any[]) => String(args[0]).endsWith('/sendMessage'));
    expect(String(menu?.[1]?.body)).toContain('Secondary application');
    expect(String(menu?.[1]?.body)).not.toContain('Primary application');
  });

  it('rejects disabled-bot ingestion, retains queued work through eviction, and resumes only that bot', async () => {
    const f = await setup(); await subscribe(f.primary, 1); await subscribe(f.secondary, 1);
    const queued = await f.primary.enqueue(input, source); await f.secondary.enqueue(secondaryInput(), source);
    await f.toggle('default', false);

    await resume(f.primary); await resume(f.secondary); await evictDurableObject(f.primary);
    await expect((async () => await f.primary.enqueue(input, source))()).rejects.toThrow('BOT_DISABLED:');
    await tick(f.primary); expect(sends()).toHaveLength(0);
    await tick(f.secondary); expect(sends()).toHaveLength(1);
    expect((await f.primary.getNotification(queued.notification.id))?.notification.pending).toBe(1);
    await f.toggle('default', true); await tick(f.primary);
    expect((await f.primary.getNotification(queued.notification.id))?.notification.sent).toBe(1);
    expect(sends()).toHaveLength(2);
  });

  it('stops subsequent network calls after a disable while one Telegram request is already in flight', async () => {
    const f = await setup(); await subscribe(f.primary, 1); await subscribe(f.primary, 2);
    const queued = await f.primary.enqueue(input, source); await resume(f.primary);
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => {started = resolve;});
    network.mockImplementationOnce(async () => {const response = new Response(JSON.stringify({ok: true, result: {message_id: 99}})); started(); return new Promise<Response>(resolve => {release = () => resolve(response);});});
    const alarm = runDurableObjectAlarm(f.primary); await entered; await f.toggle('default', false);
    now += 1001; release(); await alarm;
    expect(sends()).toHaveLength(1);
    const refreshedHub = bindings.HUB.getByName(hubName(f.id));
    expect((await refreshedHub.getNotification(queued.notification.id))?.notification).toMatchObject({sent: 1, pending: 1});
  });

  it('blocks disabled private commands and welcome enrollment while still honoring /stop', async () => {
    const f = await setup(); await subscribe(f.primary, 1);
    await f.primary.updateSettings({...await f.primary.getSettings(), welcomeMessage: 'Welcome'});
    await f.toggle('default', false);
    await subscribe(f.primary, 2); await subscribe(f.primary, 1, '/apps'); await subscribe(f.primary, 1, '/preferences');
    await subscribe(f.primary, 1, '/stop'); await resume(f.primary); await tick(f.primary);
    expect((await f.primary.listSubscribers(1)).total).toBe(1);
    expect((await f.primary.getSubscriber('1'))?.active).toBe(false); expect(sends()).toHaveLength(0);
    await f.toggle('default', true); await subscribe(f.primary, 2); await tick(f.primary);
    expect(sends()).toHaveLength(1);
  });

  it('keeps digest and escalation deadlines dormant until their bot is enabled again', async () => {
    const f = await setup(); await subscribe(f.primary, 1);
    await policy(f.primary, {grouping: {enabled: true, windowSeconds: 300}, escalation: {enabled: true, afterMinutes: 1, targetChatIds: ['1']}});
    await f.primary.enqueue({...input, level: 'critical'}, source); await resume(f.primary); await tick(f.primary);
    const incident = (await f.primary.listIncidents(1)).items[0];
    await f.toggle('default', false); await tick(f.primary, 60001);
    expect((await f.primary.getIncident(incident.id))?.incident.escalationCount).toBe(0); expect(sends()).toHaveLength(1);
    await f.toggle('default', true); await tick(f.primary);
    expect((await f.primary.getIncident(incident.id))?.incident.escalationCount).toBe(1); expect(sends()).toHaveLength(2);
    await subscribe(f.secondary, 2);
    const prefs = await f.secondary.getSubscriberPreferences('2');
    await f.secondary.updateSubscriberPreferences('2', {delivery: 'digest', digestMinutes: 5, expectedVersion: prefs.version});
    await f.secondary.enqueue(secondaryInput(), source); await f.secondary.enqueue({...secondaryInput(), event: 'second'}, source);
    await f.toggle('secondary', false); await resume(f.secondary); await tick(f.secondary, 300001); expect(sends()).toHaveLength(2);
    await evictDurableObject(f.secondary); await f.toggle('secondary', true); await tick(f.secondary);
    expect(sends()).toHaveLength(3); expect((await f.secondary.getUsage()).pendingDeliveries).toBe(0);
  });

  it('refuses incident callbacks from a different bot even when chat and Telegram message IDs coincide', async () => {
    const f = await setup(); await subscribe(f.primary, 1); await subscribe(f.secondary, 1);
    await policy(f.primary, {grouping: {enabled: true, windowSeconds: 300}, responders: ['1']});
    await f.primary.enqueue(input, source); await resume(f.primary); await tick(f.primary);
    const incident = (await f.primary.listIncidents(1)).items[0];
    const id = await runInDurableObject(f.primary, (_, state) => state.storage.sql.exec('SELECT telegram_message_id FROM deliveries LIMIT 1').one().telegram_message_id);
    await f.secondary.handleUpdate({update_id: ++updateId, callback_query: {id: 'forged', from: {id: 1}, message: {chat: {id: 1, type: 'private'}, message_id: id}, data: `inc:ack:${incident.id}`}});
    expect((await f.primary.getIncident(incident.id))?.incident.status).toBe('open');
    expect(await f.secondary.getIncident(incident.id)).toBeNull();
  });
});

describe('tenant-wide durable quotas across bots', () => {
  it('admits only one of simultaneous cross-bot notifications at the shared daily limit', async () => {
    const f = await setup({notificationsPerDay: 1});
    const attempts = await Promise.allSettled([Promise.resolve(f.primary.enqueue(input, source)), Promise.resolve(f.secondary.enqueue(secondaryInput(), source))]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await f.registry.getTenantUsage(f.id)).notificationsToday).toBe(1);
    const winner = attempts[0].status === 'fulfilled' ? f.primary : f.secondary;
    await evictDurableObject(winner);
    await expect((async () => await f.primary.enqueue(input, source))()).rejects.toThrow('DAILY_LIMIT:');
  });

  it('shares subscriber admission, counts bot memberships, and releases capacity after a stop', async () => {
    const f = await setup({maxSubscribers: 1});
    const attempts = await Promise.allSettled([subscribe(f.primary, 1), subscribe(f.secondary, 1)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(1);
    const primaryWon = attempts[0].status === 'fulfilled';
    await subscribe(primaryWon ? f.primary : f.secondary, 1, '/stop');
    await subscribe(primaryWon ? f.secondary : f.primary, 1);
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(1);
  });

  it('reserves pending fan-out atomically and makes capacity available after confirmed delivery', async () => {
    const f = await setup({maxPendingDeliveries: 1}); await subscribe(f.primary, 1); await subscribe(f.secondary, 2);
    const attempts = await Promise.allSettled([Promise.resolve(f.primary.enqueue(input, source)), Promise.resolve(f.secondary.enqueue(secondaryInput(), source))]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await f.registry.getTenantUsage(f.id)).pendingDeliveries).toBe(1);
    const primaryWon = attempts[0].status === 'fulfilled'; const winner = primaryWon ? f.primary : f.secondary;
    await resume(winner); await tick(winner);
    expect((await f.registry.getTenantUsage(f.id)).pendingDeliveries).toBe(0);
    await (primaryWon ? f.secondary.enqueue(secondaryInput(), source) : f.primary.enqueue(input, source));
    expect((await f.registry.getTenantUsage(f.id)).pendingDeliveries).toBe(1);
  });

  it('retains an interrupted reservation until its owning hub restarts and reconciles persisted usage', async () => {
    const f = await setup({maxPendingDeliveries: 1}); await subscribe(f.secondary, 2);
    const revision = await runInDurableObject(f.primary, (_, state) => {
      state.storage.sql.exec("INSERT INTO queue_state(key,value) VALUES('quota_revision',1) ON CONFLICT(key) DO UPDATE SET value=value+1");
      return Number(state.storage.sql.exec("SELECT value FROM queue_state WHERE key='quota_revision'").one().value);
    });
    const actual = await f.primary.getUsage();
    await f.registry.reserveQuota(f.id, 'default', revision, actual, {notifications: 0, subscribers: 0, pending: 1});
    await f.registry.reportQuotaUsage(f.id, 'default', revision, actual);
    await expect((async () => await f.secondary.enqueue(secondaryInput(), source))()).rejects.toThrow('QUEUE_LIMIT:');
    await evictDurableObject(f.primary); await tick(f.primary);
    await f.secondary.enqueue(secondaryInput(), source);
    expect((await f.registry.getTenantUsage(f.id)).pendingDeliveries).toBe(1);
  });
});
