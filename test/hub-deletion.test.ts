import {env} from 'cloudflare:workers';
import {evictDurableObject, runDurableObjectAlarm, runInDurableObject} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type Env, hubName, type NotificationInput} from '../src/types';

const bindings = env as unknown as Env;
const source = {ip: '203.0.113.1', country: 'DE', source: 'api'};
let identity = 81_000_000;
let now: number;
let network: ReturnType<typeof vi.spyOn>;

/** Keep Telegram responses deterministic and ensure no test reaches a real bot. */
beforeEach(() => {
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const id = Number(/bot(\d+):/.exec(String(request))?.[1]);
    return new Response(JSON.stringify({
      ok: true, result: String(request).endsWith('/getMe')
        ? {id, is_bot: true, first_name: 'Deletion fixture', username: `deletion_${id}`}
        : /\/(setMyCommands|setChatMenuButton|deleteWebhook)$/.test(String(request)) ? true : {message_id: 55}
    }));
  });
});
afterEach(() => vi.restoreAllMocks());

/** Create two applications sharing a subscribed user so cleanup isolation is observable. */
async function fixture() {
  const registry = bindings.TENANTS.getByName('registry');
  const id = `delete-${crypto.randomUUID()}`;
  await registry.createTenant({id, name: 'Deletion fixture'});
  await registry.configureBot(id, `${++identity}:deletion-fixture-token`);
  const {application: first} = await registry.createApplication(id, {id: 'first-app', name: 'First application'});
  await registry.createApplication(id, {id: 'other-app', name: 'Other application'});
  const hub = bindings.HUB.getByName(hubName(id));
  await hub.updateSettings({...await hub.getSettings(), paused: true, welcomeMessage: ''});
  await hub.handleUpdate({
    update_id: 1,
    message: {chat: {id: 1, type: 'private'}, from: {id: 1, first_name: 'Subscriber'}, text: '/start'}
  });
  const input: NotificationInput = {
    applicationId: first.id,
    application: first.name,
    event: 'deployment.failed',
    level: 'error',
    text: 'A persisted notification',
    timestamp: new Date(now).toISOString()
  };
  network.mockClear();
  return {registry, id, hub, first, input};
}

/** Inspect the durable rows rather than inferring erasure from a hidden UI record. */
async function stored(hub: Awaited<ReturnType<typeof fixture>>['hub']) {
  return runInDurableObject(hub, async (_, state) => ({
    deliveries: state.storage.sql.exec('SELECT COUNT(*) AS count FROM deliveries').one().count,
    notifications: state.storage.sql.exec('SELECT COUNT(*) AS count FROM notifications').one().count,
    subscribers: state.storage.sql.exec('SELECT COUNT(*) AS count FROM subscribers').one().count,
    settings: state.storage.sql.exec('SELECT COUNT(*) AS count FROM settings').one().count,
    alarm: await state.storage.getAlarm(),
  }));
}

/** Add distinct recipients to exercise cleanup pagination with real foreign keys. */
async function addFanout(hub: Awaited<ReturnType<typeof fixture>>['hub'], notificationId: string) {
  await runInDurableObject(hub, (_, state) => {
    state.storage.transactionSync(() => {
      state.storage.sql.exec(`WITH RECURSIVE seq(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM seq WHERE n < 601)
                              INSERT
                              INTO subscribers(chat_id,first_name,joined_at,updated_at)
      SELECT CAST(n AS TEXT), 'Recipient', ?, ?
      FROM seq`, now, now);
      state.storage.sql.exec(`INSERT INTO deliveries(notification_id, chat_id, rendered, updated_at)
                              SELECT ?, chat_id, 'Pending fan-out', ?
                              FROM subscribers
                              WHERE chat_id!='1'`, notificationId, now);
    });
  });
}

