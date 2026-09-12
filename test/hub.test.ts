import {env} from 'cloudflare:workers';
import {evictDurableObject, runDurableObjectAlarm, runInDurableObject} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {NotificationHub} from '../src/hub';
import type {Env, NotificationInput, TenantLimits, TenantRuntime} from '../src/types';
import {hubName} from '../src/types';

const bindings = env as unknown as Env;
const source = {ip: '203.0.113.10', country: 'DE', source: 'api'};
const input: NotificationInput = {
  application: 'Payments', event: 'deployment.failed', level: 'error',
  timestamp: '2026-09-12T08:30:00.000Z', text: 'Deployment could not pass its health check.',
};

let hub: DurableObjectStub<NotificationHub>;
let updateId: number;
let now: number;

async function subscribe(chatId: number, text = '/start', type = 'private') {
  await hub.handleUpdate({
    update_id: ++updateId,
    message: {chat: {id: chatId, type}, from: {first_name: `User ${chatId}`, username: `user${chatId}`}, text}
  });
}

async function resume() {
  await hub.updateSettings({...await hub.getSettings(), paused: false});
}

async function tick(milliseconds = 1_001) {
  now += milliseconds;
  await runDurableObjectAlarm(hub);
}

function accepted() {
  return new Response(JSON.stringify({
    ok: true,
    result: {message_id: 100}
  }), {headers: {'Content-Type': 'application/json'}});
}

async function legacyDelivery(notificationId: string) {
  // Previously accepted deliveries have no rich snapshot and must finish through their original stages.
  await runInDurableObject(hub, (_, state) => state.storage.sql.exec('UPDATE deliveries SET system_payload = NULL WHERE notification_id = ?', notificationId));
}

