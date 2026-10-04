import {env} from 'cloudflare:workers';
import {evictDurableObject, runDurableObjectAlarm, runInDurableObject} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_WELCOME_MESSAGE, LEGACY_WELCOME_MESSAGE} from '../src/subscription-menu';
import {hubName, type Env, type NotificationInput, type TenantLimits} from '../src/types';
import type {NotificationHub} from '../src/hub';

const bindings = env as unknown as Env;
type Hub = DurableObjectStub<NotificationHub>;
const source = {ip: '203.0.113.10', country: 'DE', source: 'api'};
const notification: NotificationInput = {applicationId: 'alpha', application: 'Alpha', event: 'deploy.completed', level: 'success', timestamp: '2026-10-04T10:00:00.000Z', text: 'Deployment completed'};
let now: number;
let updateId: number;
let messageId: number;
let tokenId = 8_000_000;
let network: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  now = Date.now(); updateId = 0; messageId = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
    const id = Number(/bot(\d+):/.exec(String(request))?.[1] ?? 0);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const result = String(request).endsWith('/getMe')
      ? {id, is_bot: true, first_name: `Bot ${id}`, username: `bot_${id}`}
      : String(request).endsWith('/answerCallbackQuery') ? true : {message_id: body.message_id ?? ++messageId};
    return new Response(JSON.stringify({ok: true, result}));
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(limits: Partial<TenantLimits> = {}) {
  const id = `welcome-${crypto.randomUUID()}`;
  const registry = bindings.TENANTS.getByName('registry');
  await registry.createTenant({id, name: 'Welcome test tenant', limits});
  await registry.configureBot(id, `${++tokenId}:primary-token`);
  await registry.createBot(id, {id: 'secondary', name: 'Secondary bot', botToken: `${++tokenId}:secondary-token`});
  await registry.createApplication(id, {id: 'alpha', name: 'Alpha'});
  await registry.createApplication(id, {id: 'beta', name: 'Beta'});
  const primary = bindings.HUB.getByName(hubName(id));
  const secondary = bindings.HUB.getByName(hubName(id, 'secondary'));
  for (const hub of [primary, secondary]) await hub.updateSettings({...await hub.getSettings(), paused: true});
  network.mockClear();
  const toggle = async (enabled: boolean) => {
    const bot = (await registry.getBot(id, 'default'))!;
    await registry.updateBot(id, 'default', {expectedVersion: bot.version, enabled});
  };
  return {id, registry, primary, secondary, toggle};
}

async function command(hub: Hub, chat: number, text = '/start', fixedId?: number) {
  await hub.handleUpdate({update_id: fixedId ?? ++updateId, message: {chat: {id: chat, type: 'private'}, from: {id: chat, first_name: `User ${chat}`}, text}});
}
async function callback(hub: Hub, chat: number, receipt: number, data: string, from = chat, type = 'private') {
  await hub.handleUpdate({update_id: ++updateId, callback_query: {id: `callback-${updateId}`, from: {id: from}, data, message: {message_id: receipt, chat: {id: chat, type}}}});
}
async function tick(hub: Hub) {now += 1001; await runDurableObjectAlarm(hub);}
async function resume(hub: Hub) {await hub.updateSettings({...await hub.getSettings(), paused: false}); await tick(hub);}
function messages() {
  return network.mock.calls.filter((args: unknown[]) => /\/(sendMessage|editMessageText)$/.test(String(args[0])))
    .map((args: any[]) => ({method: String(args[0]).split('/').at(-1), ...JSON.parse(String(args[1].body))}));
}
function actions(payload: any): string[] {return payload.reply_markup.inline_keyboard.flat().map((button: any) => button.callback_data);}
async function receipt(hub: Hub, chat = '1') {
  return runInDurableObject(hub, (_, state) => Number(state.storage.sql.exec("SELECT telegram_message_id FROM deliveries WHERE chat_id = ? AND status = 'sent' AND telegram_message_id IS NOT NULL ORDER BY id DESC LIMIT 1", chat).one().telegram_message_id));
}
async function queued(hub: Hub) {
  return runInDurableObject(hub, (_, state) => state.storage.sql.exec("SELECT rendered, system_payload FROM deliveries WHERE status = 'pending' AND notification_id IS NULL ORDER BY id").toArray());
}

