import {env} from 'cloudflare:workers';
import {evictDurableObject, reset, runInDurableObject} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TenantRegistry} from '../src/tenants';
import type {BotStatus, Env} from '../src/types';
import {TelegramError} from '../src/telegram';

const bindings = env as unknown as Env;
let registry: DurableObjectStub<TenantRegistry>;
const response = (result: unknown) => new Response(JSON.stringify({
  ok: true,
  result
}), {headers: {'Content-Type': 'application/json'}});
const bot = (id: number) => ({id, is_bot: true, first_name: 'Operations bot', username: `ops_bot_${id}`});
const reject = (operation: () => PromiseLike<unknown>) => (async () => await operation())();

beforeEach(async () => {
  registry = bindings.TENANTS.getByName('registry');
  await registry.getTenant('default');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('tenant registry persistence, isolation, and cache', () => {
  it('starts without bot credentials and never exposes secrets in tenant DTOs', async () => {
    const main = await registry.getRuntime('default');
    expect(main?.botToken).toBe('');
    expect(main?.botConfigured).toBe(false);
    expect(main?.botId).toBeNull();
    expect(main?.webhookSecret).toBe(bindings.TELEGRAM_WEBHOOK_SECRET);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unconfigured bots must not make network requests.'));
    const status = await registry.getBotStatus('default') as BotStatus;
    expect(status.configured.bot).toBe(false);
    expect(status.bot).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    const {tenant} = await registry.createTenant({id: 'payments', name: 'Payments'});
    const runtime = await registry.getRuntime('payments');
    expect(runtime?.botToken).toBe('');
    expect(runtime?.webhookSecret).toBe('');
    expect(tenant.botConfigured).toBe(false);
    const dto = JSON.stringify(await registry.listTenants());
    expect(dto).not.toContain('botToken');
    expect(dto).not.toContain(bindings.TELEGRAM_WEBHOOK_SECRET);
    expect(dto).not.toContain('apiKeyHash');
  });

  it('serves repeated tenant/runtime reads without SQL and survives object eviction', async () => {
    await registry.createTenant({id: 'cached', name: 'Cached tenant'});
    const queries = await runInDurableObject(registry, async (instance, state) => {
      const spy = vi.spyOn(state.storage.sql, 'exec');
      try {
        for (let i = 0; i < 5; i++) {
          await instance.listTenants();
          await instance.getTenant('cached');
          await instance.getRuntime('cached');
        }
        return spy.mock.calls.map(call => call[0]);
      } finally {
        spy.mockRestore();
      }
    });
    expect(queries).toEqual([]);
    await evictDurableObject(registry);
    expect((await registry.getTenant('cached'))?.name).toBe('Cached tenant');
    expect((await registry.getRuntime('cached'))?.botToken).toBe('');
  });

  it('updates authoritative runtime immediately and enforces optimistic versions', async () => {
    const first = await registry.createTenant({id: 'versioned', name: 'Versioned'});
    const disabled = await registry.updateTenant('versioned', {enabled: false, expectedVersion: first.tenant.version});
    expect((await registry.getRuntime('versioned'))?.enabled).toBe(false);
    await expect(reject(() => registry.updateTenant('versioned', {
      name: 'Stale name',
      expectedVersion: first.tenant.version
    }))).rejects.toThrow('STALE_TENANT:');
    await registry.updateTenant('versioned', {enabled: true, expectedVersion: disabled.version});
    expect((await registry.getRuntime('versioned'))?.enabled).toBe(true);
  });

  it('validates IDs/limits and allows only one winner when creates race', async () => {
    for (const input of [
      {id: 'default', name: 'Reserved'}, {id: '../bad', name: 'Bad'},
      {id: 'blank', name: ' '}, {id: 'limit', name: 'Limit', limits: {maxSubscribers: 0}},
      {id: 'limit', name: 'Limit', limits: {requestsPerMinute: 10_001}},
      {id: 'limit', name: 'Limit', limits: {notificationsPerDay: 1.5}},
    ]) await expect(reject(() => registry.createTenant(input))).rejects.toThrow();
    const results = await Promise.allSettled([
      reject(() => registry.createTenant({id: 'same-id', name: 'First'})),
      reject(() => registry.createTenant({id: 'same-id', name: 'Second'})),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await registry.listTenants()).filter(tenant => tenant.id === 'same-id')).toHaveLength(1);
  });
});

describe('tenant bot ownership and status', () => {
  it('keeps the prior bot configuration after safely classifying validation failures', async () => {
    const token = '910010:previous-fixture-token';
    const replacement = '910010:replacement-fixture-token';
    const privateDetail = `https://api.telegram.org/bot${replacement}/getMe private-upstream-diagnostic`;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(bot(910010)));
    await registry.configureBot('default', token);
    const original = await registry.getRuntime('default');
    const cases: Array<{ code: string; response?: () => Response; error?: Error }> = [
      {
        code: 'INVALID_BOT_TOKEN',
        response: () => new Response(JSON.stringify({
          ok: false,
          error_code: 401,
          description: privateDetail
        }), {status: 401})
      },
      {code: 'INVALID_BOT_TOKEN', response: () => response({id: 910011, is_bot: true})},
      {code: 'INVALID_BOT_TOKEN', response: () => response({id: 910010, is_bot: false})},
      {code: 'TELEGRAM_NETWORK_ERROR', error: new TypeError(privateDetail)},
      {code: 'TELEGRAM_TIMEOUT', error: new TelegramError('Safe timeout.', 0, true, undefined, 'timeout')},
      {code: 'TELEGRAM_INVALID_RESPONSE', response: () => new Response(privateDetail)},
      {code: 'TELEGRAM_INVALID_RESPONSE', response: () => new Response(JSON.stringify({ok: true}))},
      {
        code: 'TELEGRAM_INVALID_RESPONSE',
        response: () => new Response(privateDetail, {
          status: 302,
          headers: {Location: `https://other.example/${replacement}`}
        })
      },
      {code: 'TELEGRAM_UPSTREAM_ERROR', response: () => new Response(privateDetail, {status: 502})},
      {
        code: 'TELEGRAM_RATE_LIMITED',
        response: () => new Response(JSON.stringify({
          ok: false,
          error_code: 429,
          description: privateDetail,
          parameters: {retry_after: 30}
        }), {status: 429})
      },
      {
        code: 'TELEGRAM_UNAVAILABLE',
        response: () => new Response(JSON.stringify({
          ok: false,
          error_code: 404,
          description: privateDetail
        }), {status: 404})
      },
    ];
    for (const scenario of cases) {
      fetcher.mockImplementation(async () => {
        if (scenario.error) throw scenario.error;
        return scenario.response!();
      });
      let caught: unknown;
      try {
        await registry.configureBot('default', replacement);
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain(`${scenario.code}:`);
      expect(String(caught)).not.toContain(replacement);
      expect(String(caught)).not.toContain('private-upstream-diagnostic');
      expect(await registry.getRuntime('default')).toEqual(original);
    }
    expect(fetcher).toHaveBeenCalledTimes(cases.length + 1);
  });

  it('validates stored identity, preserves webhook secrets on rotation, and retains default bot configuration after eviction', async () => {
    await registry.createTenant({id: 'bot-owner', name: 'Owner'});
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(bot(910001)));
    const configured = await registry.configureBot('bot-owner', '910001:first-token');
    expect(configured.botId).toBe('910001');
    expect(JSON.stringify(configured)).not.toContain('first-token');
    const runtime = (await registry.getRuntime('bot-owner'))!;
    expect(runtime.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    await registry.configureBot('bot-owner', '910001:second-token', configured.version);
    expect((await registry.getRuntime('bot-owner'))?.webhookSecret).toBe(runtime.webhookSecret);
    fetcher.mockImplementation(async () => response(bot(123456)));
    await registry.configureBot('default', '123456:default-saved-token');
    expect(fetcher).toHaveBeenCalledTimes(3);
    const defaultRuntime = await registry.getRuntime('default');
    await evictDurableObject(registry);
    expect((await registry.getRuntime('default'))?.botToken).toBe('123456:default-saved-token');
    expect((await registry.getRuntime('default'))?.webhookSecret).toBe(defaultRuntime?.webhookSecret);
    expect((await registry.getRuntime('bot-owner'))?.botToken).toBe('910001:second-token');
    await expect(reject(() => registry.configureBot('bot-owner', '910002:other-token'))).rejects.toThrow('BOT_CHANGE_REQUIRES_NEW_TENANT:');
    await registry.createTenant({id: 'other-owner', name: 'Other'});
    await expect(reject(() => registry.configureBot('other-owner', '910001:second-token'))).rejects.toThrow('BOT_ALREADY_ASSIGNED:');
    await expect(reject(() => registry.configureBot('other-owner', '123456:default-saved-token'))).rejects.toThrow('BOT_ALREADY_ASSIGNED:');
  });

  it('rechecks bot ownership when two independent getMe requests race', async () => {
    await registry.createTenant({id: 'owner-one', name: 'One'});
    await registry.createTenant({id: 'owner-two', name: 'Two'});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(bot(910003)));
    const results = await Promise.allSettled([
      reject(() => registry.configureBot('owner-one', '910003:shared-token')),
      reject(() => registry.configureBot('owner-two', '910003:shared-token')),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(failure.reason)).toContain('BOT_ALREADY_ASSIGNED:');
  });

  it('rejects a stale bot configuration after a concurrent tenant update', async () => {
    await registry.createTenant({id: 'concurrent', name: 'Before'});
    await runInDurableObject(registry, async instance => {
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>(resolve => {
        started = resolve;
      });
      const complete = new Promise<void>(resolve => {
        release = resolve;
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        started();
        await complete;
        return response(bot(910004));
      });
      const pending = instance.configureBot('concurrent', '910004:pending-token', 1);
      await entered;
      await instance.updateTenant('concurrent', {name: 'After', expectedVersion: 1});
      release();
      await expect(pending).rejects.toThrow('STALE_TENANT:');
    });
    const tenant = await registry.getTenant('concurrent');
    expect(tenant?.name).toBe('After');
    expect(tenant?.botConfigured).toBe(false);
  });

  it('caches status for 60 seconds, coalesces refreshes, and invalidates after mutation', async () => {
    await registry.createTenant({id: 'status-cache', name: 'Status'});
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => String(request).endsWith('/getMe') ? response(bot(910005)) : response({
      url: 'https://relay.test/telegram/status-cache/webhook',
      pending_update_count: 0
    }));
    await registry.configureBot('status-cache', '910005:status-token');
    fetcher.mockClear();
    const first = await registry.getBotStatus('status-cache') as BotStatus;
    const second = await registry.getBotStatus('status-cache') as BotStatus;
    expect(first.bot?.id).toBe(910005);
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await runInDurableObject(registry, async instance => {
      await Promise.all([instance.getBotStatus('status-cache', true), instance.getBotStatus('status-cache', true), instance.getBotStatus('status-cache', true)]);
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    await registry.updateTenant('status-cache', {name: 'New status name'});
    await registry.getBotStatus('status-cache');
    expect(fetcher).toHaveBeenCalledTimes(6);
    const future = Date.now() + 60_001;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    await registry.getBotStatus('status-cache');
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it('registers only enabled tenant webhook paths and redacts network errors', async () => {
    await registry.createTenant({id: 'webhook', name: 'Webhook'});
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(bot(910006)));
    await registry.configureBot('webhook', '910006:secret-token');
    fetcher.mockImplementation(async () => response(true));
    expect(await registry.registerWebhook('webhook', 'https://relay.test/telegram/webhook/webhook')).toEqual({
      ok: true,
      url: 'https://relay.test/telegram/webhook/webhook'
    });
    const payload = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
    expect(payload.allowed_updates).toContain('callback_query');
    expect(payload.drop_pending_updates).toBe(false);
    expect(payload.secret_token).toBe((await registry.getRuntime('webhook'))?.webhookSecret);
    await expect(reject(() => registry.registerWebhook('webhook', 'https://relay.test/telegram/other/webhook'))).rejects.toThrow('INVALID_TENANT:');
    await registry.updateTenant('webhook', {enabled: false});
    await expect(reject(() => registry.registerWebhook('webhook', 'https://relay.test/telegram/webhook/webhook'))).rejects.toThrow('TENANT_DISABLED:');
    await registry.updateTenant('webhook', {enabled: true});
    fetcher.mockRejectedValue(new Error('Fetch failed for /bot910006:secret-token/'));
    const status = await registry.getBotStatus('webhook', true) as BotStatus;
    expect(status.telegramError).toBeTruthy();
    expect(JSON.stringify(status)).not.toContain('910006:secret-token');
    await expect(reject(() => registry.registerWebhook('webhook', 'https://relay.test/telegram/webhook/webhook'))).rejects.toThrow('TELEGRAM_UNAVAILABLE:');
    expect((await registry.getTenant('webhook'))?.enabled).toBe(true);
  });
});