beforeEach(async () => {
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  hub = bindings.HUB.get(bindings.HUB.idFromName(`hub-test-${crypto.randomUUID()}`));
  await hub.initializeTenant('default');
  const registry = bindings.TENANTS.getByName('registry');
  if (!(await registry.getRuntime('default'))?.botToken) {
    const validation = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      result: {id: 123456, is_bot: true, first_name: 'Default test bot', username: 'default_test_bot'}
    })));
    try {
      await registry.configureBot('default', '123456:test-token');
    } finally {
      validation.mockRestore();
    }
  }
  updateId = 0;
  await hub.updateSettings({...await hub.getSettings(), paused: true, welcomeMessage: ''});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('durable membership and notification acceptance', () => {
  it('subscribes private chats once, durably deduplicates updates, and stops or disables membership', async () => {
    await hub.updateSettings({...await hub.getSettings(), welcomeMessage: 'Welcome'});
    const start = {
      update_id: 101,
      message: {chat: {id: 1, type: 'private'}, from: {first_name: 'Ali'}, text: '/start'}
    };
    await hub.handleUpdate(start);
    await hub.handleUpdate(start);
    await subscribe(1);
    await subscribe(-100, '/start', 'supergroup');
    expect((await hub.listSubscribers(1)).total).toBe(1);
    expect(await runInDurableObject(hub, (_, state) => state.storage.sql.exec('SELECT COUNT(*) AS count FROM deliveries WHERE notification_id IS NULL').one().count)).toBe(1);
    await subscribe(1, '/stop');
    await hub.handleUpdate(start);
    expect((await hub.listSubscribers(1)).items[0].active).toBe(false);
    expect(await runInDurableObject(hub, (_, state) => state.storage.sql.exec('SELECT status FROM deliveries LIMIT 1').one().status)).toBe('skipped');
    await subscribe(1);
    await hub.handleUpdate({
      update_id: 102,
      my_chat_member: {chat: {id: 1, type: 'private'}, new_chat_member: {status: 'kicked'}}
    });
    expect((await hub.listSubscribers(1)).items[0].active).toBe(false);
  });

  it('fans out atomically to the current subscribers and rejects conflicting idempotency keys', async () => {
    await subscribe(1);
    await subscribe(2);
    const first = await hub.enqueue(input, source, 'build-42', 'stable-request');
    await subscribe(3);
    const repeated = await hub.enqueue({
      ...input,
      timestamp: '2026-09-12T09:30:00.000Z'
    }, source, 'build-42', 'stable-request');
    expect(repeated.duplicate).toBe(true);
    expect(repeated.notification.id).toBe(first.notification.id);
    expect(first.notification.total).toBe(2);
    expect((await hub.getNotification(first.notification.id))?.deliveries.map((entry) => entry.chatId)).toEqual(['1', '2']);
    // Resolve the RPC thenable inside an ordinary promise before Vitest inspects it.
    await expect((async () => await hub.enqueue({
      ...input,
      text: 'Different message'
    }, source, 'build-42', 'different-request'))()).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await runInDurableObject(hub, (_, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it('reports real empty delivery totals and zero-filled daily buckets', async () => {
    const result = await hub.enqueue(input, source);
    expect(result.notification).toMatchObject({status: 'empty', total: 0, sent: 0});
    const overview = await hub.getOverview();
    expect(overview.subscribers).toEqual({total: 0, active: 0});
    expect(overview.daily).toHaveLength(7);
    expect(overview.daily.every((day) => day.sent === 0 && day.failed === 0)).toBe(true);
  });
});

describe('persistent Telegram delivery queue', () => {
  it('persists one rich snapshot for the recipient fan-out and sends it unchanged after eviction', async () => {
    await subscribe(1);
    await subscribe(2);
    const result = await hub.enqueue({
      ...input,
      url: 'https://ci.example.com/builds/42',
      silent: true
    }, source, 'rich-build-42');
    const snapshots = await runInDurableObject(hub, (_, state) => state.storage.sql.exec('SELECT system_payload FROM deliveries WHERE notification_id = ?', result.notification.id).toArray());
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].system_payload).toBe(snapshots[1].system_payload);
    const stored = JSON.parse(String(snapshots[0].system_payload));
    expect(stored).toMatchObject({
      method: 'sendRichMessage',
      rich_message: {is_rtl: false, skip_entity_detection: true}
    });
    expect(JSON.stringify(stored.rich_message)).toContain(input.text);
    expect(JSON.stringify(stored.rich_message)).toContain('https://ci.example.com/builds/42');
    await hub.updateSettings({...await hub.getSettings(), showCountryFlag: false});
    await evictDurableObject(hub);
    const duplicate = await hub.enqueue({
      ...input,
      url: 'https://ci.example.com/builds/42',
      silent: true
    }, source, 'rich-build-42');
    expect(duplicate).toMatchObject({duplicate: true, notification: {id: result.notification.id, total: 2}});
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await resume();
    await runDurableObjectAlarm(hub);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, request] of fetch.mock.calls) {
      expect(String(url)).toContain('/sendRichMessage');
      const payload = JSON.parse(String(request?.body));
      expect(payload.rich_message).toEqual(stored.rich_message);
      expect(payload.disable_notification).toBe(true);
      expect(payload).not.toHaveProperty('text');
      expect(payload).not.toHaveProperty('photo');
    }
    expect((await hub.getNotification(result.notification.id))?.notification).toMatchObject({
      status: 'completed',
      sent: 2
    });
  });

  it('delivers a new long notification and its photo as one rich message', async () => {
    await subscribe(1);
    const photo = 'https://example.com/alert.png';
    const text = 'Full detail. '.repeat(100);
    const result = await hub.enqueue({...input, image: photo, text}, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await resume();
    await runDurableObjectAlarm(hub);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/sendRichMessage');
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(JSON.stringify(payload.rich_message)).toContain(photo);
    expect(JSON.stringify(payload.rich_message)).toContain(text);
    expect(payload).not.toHaveProperty('caption');
    expect(payload).not.toHaveProperty('photo');
    expect((await hub.getNotification(result.notification.id))?.deliveries[0]).toMatchObject({
      status: 'sent',
      attempts: 1,
      stage: 0,
      partial: false
    });
  });

  it('does not fall back to legacy sends when Telegram rejects a rich message', async () => {
    await subscribe(1);
    const result = await hub.enqueue({...input, image: 'existing_telegram_file_id'}, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: false,
      error_code: 400,
      description: 'Bad rich message'
    }), {status: 400}));
    await resume();
    await runDurableObjectAlarm(hub);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/sendRichMessage');
    expect((await hub.getNotification(result.notification.id))?.deliveries[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      stage: 0
    });
  });

  it('pauses and resumes delivery while enforcing a global 429 cooldown', async () => {
    await subscribe(1);
    await subscribe(2);
    const notification = await hub.enqueue(input, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      parameters: {retry_after: 2}
    }), {status: 429})).mockImplementation(async () => accepted());
    await runDurableObjectAlarm(hub);
    expect(fetch).not.toHaveBeenCalled();
    await resume();
    await runDurableObjectAlarm(hub);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await hub.getNotification(notification.notification.id))?.deliveries).toMatchObject([{status: 'pending'}, {status: 'pending'}]);
    await tick(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await tick(1_001);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/sendRichMessage'))).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).rich_message).toEqual(JSON.parse(String(fetch.mock.calls[1][1]?.body)).rich_message);
    expect((await hub.getNotification(notification.notification.id))?.notification).toMatchObject({
      status: 'completed',
      sent: 2,
      pending: 0
    });
  });

  it('does not retry uncertain transport outcomes and never exposes token-bearing errors', async () => {
    await subscribe(1);
    const result = await hub.enqueue(input, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout https://api.telegram.org/bot123456:test-token/sendMessage'));
    await resume();
    await runDurableObjectAlarm(hub);
    await tick();
    const detail = await hub.getNotification(result.notification.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/sendRichMessage');
    expect(detail?.notification.unknown).toBe(1);
    expect(detail?.deliveries[0]).toMatchObject({status: 'unknown', attempts: 1});
    expect(detail?.deliveries[0].error).not.toContain('test-token');
  });

  it('marks Telegram 5xx and malformed successful responses as unknown', async () => {
    await subscribe(1);
    const first = await hub.enqueue(input, source);
    const second = await hub.enqueue({...input, event: 'next.event'}, source);
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response('upstream failure', {status: 502}))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ok: true, result: {}})));
    await resume();
    await runDurableObjectAlarm(hub);
    await tick();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await hub.getNotification(first.notification.id))?.notification.unknown).toBe(1);
    expect((await hub.getNotification(second.notification.id))?.notification.unknown).toBe(1);
  });

  it('deactivates a blocked subscriber and skips their remaining queued notifications', async () => {
    await subscribe(1);
    const first = await hub.enqueue(input, source);
    const second = await hub.enqueue({...input, event: 'next.event'}, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: false,
      error_code: 403,
      description: 'Forbidden'
    }), {status: 403}));
    await resume();
    await runDurableObjectAlarm(hub);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await hub.listSubscribers(1)).items[0].active).toBe(false);
    expect((await hub.getNotification(first.notification.id))?.notification.failed).toBe(1);
    expect((await hub.getNotification(second.notification.id))?.notification.skipped).toBe(1);
  });

  it('preserves legacy long-image stages across eviction', async () => {
    await subscribe(1);
    const result = await hub.enqueue({
      ...input,
      image: 'https://example.com/alert.png',
      text: 'Full detail. '.repeat(100)
    }, source);
    await legacyDelivery(result.notification.id);
    await evictDurableObject(hub);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await resume();
    await runDurableObjectAlarm(hub);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/sendPhoto');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).caption.length).toBeLessThanOrEqual(1_024);
    expect((await hub.getNotification(result.notification.id))?.deliveries[0]).toMatchObject({
      status: 'pending',
      stage: 1,
      partial: true
    });
    await tick(500);
    expect(fetch).toHaveBeenCalledTimes(1);
    await tick(501);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toContain('/sendMessage');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).text).toContain('Full detail. '.repeat(100));
    expect((await hub.getNotification(result.notification.id))?.deliveries[0]).toMatchObject({
      status: 'sent',
      attempts: 2,
      partial: false
    });
  });

  it('preserves photo-partial truth when text delivery becomes uncertain', async () => {
    await subscribe(1);
    const result = await hub.enqueue({
      ...input,
      image: 'existing_telegram_file_id',
      text: 'Detail '.repeat(200)
    }, source);
    await legacyDelivery(result.notification.id);
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => accepted()).mockRejectedValueOnce(new Error('connection reset'));
    await resume();
    await runDurableObjectAlarm(hub);
    await tick();
    expect((await hub.getNotification(result.notification.id))?.notification.status).toBe('partial');
    expect((await hub.getNotification(result.notification.id))?.deliveries[0]).toMatchObject({
      status: 'unknown',
      stage: 1,
      partial: true
    });
  });

  it('recovers a persisted in-flight attempt after eviction without resending it', async () => {
    await subscribe(1);
    const result = await hub.enqueue(input, source);
    await runInDurableObject(hub, (_, state) => {
      state.storage.sql.exec("UPDATE deliveries SET status = 'sending', attempts = 1");
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await evictDurableObject(hub);
    const detail = await hub.getNotification(result.notification.id);
    expect(detail?.deliveries[0].status).toBe('unknown');
    await resume();
    await runDurableObjectAlarm(hub);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds retries to five attempts per stage when Telegram repeatedly rejects with 429', async () => {
    await subscribe(1);
    const result = await hub.enqueue(input, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      parameters: {retry_after: 1}
    }), {status: 429}));
    await resume();
    for (let count = 0; count < 7; count++) await tick();
    expect(fetch).toHaveBeenCalledTimes(5);
    expect((await hub.getNotification(result.notification.id))?.deliveries[0]).toMatchObject({
      status: 'failed',
      attempts: 5
    });
  });

  it('preserves unfinished notifications and hides expired reports before bounded fan-out cleanup', async () => {
    await runInDurableObject(hub, (_, state) => {
      for (let index = 1; index <= 600; index++) {
        state.storage.sql.exec('INSERT INTO subscribers (chat_id, first_name, joined_at, updated_at) VALUES (?, ?, 1, 1)', String(index), `Subscriber ${index}`);
      }
    });
    const old = await hub.enqueue(input, source, 'old-notification');
    await runInDurableObject(hub, (_, state) => state.storage.sql.exec('UPDATE notifications SET created_at = 1'));
    now += 60_001;
    await hub.enqueue({...input, event: 'trigger.cleanup'}, source);
    expect((await hub.getNotification(old.notification.id))?.notification.total).toBe(600);
    await runInDurableObject(hub, (_, state) => state.storage.sql.exec("UPDATE deliveries SET status = 'sent' WHERE notification_id = ?", old.notification.id));
    now += 60_001;
    await hub.enqueue({...input, event: 'trigger.cleanup.again'}, source);
    expect(await hub.getNotification(old.notification.id)).toBeNull();
    expect((await hub.listNotifications(1)).items.some((entry) => entry.id === old.notification.id)).toBe(false);
    const remaining = await runInDurableObject(hub, (_, state) => state.storage.sql.exec('SELECT COUNT(*) AS count FROM deliveries WHERE notification_id = ?', old.notification.id).one().count);
    expect(remaining).toBe(100);
    const overview = await hub.getOverview();
    expect(overview.notifications.total).toBe(2);
    expect(overview.deliveries.sent).toBe(0);
    expect(overview.daily.every((day) => day.sent === 0)).toBe(true);
    expect(overview.levels.find((level) => level.level === 'error')?.count).toBe(2);
    expect(overview.recent.some((entry) => entry.id === old.notification.id)).toBe(false);
    now += 60_001;
    const replacement = await hub.enqueue({...input, event: 'new.with.expired.key'}, source, 'old-notification');
    expect(replacement.duplicate).toBe(false);
    expect(replacement.notification.id).not.toBe(old.notification.id);
    expect(await runInDurableObject(hub, (_, state) => state.storage.sql.exec('SELECT COUNT(*) AS count FROM notifications WHERE id = ?', old.notification.id).one().count)).toBe(0);
  });

  it('adds the purge marker to an existing database without losing queued notifications', async () => {
    await subscribe(1);
    const pending = await hub.enqueue(input, source, 'preserved-job');
    await runInDurableObject(hub, (_, state) => {
      state.storage.sql.exec('DROP INDEX notifications_visible_created');
      state.storage.sql.exec('ALTER TABLE notifications DROP COLUMN purging');
    });
    await evictDurableObject(hub);
    expect((await hub.getNotification(pending.notification.id))?.notification).toMatchObject({total: 1, pending: 1});
    expect(await runInDurableObject(hub, (_, state) => state.storage.sql.exec('PRAGMA table_info(notifications)').toArray().some((column) => column.name === 'purging'))).toBe(true);
    expect((await hub.enqueue(input, source, 'preserved-job')).duplicate).toBe(true);
  });
});