describe('durable subscription control menu', () => {
  it('sends a readable welcome with an inline action for every available command and no internal metadata', async () => {
    const f = await setup(); await command(f.primary, 1); await resume(f.primary);
    const payload = messages().at(-1)!;
    expect(payload.text).toBe(DEFAULT_WELCOME_MESSAGE);
    expect(payload.text.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(actions(payload)).toEqual(expect.arrayContaining(['menu:apps', 'menu:preferences', 'menu:all', 'menu:stop']));
    expect(payload.reply_markup.inline_keyboard.flat().every((button: any) => typeof button.text === 'string' && button.text.length > 0)).toBe(true);
    expect(payload).not.toHaveProperty('subscription_menu');
    expect(payload).not.toHaveProperty('directory_version');
    expect(payload).not.toHaveProperty('subscriber_version');
    expect(payload).not.toHaveProperty('preferences_version');
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: true, applicationMode: 'all'});
  });

  it('coalesces pending welcomes, deduplicates updates and lets an existing subscriber reopen the menu', async () => {
    const f = await setup();
    const update = ++updateId;
    await command(f.primary, 1, '/start', update); await command(f.primary, 1, '/start', update); await command(f.primary, 1);
    expect(await queued(f.primary)).toHaveLength(1);
    await resume(f.primary); expect(messages()).toHaveLength(1);
    await command(f.primary, 1); await tick(f.primary); expect(messages()).toHaveLength(2);
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(1);
  });

  it('opens apps and preferences in the existing message, preserves selection on start and respects admin restrictions on all', async () => {
    const f = await setup(); await command(f.primary, 1); await resume(f.primary);
    const message = await receipt(f.primary);
    const subscriber = (await f.primary.getSubscriber('1'))!;
    await f.primary.updateSubscriber('1', {expectedVersion: subscriber.version, accessMode: 'selected', allowedApplicationIds: ['alpha']});
    await callback(f.primary, 1, message, 'menu:apps'); await tick(f.primary);
    let payload = messages().at(-1)!;
    expect(payload).toMatchObject({method: 'editMessageText', message_id: message});
    expect(actions(payload)).toContain('apps:toggle:alpha'); expect(actions(payload)).not.toContain('apps:toggle:beta');
    expect(actions(payload)).toContain('menu:home');
    await callback(f.primary, 1, message, 'apps:toggle:alpha'); await tick(f.primary);
    await command(f.primary, 1); await tick(f.primary);
    expect(await f.primary.getSubscriber('1')).toMatchObject({applicationMode: 'selected', applicationIds: ['alpha']});
    await evictDurableObject(f.primary);
    await callback(f.primary, 1, message, 'menu:home'); await tick(f.primary);
    expect(actions(messages().at(-1)!)).toContain('menu:preferences');
    await callback(f.primary, 1, message, 'menu:preferences'); await tick(f.primary);
    payload = messages().at(-1)!;
    expect(payload).toMatchObject({method: 'editMessageText', message_id: message});
    expect(actions(payload)).toContain('prefs:level:info'); expect(actions(payload)).toContain('menu:home');
    expect(payload).not.toHaveProperty('preferences_version');
    await callback(f.primary, 1, message, 'menu:home'); await tick(f.primary);
    await callback(f.primary, 1, message, 'menu:all'); await tick(f.primary);
    expect(await f.primary.getSubscriber('1')).toMatchObject({applicationMode: 'all', allowedApplicationIds: ['alpha'], accessMode: 'selected'});
    expect((await f.primary.enqueue({...notification, applicationId: 'beta'}, source)).notification.total).toBe(0);
  });

  it('stops pending notifications immediately, delivers the stopped menu and resumes with the same durable membership', async () => {
    const f = await setup(); await command(f.primary, 1); await resume(f.primary);
    const message = await receipt(f.primary);
    const accepted = await f.primary.enqueue(notification, source);
    await callback(f.primary, 1, message, 'menu:stop'); await tick(f.primary);
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: false});
    expect((await f.primary.getNotification(accepted.notification.id))?.notification).toMatchObject({sent: 0, pending: 0});
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(0);
    expect(messages().at(-1)).toMatchObject({method: 'editMessageText', message_id: message});
    expect(actions(messages().at(-1)!)).toContain('menu:start');
    await callback(f.primary, 1, message, 'menu:start'); await tick(f.primary);
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: true});
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(1);
    expect(actions(messages().at(-1)!)).toContain('menu:stop');
  });

  it('checks the shared tenant subscriber quota when a stopped user clicks resume', async () => {
    const f = await setup({maxSubscribers: 1}); await command(f.primary, 1); await resume(f.primary);
    const message = await receipt(f.primary);
    await callback(f.primary, 1, message, 'menu:stop'); await tick(f.primary);
    await command(f.secondary, 2);
    await callback(f.primary, 1, message, 'menu:start');
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: false});
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(1);
    const denied = network.mock.calls.filter((args: unknown[]) => String(args[0]).endsWith('/answerCallbackQuery')).at(-1)!;
    expect(JSON.parse(String(denied[1]?.body))).toMatchObject({show_alert: true});
    expect(JSON.parse(String(denied[1]?.body)).text).toContain('ظرفیت');
    await command(f.secondary, 2, '/stop'); await callback(f.primary, 1, message, 'menu:start'); await tick(f.primary);
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: true});
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(1);
  });

  it('lets a user stop even when the pending-delivery quota is full', async () => {
    const f = await setup({maxPendingDeliveries: 1}); await command(f.primary, 1); await resume(f.primary);
    const message = await receipt(f.primary);
    const accepted = await f.primary.enqueue(notification, source);
    expect((await f.registry.getTenantUsage(f.id)).pendingDeliveries).toBe(1);
    await callback(f.primary, 1, message, 'menu:stop'); await tick(f.primary);
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: false});
    expect((await f.primary.getNotification(accepted.notification.id))?.notification).toMatchObject({sent: 0, pending: 0});
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(0);
  });

  it('suppresses a queued stopped-state reply when the subscriber is banned before delivery', async () => {
    const f = await setup(); await command(f.primary, 1); await resume(f.primary);
    const message = await receipt(f.primary);
    await callback(f.primary, 1, message, 'menu:stop');
    expect(await queued(f.primary)).toHaveLength(1);
    await f.primary.setSubscriberBan(['1'], true); network.mockClear(); await tick(f.primary);
    expect(messages()).toHaveLength(0);
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: false, banned: true});
  });

  it('retries an interrupted stopped-menu edit after eviction without requiring a successful edit receipt', async () => {
    const f = await setup(); await command(f.primary, 1); await resume(f.primary);
    const message = await receipt(f.primary);
    await callback(f.primary, 1, message, 'menu:stop');
    const interrupted = await runInDurableObject(f.primary, (_, state) => {
      state.storage.sql.exec("UPDATE deliveries SET status = 'sending', stage_attempts = 1, attempts = 1 WHERE status = 'pending' AND json_extract(system_payload, '$.subscription_menu') = 'stopped'");
      return state.storage.sql.exec("SELECT telegram_message_id, system_payload FROM deliveries WHERE status = 'sending'").one();
    });
    expect(interrupted.telegram_message_id).toBeNull();
    expect(JSON.parse(String(interrupted.system_payload))).toMatchObject({method: 'editMessageText', message_id: message});
    await evictDurableObject(f.primary); network.mockClear();
    await f.primary.getSettings(); // Run recovery before advancing past its retry deadline.
    await tick(f.primary);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({method: 'editMessageText', message_id: message});
    expect(actions(messages()[0])).toContain('menu:start');
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: false});
  });

  it('rejects missing receipts, other users, other chats, cross-bot controls and banned users', async () => {
    const f = await setup(); await command(f.primary, 1); await command(f.primary, 2); await command(f.secondary, 1);
    await resume(f.primary); await tick(f.primary);
    const message = await receipt(f.primary);
    network.mockClear();
    await callback(f.primary, 1, 99999, 'menu:stop');
    await callback(f.primary, 1, message, 'menu:stop', 2);
    await callback(f.primary, 2, message, 'menu:stop');
    await callback(f.primary, 1, message, 'menu:stop', 1, 'group');
    await callback(f.secondary, 1, message, 'menu:stop');
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: true});
    expect(await f.primary.getSubscriber('2')).toMatchObject({active: true});
    expect(await f.secondary.getSubscriber('1')).toMatchObject({active: true});
    expect(messages()).toHaveLength(0);
    expect(await queued(f.primary)).toHaveLength(0);
    network.mockClear();
    await f.primary.setSubscriberBan(['1'], true);
    await callback(f.primary, 1, message, 'menu:start'); await callback(f.primary, 1, message, 'menu:apps');
    expect(await f.primary.getSubscriber('1')).toMatchObject({banned: true});
    expect(messages()).toHaveLength(0);
    expect(await queued(f.primary)).toHaveLength(0);
  });

  it('honors a valid stop while the bot is disabled without acknowledging or sending messages', async () => {
    const f = await setup(); await command(f.primary, 1); await resume(f.primary);
    const message = await receipt(f.primary);
    await f.toggle(false); network.mockClear();
    await callback(f.primary, 1, message, 'menu:apps'); await callback(f.primary, 1, message, 'menu:preferences');
    await callback(f.primary, 1, message, 'menu:stop'); await tick(f.primary);
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: false});
    await callback(f.primary, 1, message, 'menu:start');
    expect(await f.primary.getSubscriber('1')).toMatchObject({active: false});
    expect(network).not.toHaveBeenCalled();
    expect((await f.registry.getTenantUsage(f.id)).activeSubscribers).toBe(0);
  });

  it('migrates the exact old default once and preserves literal custom welcomes and intentionally empty settings', async () => {
    const f = await setup();
    const current = await f.primary.getSettings();
    await runInDurableObject(f.primary, (_, state) => state.storage.sql.exec('UPDATE settings SET body = ? WHERE id = 1', JSON.stringify({...current, welcomeMessage: LEGACY_WELCOME_MESSAGE})));
    await evictDurableObject(f.primary);
    expect((await f.primary.getSettings()).welcomeMessage).toBe(DEFAULT_WELCOME_MESSAGE);
    const persisted = await runInDurableObject(f.primary, (_, state) => JSON.parse(String(state.storage.sql.exec('SELECT body FROM settings WHERE id = 1').one().body)));
    expect(persisted.welcomeMessage).toBe(DEFAULT_WELCOME_MESSAGE);
    const custom = 'Welcome <team> & *operators*\nKeep this custom text.';
    await f.primary.updateSettings({...await f.primary.getSettings(), welcomeMessage: custom});
    await evictDurableObject(f.primary); await command(f.primary, 1); await resume(f.primary);
    expect(messages().at(-1)?.text).toBe(custom);
    expect(messages().at(-1)).not.toHaveProperty('parse_mode');
    expect(actions(messages().at(-1)!)).toContain('menu:apps');
    await f.primary.updateSettings({...await f.primary.getSettings(), welcomeMessage: ''});
    await evictDurableObject(f.primary); network.mockClear();
    await command(f.primary, 2); await command(f.primary, 2); await tick(f.primary);
    expect((await f.primary.getSettings()).welcomeMessage).toBe('');
    expect(await f.primary.getSubscriber('2')).toMatchObject({active: true});
    expect(messages()).toHaveLength(0);
  });
});