describe('permanent hub and application cleanup', () => {
  it('fences a deleted bot across eviction and prevents new work or scheduled sends', async () => {
    const f = await fixture();
    await f.hub.enqueue(f.input, source, 'removed-bot-notification');
    expect(await f.hub.decommission()).toBe(true);
    expect(await stored(f.hub)).toEqual({deliveries: 0, notifications: 0, subscribers: 0, settings: 0, alarm: null});
    await evictDurableObject(f.hub);
    await expect((async () => await f.hub.enqueue(f.input, source))()).rejects.toThrow('RESOURCE_DELETED');
    await expect((async () => await f.hub.handleUpdate({
      update_id: 2,
      message: {chat: {id: 2, type: 'private'}, from: {id: 2}, text: '/start'}
    }))()).rejects.toThrow('RESOURCE_DELETED');
    await f.hub.wake();
    await expect((async () => await f.hub.initializeTenant(f.id))()).rejects.toThrow('RESOURCE_DELETED');
    await expect((async () => await f.hub.getSettings())()).rejects.toThrow('RESOURCE_DELETED');
    expect(await f.hub.decommission()).toBe(true);
    expect(await stored(f.hub)).toEqual({deliveries: 0, notifications: 0, subscribers: 0, settings: 0, alarm: null});
    expect(network).not.toHaveBeenCalled();
  });
  
  it('cleans fan-out larger than one page without deleting still-referenced subscribers', async () => {
    const f = await fixture();
    const {notification} = await f.hub.enqueue(f.input, source);
    await addFanout(f.hub, notification.id);
    expect(await f.hub.decommission()).toBe(false);
    const partial = await stored(f.hub);
    expect(partial.deliveries).toBe(101);
    expect(partial.subscribers).toBe(101);
    expect(partial.alarm).toBeNull();
    await evictDurableObject(f.hub);
    expect(await f.hub.decommission()).toBe(true);
    expect((await stored(f.hub)).deliveries).toBe(0);
    expect((await stored(f.hub)).subscribers).toBe(0);
  });
  
  it('removes only one application and never revives it from an older policy snapshot', async () => {
    const f = await fixture();
    const {policy} = await f.hub.getAutomationPolicy('first-app');
    await f.hub.updateAutomationPolicy('first-app', {expectedVersion: policy.version, grouping: {enabled: true}});
    const removed = await f.hub.enqueue({...f.input, fingerprint: 'removed-incident'}, source, 'removed-idempotency');
    const kept = await f.hub.enqueue({
      ...f.input,
      applicationId: 'other-app',
      application: 'Other application'
    }, source);
    const subscriber = (await f.hub.getSubscriber('1'))!;
    await f.hub.updateSubscriber('1', {
      expectedVersion: subscriber.version,
      accessMode: 'selected',
      allowedApplicationIds: ['first-app', 'other-app']
    });
    await runInDurableObject(f.hub, (_, state) => state.storage.sql.exec("INSERT INTO deliveries(chat_id,rendered,system_payload,updated_at) VALUES('1','Other system work',?,?)", JSON.stringify({
      method: 'sendRichMessage',
      rich_message: {blocks: []},
      unrelated: true
    }), now));
    expect(await f.hub.removeApplication('first-app')).toBe(true);
    expect(await f.hub.getNotification(removed.notification.id)).toBeNull();
    expect((await f.hub.getNotification(kept.notification.id))?.notification.pending).toBe(1);
    expect((await f.hub.getSubscriber('1'))?.allowedApplicationIds).toEqual(['other-app']);
    expect((await f.hub.listIncidents(1)).total).toBe(0);
    expect(await runInDurableObject(f.hub, (_, state) => state.storage.sql.exec("SELECT status FROM deliveries WHERE rendered='Other system work'").one().status)).toBe('pending');
    await f.hub.refreshApplicationAccess([{...f.first, version: f.first.version + 50}]);
    await evictDurableObject(f.hub);
    await f.hub.refreshApplicationAccess([f.first]);
    await expect((async () => await f.hub.enqueue(f.input, source))()).rejects.toThrow('APPLICATION_NOT_FOUND');
    expect((await f.hub.getNotification(kept.notification.id))?.notification.pending).toBe(1);
  });
  
  it('purges large application fan-out incrementally while another application remains available', async () => {
    const f = await fixture();
    const removed = await f.hub.enqueue(f.input, source);
    const kept = await f.hub.enqueue({...f.input, applicationId: 'other-app'}, source);
    await addFanout(f.hub, removed.notification.id);
    expect(await f.hub.removeApplication('first-app')).toBe(false);
    expect(await f.hub.removeApplication('first-app')).toBe(true);
    expect(await f.hub.getNotification(removed.notification.id)).toBeNull();
    expect((await f.hub.getNotification(kept.notification.id))?.notification.pending).toBe(1);
    expect((await f.hub.getUsage()).notificationsToday).toBe(2);
  });
  
  it('does not recreate data or alarms when a Telegram429 arrives after bot deletion', async () => {
    const f = await fixture();
    await f.hub.enqueue(f.input, source);
    let started!: () => void;
    const sending = new Promise<void>(resolve => started = resolve);
    let respond!: () => void;
    network.mockImplementation(async () => {
      const response = new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        description: 'rate limited',
        parameters: {retry_after: 30}
      }), {status: 429});
      started();
      return new Promise<Response>(resolve => respond = () => resolve(response));
    });
    await f.hub.updateSettings({...await f.hub.getSettings(), paused: false});
    now += 1001;
    const alarm = runDurableObjectAlarm(f.hub).catch(error => {
      expect(String(error)).toContain('RESOURCE_DELETED');
    });
    await sending;
    expect(await bindings.HUB.getByName(hubName(f.id)).decommission()).toBe(true);
    respond();
    await alarm;
    f.hub = bindings.HUB.getByName(hubName(f.id));
    expect(await stored(f.hub)).toEqual({deliveries: 0, notifications: 0, subscribers: 0, settings: 0, alarm: null});
    expect(await runInDurableObject(f.hub, (_, state) => state.storage.sql.exec('SELECT COUNT(*) AS count FROM queue_state').one().count)).toBe(0);
  });
});