let botIdSequence = 800000;

async function tenant(limits: Partial<TenantLimits> = {}) {
  const id = `hub-${crypto.randomUUID()}`;
  const registry = bindings.TENANTS.getByName('registry');
  const botId = ++botIdSequence;
  await registry.createTenant({id, name: `Tenant ${id}`, limits});
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    ok: true,
    result: {id: botId, is_bot: true, first_name: 'Test', username: 'tenant_test_bot'}
  })));
  await registry.configureBot(id, `${botId}:tenant-token-${id}`);
  mock.mockRestore();
  const tenantHub = bindings.HUB.getByName(hubName(id));
  await tenantHub.updateSettings({...await tenantHub.getSettings(), paused: true, welcomeMessage: ''});
  return {id, botId, hub: tenantHub, registry};
}

describe('tenant isolation and durable limits', () => {
  it('keeps tenants isolated and refuses identity retargeting after eviction', async () => {
    const first = await tenant();
    const second = await tenant();
    hub = first.hub;
    await subscribe(1);
    const sent = await hub.enqueue(input, source);
    expect((await second.hub.listSubscribers(1)).total).toBe(0);
    expect(await second.hub.getNotification(sent.notification.id)).toBeNull();
    expect((await first.hub.getSettings()).projectName).toBe(`Tenant ${first.id}`);
    await first.hub.initializeTenant(first.id, 'Must not overwrite settings');
    expect((await first.hub.getSettings()).projectName).toBe(`Tenant ${first.id}`);
    await evictDurableObject(first.hub);
    await expect((async () => await first.hub.initializeTenant(second.id))()).rejects.toThrow('TENANT_DISABLED:');
    expect((await first.hub.getNotification(sent.notification.id))?.notification.total).toBe(1);
  });

  it('fails closed for unknown tenants and missing bot credentials', async () => {
    const unknown = bindings.HUB.getByName(`unknown-${crypto.randomUUID()}`);
    await unknown.initializeTenant('nonexistent-tenant');
    await expect((async () => await unknown.enqueue(input, source))()).rejects.toThrow('TENANT_DISABLED:');
    const registry = bindings.TENANTS.getByName('registry');
    const id = `blank-${crypto.randomUUID()}`;
    await registry.createTenant({id, name: 'Unconfigured'});
    await expect((async () => await bindings.HUB.getByName(hubName(id)).enqueue(input, source))()).rejects.toThrow('BOT_NOT_CONFIGURED:');
  });

  it('counts accepted notifications durably without counting duplicates or forgetting purged records', async () => {
    const account = await tenant({notificationsPerDay: 1});
    hub = account.hub;
    const first = await hub.enqueue(input, source, 'daily-one');
    await evictDurableObject(hub);
    expect((await hub.enqueue(input, source, 'daily-one')).duplicate).toBe(true);
    expect((await hub.getUsage()).notificationsToday).toBe(1);
    await expect((async () => await hub.enqueue({
      ...input,
      event: 'second'
    }, source))()).rejects.toThrow('DAILY_LIMIT:');
    await runInDurableObject(hub, (_, state) => state.storage.sql.exec('UPDATE notifications SET created_at = 1'));
    now += 60_001;
    await expect((async () => await hub.enqueue({
      ...input,
      event: 'after-retention'
    }, source))()).rejects.toThrow('DAILY_LIMIT:');
    expect(await hub.getNotification(first.notification.id)).toBeNull();
    expect((await hub.getUsage()).notificationsToday).toBe(1);
    now += 86_400_000;
    expect((await hub.getUsage()).notificationsToday).toBe(0);
    await hub.enqueue(input, source);
    expect((await hub.getUsage()).notificationsToday).toBe(1);
  });

  it('enforces concurrent daily admissions atomically', async () => {
    const account = await tenant({notificationsPerDay: 1});
    hub = account.hub;
    const results = await Promise.allSettled([1, 2, 3].map(async (index) => await hub.enqueue({
      ...input,
      event: `concurrent.${index}`
    }, source)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await hub.getUsage()).notificationsToday).toBe(1);
  });

  it('counts active subscribers, including reactivation, and counts welcomes toward queue capacity', async () => {
    const account = await tenant({maxSubscribers: 1, maxPendingDeliveries: 1});
    hub = account.hub;
    await hub.updateSettings({...await hub.getSettings(), welcomeMessage: 'Welcome'});
    await subscribe(1);
    await subscribe(1);
    expect(await hub.getUsage()).toMatchObject({activeSubscribers: 1, pendingDeliveries: 1});
    await expect(subscribe(2)).rejects.toThrow('SUBSCRIBER_LIMIT:');
    await expect((async () => await hub.enqueue(input, source))()).rejects.toThrow('QUEUE_LIMIT:');
    expect((await hub.getUsage()).notificationsToday).toBe(0);
    await subscribe(1, '/stop');
    await subscribe(2);
    expect(await hub.getUsage()).toMatchObject({activeSubscribers: 1, pendingDeliveries: 1});
    await expect(subscribe(1)).rejects.toThrow('SUBSCRIBER_LIMIT:');
  });

  it('honors disabled state while still processing privacy opt-outs', async () => {
    const account = await tenant();
    hub = account.hub;
    await subscribe(1);
    const notification = await hub.enqueue(input, source);
    await account.registry.updateTenant(account.id, {enabled: false});
    await expect((async () => await hub.enqueue(input, source))()).rejects.toThrow('TENANT_DISABLED:');
    await subscribe(2);
    await subscribe(1, '/stop');
    expect(await hub.getUsage()).toMatchObject({activeSubscribers: 0, pendingDeliveries: 0});
    expect((await hub.listSubscribers(1)).total).toBe(1);
    expect((await hub.getNotification(notification.notification.id))?.notification.skipped).toBe(1);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await resume();
    await runDurableObjectAlarm(hub);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses tenant bot credentials and rechecks enabled state between sends', async () => {
    const account = await tenant();
    hub = account.hub;
    await subscribe(1);
    await subscribe(2);
    const notification = await hub.enqueue(input, source);
    let release!: () => void;
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = accepted();
      announce();
      return new Promise<Response>((resolve) => {
        release = () => resolve(response);
      });
    });
    await resume();
    const alarm = runDurableObjectAlarm(hub);
    await started;
    await bindings.TENANTS.getByName('registry').updateTenant(account.id, {enabled: false});
    now += 1_001;
    release();
    await alarm;
    hub = bindings.HUB.get(hub.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain(`bot${account.botId}:tenant-token-${account.id}/sendRichMessage`);
    expect((await hub.getNotification(notification.notification.id))?.deliveries[0].error).toBeNull();
    expect((await hub.getNotification(notification.notification.id))?.notification).toMatchObject({
      sent: 1,
      pending: 1
    });
  });
});

describe('per-instance read cache', () => {
  it('caches rate-limit reads without losing durable counts or changed limits after eviction', async () => {
    expect(await hub.rateLimit('producer', 3, 60)).toBe(true);
    await runInDurableObject(hub, (instance, state) => {
      const sql = vi.spyOn(state.storage.sql, 'exec');
      expect(instance.rateLimit('producer', 3, 60)).toBe(true);
      expect(instance.rateLimit('producer', 2, 60)).toBe(false);
      expect(instance.rateLimit('producer', 3, 60)).toBe(true);
      expect(instance.rateLimit('producer', 3, 60)).toBe(false);
      expect(sql.mock.calls).toHaveLength(2);
      expect(sql.mock.calls.every(([query]) => String(query).startsWith('UPDATE rate_limits'))).toBe(true);
      sql.mockRestore();
    });
    await evictDurableObject(hub);
    expect(await hub.rateLimit('producer', 3, 60)).toBe(false);
    now += 60_001;
    expect(await hub.rateLimit('producer', 3, 60)).toBe(true);
    expect(await runInDurableObject(hub, (_, state) => state.storage.sql.exec("SELECT count FROM rate_limits WHERE key = 'producer'").one().count)).toBe(1);
    await runInDurableObject(hub, (instance) => {
      for (let index = 0; index < 270; index++) instance.rateLimit(`bounded-${index}`, 10, 60);
      expect((instance as unknown as {
        rateCounters: Map<string, unknown>
      }).rateCounters.size).toBeLessThanOrEqual(256);
    });
  });

  it('preserves a registry wake that arrives while an alarm holds an older disabled snapshot', async () => {
    await hub.enqueue(input, source);
    await runInDurableObject(hub, async (instance, state) => {
      const target = instance as unknown as { runtime(): Promise<TenantRuntime> };
      const previous = await target.runtime();
      const runtime = vi.spyOn(target, 'runtime').mockImplementationOnce(async () => {
        await instance.wake();
        return {...previous, enabled: false};
      });
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(now + 1_000);
      expect(runtime).toHaveBeenCalledTimes(1);
      runtime.mockRestore();
    });
  });

  it('retains a short retry alarm when authoritative tenant runtime is temporarily unavailable', async () => {
    await hub.enqueue(input, source);
    await runInDurableObject(hub, async (instance, state) => {
      const runtime = vi.spyOn(instance as unknown as {
        runtime(): Promise<TenantRuntime>
      }, 'runtime').mockRejectedValueOnce(new Error('Registry temporarily unavailable'));
      await expect(instance.alarm()).rejects.toThrow('Registry temporarily unavailable');
      expect(await state.storage.getAlarm()).toBe(now + 30_000);
      runtime.mockRestore();
    });
  });

  it('serves repeated settings, overview, list, detail, subscribers and usage without SQL', async () => {
    await subscribe(1);
    const notification = await hub.enqueue(input, source);
    await runInDurableObject(hub, (instance, state) => {
      instance.getSettings();
      instance.getOverview();
      instance.listNotifications(1);
      instance.getNotification(notification.notification.id);
      instance.listSubscribers(1);
      instance.getUsage();
      const sql = vi.spyOn(state.storage.sql, 'exec');
      for (let index = 0; index < 3; index++) {
        instance.getSettings();
        instance.getOverview();
        instance.listNotifications(1);
        instance.getNotification(notification.notification.id);
        instance.listSubscribers(1);
        instance.getUsage();
      }
      expect(sql).not.toHaveBeenCalled();
      sql.mockRestore();
    });
  });

  it('invalidates reads immediately on membership and delivery writes and reloads after eviction', async () => {
    expect((await hub.getOverview()).subscribers.active).toBe(0);
    await subscribe(1);
    expect((await hub.getOverview()).subscribers.active).toBe(1);
    const notification = await hub.enqueue(input, source);
    expect((await hub.getNotification(notification.notification.id))?.notification.pending).toBe(1);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await resume();
    await runDurableObjectAlarm(hub);
    expect((await hub.getNotification(notification.notification.id))?.notification.sent).toBe(1);
    expect((await hub.getOverview()).deliveries.sent).toBe(1);
    await hub.updateSettings({...await hub.getSettings(), projectName: 'Persisted settings'});
    await evictDurableObject(hub);
    expect((await hub.getSettings()).projectName).toBe('Persisted settings');
    expect((await hub.getOverview()).deliveries.sent).toBe(1);
    await subscribe(1, '/stop');
    expect((await hub.listSubscribers(1)).items[0].active).toBe(false);
  });

  it('expires cached reports and bounds keys while throttling cleanup between ingestions', async () => {
    await hub.enqueue(input, source);
    await hub.getOverview();
    now += 30_001;
    await runInDurableObject(hub, (instance, state) => {
      const sql = vi.spyOn(state.storage.sql, 'exec');
      instance.getOverview();
      expect(sql).toHaveBeenCalled();
      for (let index = 0; index < 70; index++) instance.listNotifications(index + 1);
      expect((instance as unknown as { readCache: Map<string, unknown> }).readCache.size).toBeLessThanOrEqual(64);
      sql.mockRestore();
    });
    await runInDurableObject(hub, async (instance, state) => {
      const sql = vi.spyOn(state.storage.sql, 'exec');
      await instance.enqueue({...input, event: 'second.within.cleanup.window'}, source);
      expect(sql.mock.calls.some(([query]) => /^DELETE\b|UPDATE notifications\s+SET purging/m.test(String(query).trim()))).toBe(false);
      sql.mockRestore();
    });
  });
});

describe('subscriber bans and application filtering', () => {
  it('bans a bounded batch, skips pending deliveries, and requires a fresh start after unban', async () => {
    await subscribe(1);
    await subscribe(2);
    const notification = await hub.enqueue(input, source);
    expect(await hub.setSubscriberBan(['1', '2', '1', '999'], true, 'Abuse')).toEqual({updated: 2});
    expect((await hub.getUsage()).activeSubscribers).toBe(0);
    expect((await hub.getNotification(notification.notification.id))?.notification.skipped).toBe(2);
    await subscribe(1);
    expect((await hub.listSubscribers(1)).items.find((row) => row.chatId === '1')).toMatchObject({
      banned: true,
      banReason: 'Abuse',
      active: false
    });
    expect((await hub.enqueue(input, source)).notification.total).toBe(0);
    await hub.setSubscriberBan(['1'], false);
    expect((await hub.listSubscribers(1)).items.find((row) => row.chatId === '1')).toMatchObject({
      banned: false,
      banReason: null,
      active: false
    });
    await subscribe(1);
    expect((await hub.getUsage()).activeSubscribers).toBe(1);
    await expect((async () => await hub.setSubscriberBan(Array.from({length: 101}, (_, index) => String(index)), true))()).rejects.toThrow('between 1 and 100');
    await expect((async () => await hub.setSubscriberBan(['1'], true, 'x'.repeat(201)))()).rejects.toThrow('at most 200');
  });

  it('rechecks bans after persisting an attempt and before making the network call', async () => {
    await subscribe(1);
    const notification = await hub.enqueue(input, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await resume();
    await runInDurableObject(hub, async (instance, state) => {
      const actualSync = state.storage.sync.bind(state.storage);
      const sync = vi.spyOn(state.storage, 'sync').mockImplementationOnce(async () => {
        instance.setSubscriberBan(['1'], true);
        await actualSync();
      });
      await instance.alarm();
      sync.mockRestore();
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await hub.getNotification(notification.notification.id))?.notification.skipped).toBe(1);
  });

  it('preserves an in-flight successful send while banning its subsequent queued messages', async () => {
    await subscribe(1);
    const first = await hub.enqueue(input, source);
    const second = await hub.enqueue({...input, event: 'second'}, source);
    let release!: () => void;
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = accepted();
      announce();
      return new Promise<Response>((resolve) => {
        release = () => resolve(response);
      });
    });
    await resume();
    const alarm = runDurableObjectAlarm(hub);
    await started;
    await bindings.HUB.get(hub.id).setSubscriberBan(['1'], true);
    release();
    await alarm;
    hub = bindings.HUB.get(hub.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await hub.getNotification(first.notification.id))?.deliveries[0].error).toBeNull();
    expect((await hub.getNotification(first.notification.id))?.notification.sent).toBe(1);
    expect((await hub.getNotification(second.notification.id))?.notification.skipped).toBe(1);
  });

  it('adds ban columns to existing subscribers without changing their membership', async () => {
    await subscribe(1);
    await runInDurableObject(hub, (_, state) => {
      state.storage.sql.exec('ALTER TABLE subscribers DROP COLUMN banned');
      state.storage.sql.exec('ALTER TABLE subscribers DROP COLUMN ban_reason');
    });
    await evictDurableObject(hub);
    expect((await hub.listSubscribers(1)).items[0]).toMatchObject({active: true, banned: false, banReason: null});
  });

  it('filters notifications by their authenticated application identity without mixing cached filters', async () => {
    await hub.enqueue({...input, applicationId: 'app-one'}, source);
    await hub.enqueue({...input, applicationId: 'app-two'}, source);
    const first = await hub.listNotifications(1, undefined, undefined, 'app-one');
    const second = await hub.listNotifications(1, undefined, undefined, 'app-two');
    expect(first.total).toBe(1);
    expect(second.total).toBe(1);
    expect(first.items[0].applicationId).toBe('app-one');
    expect(second.items[0].applicationId).toBe('app-two');
    expect((await hub.listNotifications(1)).total).toBe(2);
  });
});

async function chooseApplications(chatId: number, data: string, from = chatId) {
  const id = ++updateId;
  await hub.handleUpdate({
    update_id: id, callback_query: {
      id: `callback-${id}`, from: {id: from}, data,
      message: {message_id: 44, chat: {id: chatId, type: 'private'}},
    }
  });
}

async function applicationsTenant() {
  const account = await tenant();
  await account.registry.createApplication(account.id, {id: 'payments', name: 'پرداخت‌ها'});
  await account.registry.createApplication(account.id, {id: 'deployments', name: 'استقرارها'});
  hub = account.hub;
  return account;
}

describe('subscriber application preferences', () => {
  it('defaults to all, supports selected apps, and restores all when the final choice is removed', async () => {
    await applicationsTenant();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await subscribe(1);
    await subscribe(2);
    expect((await hub.enqueue({...input, applicationId: 'payments'}, source)).notification.total).toBe(2);
    await chooseApplications(1, 'apps:toggle:payments');
    expect((await hub.listSubscribers(1)).items.find((row) => row.chatId === '1')).toMatchObject({
      applicationMode: 'selected',
      applicationIds: ['payments']
    });
    expect((await hub.enqueue({...input, applicationId: 'deployments'}, source)).notification.total).toBe(1);
    expect((await hub.enqueue(input, source)).notification.total).toBe(1);
    await subscribe(1);
    expect((await hub.listSubscribers(1)).items.find((row) => row.chatId === '1')?.applicationMode).toBe('selected');
    await chooseApplications(1, 'apps:toggle:deployments');
    expect((await hub.enqueue({...input, applicationId: 'deployments'}, source)).notification.total).toBe(2);
    await chooseApplications(1, 'apps:toggle:payments');
    expect((await hub.enqueue({...input, applicationId: 'payments'}, source)).notification.total).toBe(1);
    await chooseApplications(1, 'apps:toggle:deployments');
    expect((await hub.listSubscribers(1)).items.find((row) => row.chatId === '1')).toMatchObject({
      applicationMode: 'all',
      applicationIds: []
    });
    expect((await hub.enqueue(input, source)).notification.total).toBe(2);
  });

  it('suppresses already queued excluded notifications and durably queues the Telegram menu', async () => {
    await applicationsTenant();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await subscribe(1);
    const payments = await hub.enqueue({...input, applicationId: 'payments'}, source);
    const deployments = await hub.enqueue({...input, applicationId: 'deployments'}, source);
    await chooseApplications(1, 'apps:toggle:payments');
    expect((await hub.getNotification(payments.notification.id))?.notification.pending).toBe(1);
    expect((await hub.getNotification(deployments.notification.id))?.notification.skipped).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/answerCallbackQuery');
    const menu = await runInDurableObject(hub, (_, state) => state.storage.sql.exec('SELECT rendered, system_payload FROM deliveries WHERE notification_id IS NULL AND system_payload IS NOT NULL LIMIT 1').one());
    expect(String(menu.rendered)).toContain('فقط اپلیکیشن‌های انتخاب‌شده');
    expect(JSON.parse(String(menu.system_payload))).toMatchObject({method: 'editMessageText', message_id: 44});
    await subscribe(1, '/all');
    expect((await hub.listSubscribers(1)).items[0].applicationMode).toBe('all');
  });

  it('rejects forged, foreign, disabled-app and banned-user callbacks without changing preferences', async () => {
    const account = await applicationsTenant();
    const other = await tenant();
    await other.registry.createApplication(other.id, {id: 'foreign-only', name: 'Foreign app'});
    hub = account.hub;
    await subscribe(1);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await chooseApplications(1, 'apps:toggle:payments', 99);
    await chooseApplications(1, 'apps:toggle:foreign-only');
    await account.registry.updateApplication(account.id, 'payments', {enabled: false});
    await chooseApplications(1, 'apps:toggle:payments');
    await hub.setSubscriberBan(['1'], true);
    await chooseApplications(1, 'apps:toggle:deployments');
    expect(fetch).not.toHaveBeenCalled();
    expect((await hub.listSubscribers(1)).items[0]).toMatchObject({
      applicationMode: 'all',
      applicationIds: [],
      banned: true
    });
    expect((await other.hub.listSubscribers(1)).total).toBe(0);
  });

  it('rechecks preferences after claiming a queued send and reloads selections after eviction', async () => {
    await applicationsTenant();
    await subscribe(1);
    const notification = await hub.enqueue({...input, applicationId: 'deployments'}, source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await resume();
    await runInDurableObject(hub, async (instance, state) => {
      const actualSync = state.storage.sync.bind(state.storage);
      const sync = vi.spyOn(state.storage, 'sync').mockImplementationOnce(async () => {
        (instance as unknown as {
          changeApplications(chatId: string, id: string | null): void
        }).changeApplications('1', 'payments');
        await actualSync();
      });
      await instance.alarm();
      sync.mockRestore();
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await hub.getNotification(notification.notification.id))?.notification.skipped).toBe(1);
    await evictDurableObject(hub);
    expect((await hub.listSubscribers(1)).items[0]).toMatchObject({
      applicationMode: 'selected',
      applicationIds: ['payments']
    });
  });

  it('delivers /apps with an inline keyboard through the paced queue', async () => {
    await applicationsTenant();
    await subscribe(1);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    await subscribe(1, '/apps');
    expect(fetch).not.toHaveBeenCalled();
    await resume();
    await runDurableObjectAlarm(hub);
    expect(fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(String(fetch.mock.calls[0][0])).toContain('/sendMessage');
    expect(payload).not.toHaveProperty('rich_message');
    expect(payload.reply_markup.inline_keyboard.flat().map((button: {
      callback_data: string
    }) => button.callback_data).sort()).toEqual(['apps:all', 'apps:toggle:deployments', 'apps:toggle:payments']);
    expect((await hub.getOverview()).notifications.total).toBe(0);
  });
});
