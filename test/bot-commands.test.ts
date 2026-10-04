import {env} from 'cloudflare:workers';
import {reset, runInDurableObject} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Env} from '../src/types';
import {parseBotCommand, TELEGRAM_BOT_COMMANDS} from '../src/bot-commands';

const bindings = env as unknown as Env;
const registry = () => bindings.TENANTS.getByName('registry');
const result = (value: unknown) => new Response(JSON.stringify({ok: true, result: value}), {headers: {'content-type': 'application/json'}});
const reject = (fn: () => PromiseLike<unknown>) => (async () => await fn())();
const method = (request: RequestInfo | URL) => String(request).split('/').at(-1)!;
const success = async (request: RequestInfo | URL) => result(method(request) === 'getMe'
  ? {id: Number(/bot(\d+):/.exec(String(request))?.[1]), is_bot: true, username: 'command_fixture'} : true);
const calls = () => vi.mocked(globalThis.fetch).mock.calls.map(([url, options]) => ({url: String(url), method: method(url), payload: JSON.parse(String(options?.body))}));

beforeEach(() => {vi.spyOn(globalThis, 'fetch').mockImplementation(success);});
afterEach(async () => {vi.restoreAllMocks(); await reset();});

describe('Telegram command catalog', () => {
  it('advertises every implemented action with valid names and useful argument examples', () => {
    expect(TELEGRAM_BOT_COMMANDS.map(item => item.command).sort()).toEqual(['all', 'apps', 'preferences', 'quiet', 'start', 'stop', 'timezone']);
    for (const item of TELEGRAM_BOT_COMMANDS) {
      expect(item.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.description.length).toBeLessThanOrEqual(256);
      expect(parseBotCommand(`/${item.command}`)).toEqual({command: item.command, argument: ''});
    }
    expect(TELEGRAM_BOT_COMMANDS.find(item => item.command === 'timezone')?.description).toContain('/timezone Asia/Tehran');
    expect(TELEGRAM_BOT_COMMANDS.find(item => item.command === 'quiet')?.description).toContain('/quiet 22:00 08:00');
  });

  it('preserves case-sensitive dispatch, command mentions and whitespace-normalized arguments', () => {
    expect(parseBotCommand('/quiet@Relay_bot 22:00\n 08:00 ')).toEqual({command: 'quiet', argument: '22:00 08:00'});
    expect(parseBotCommand('/timezone Asia/Tehran')).toEqual({command: 'timezone', argument: 'Asia/Tehran'});
    for (const value of ['/help', '/START', '/start-more', '/apps_extra', '/start@', ' /start', '/quietly']) expect(parseBotCommand(value)).toBeNull();
  });
});

describe('per-bot Telegram command synchronization', () => {
  it('registers the complete private-chat catalog for fallback and Persian clients, then enables the menu', async () => {
    const stub = registry();
    await stub.createBot('default', {id: 'alerts', name: 'Alerts', botToken: '740001:fixture-token'});
    expect(calls().map(call => call.method)).toEqual(['getMe', 'setMyCommands', 'setMyCommands', 'setChatMenuButton']);
    expect(calls().slice(1).map(call => call.payload)).toEqual([
      {commands: TELEGRAM_BOT_COMMANDS, scope: {type: 'all_private_chats'}, language_code: ''},
      {commands: TELEGRAM_BOT_COMMANDS, scope: {type: 'all_private_chats'}, language_code: 'fa'},
      {menu_button: {type: 'commands'}},
    ]);
    expect(calls().every(call => call.url.includes('/bot740001:fixture-token/'))).toBe(true);
  });

  it('syncs token rotations but skips renames, enabled-state edits and runtime reads', async () => {
    const stub = registry();
    const {bot} = await stub.createBot('default', {id: 'alerts', name: 'Alerts', botToken: '740002:initial-token'});
    vi.mocked(globalThis.fetch).mockClear();
    const renamed = await stub.updateBot('default', bot.id, {name: 'Renamed', enabled: false});
    await stub.getRuntime('default', undefined, bot.id);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await stub.updateBot('default', bot.id, {botToken: '740002:rotated-token', expectedVersion: renamed.version});
    expect(calls()).toHaveLength(4);
    expect(calls().every(call => call.url.includes('/bot740002:rotated-token/'))).toBe(true);
    expect((await stub.getBot('default', bot.id))?.enabled).toBe(false);
  });

  it('covers legacy token configuration and webhook registration without emitting chat messages', async () => {
    const stub = registry();
    await stub.configureBot('default', '740003:legacy-token');
    expect(calls().map(call => call.method)).toEqual(['getMe', 'setMyCommands', 'setMyCommands', 'setChatMenuButton']);
    vi.mocked(globalThis.fetch).mockClear();
    await stub.registerWebhook('default', 'https://relay.test/telegram/default/webhook');
    expect(calls().map(call => call.method)).toEqual(['setMyCommands', 'setMyCommands', 'setChatMenuButton', 'setWebhook']);
  });

  it('syncs only the selected bot even when it or its tenant is disabled', async () => {
    const stub = registry();
    await stub.configureBot('default', '740004:default-token');
    await stub.createTenant({id: 'second-tenant', name: 'Second'});
    await stub.createBot('second-tenant', {id: 'alerts', name: 'Alerts', botToken: '740005:second-token', enabled: false});
    await stub.updateTenant('second-tenant', {enabled: false});
    vi.mocked(globalThis.fetch).mockClear();
    const reply = await stub.registerBotCommands('second-tenant', 'alerts');
    expect(reply).toEqual({ok: true, commands: TELEGRAM_BOT_COMMANDS});
    expect(calls()).toHaveLength(3);
    expect(calls().every(call => call.url.includes('/bot740005:second-token/'))).toBe(true);
    expect(JSON.stringify(reply)).not.toContain('second-token');
    await expect(reject(() => stub.registerBotCommands('default', 'alerts'))).rejects.toThrow('BOT_NOT_FOUND:');
  });

  it('requires a configured bot and validates identity before registering commands', async () => {
    const stub = registry();
    await expect(reject(() => stub.registerBotCommands('default'))).rejects.toThrow('BOT_NOT_CONFIGURED:');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.mocked(globalThis.fetch).mockImplementation(async () => result({id: 99, is_bot: true}));
    await expect(reject(() => stub.createBot('default', {id: 'bad-bot', name: 'Bad', botToken: '740006:wrong-identity'}))).rejects.toThrow('INVALID_BOT_TOKEN:');
    expect(calls().map(call => call.method)).toEqual(['getMe']);
  });

  it.each([1, 2, 3])('does not persist new credentials when command/menu confirmation %i fails', async failureIndex => {
    const stub = registry();
    let index = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async request => method(request) === 'getMe' ? success(request) : result(++index !== failureIndex));
    await expect(reject(() => stub.createBot('default', {id: 'failed-bot', name: 'Failed', botToken: '740007:failed-token'}))).rejects.toThrow('TELEGRAM_COMMANDS_SYNC_FAILED:');
    expect(await stub.getBot('default', 'failed-bot')).toBeNull();
    index = 0;
    await expect(reject(() => stub.configureBot('default', '740007:failed-token'))).rejects.toThrow('TELEGRAM_COMMANDS_SYNC_FAILED:');
    expect((await stub.getRuntime('default'))?.botToken).toBe('');
  });

  it('preserves saved tokens and redacts upstream details when sync fails', async () => {
    const stub = registry();
    const {bot} = await stub.createBot('default', {id: 'alerts', name: 'Alerts', botToken: '740008:old-token'});
    vi.mocked(globalThis.fetch).mockImplementation(async request => {
      if (method(request) === 'getMe') return success(request);
      throw new Error('https://api.telegram.org/bot740008:new-token/setMyCommands sensitive diagnostic');
    });
    let error: unknown;
    try {await stub.updateBot('default', bot.id, {botToken: '740008:new-token', name: 'Unsaved'});} catch (caught) {error = caught;}
    expect(String(error)).toContain('TELEGRAM_COMMANDS_SYNC_FAILED:');
    expect(String(error)).not.toMatch(/new-token|sensitive diagnostic/);
    expect(await stub.getBot('default', bot.id)).toEqual(bot);
    expect((await stub.getRuntime('default', undefined, bot.id))?.botToken).toBe('740008:old-token');
    await expect(reject(() => stub.registerBotCommands('default', bot.id))).rejects.toThrow('TELEGRAM_COMMANDS_SYNC_FAILED:');
    vi.mocked(globalThis.fetch).mockClear();
    await expect(reject(() => stub.registerWebhook('default', 'https://relay.test/telegram/default/bots/alerts/webhook', bot.id))).rejects.toThrow('TELEGRAM_COMMANDS_SYNC_FAILED:');
    expect(calls().map(call => call.method)).toEqual(['setMyCommands']);
    expect(await stub.getBot('default', bot.id)).toEqual(bot);
  });

  it('rejects stale sync and rotation completion after another bot edit', async () => {
    const stub = registry();
    await stub.createBot('default', {id: 'alerts', name: 'Before', botToken: '740009:old-token'});
    await runInDurableObject(stub, async instance => {
      for (const manual of [false, true]) {
        let release!: () => void, started!: () => void;
        const entered = new Promise<void>(resolve => {started = resolve;});
        const finish = new Promise<void>(resolve => {release = resolve;});
        vi.mocked(globalThis.fetch).mockImplementation(async request => {
          if (method(request) === 'setMyCommands') {started(); await finish;}
          return success(request);
        });
        const pending = manual ? instance.registerBotCommands('default', 'alerts')
          : instance.updateBot('default', 'alerts', {botToken: '740009:new-token'});
        await entered;
        await instance.updateBot('default', 'alerts', {name: manual ? 'After manual' : 'After rotation'});
        release();
        await expect(pending).rejects.toThrow('STALE_BOT:');
      }
    });
    expect((await stub.getRuntime('default', undefined, 'alerts'))?.botToken).toBe('740009:old-token');
    expect((await stub.getBot('default', 'alerts'))?.name).toBe('After manual');
  });

  it('does not report a successful manual sync for a token rotated while Telegram was responding', async () => {
    const stub = registry();
    await stub.createBot('default', {id: 'alerts', name: 'Alerts', botToken: '740010:old-token'});
    await runInDurableObject(stub, async instance => {
      let release!: () => void, started!: () => void;
      const entered = new Promise<void>(resolve => {started = resolve;});
      const finish = new Promise<void>(resolve => {release = resolve;});
      vi.mocked(globalThis.fetch).mockImplementation(async request => {
        if (String(request).includes('old-token') && method(request) === 'setMyCommands') {started(); await finish;}
        return success(request);
      });
      const pending = instance.registerBotCommands('default', 'alerts');
      await entered;
      await instance.updateBot('default', 'alerts', {botToken: '740010:rotated-token'});
      release();
      await expect(pending).rejects.toThrow('STALE_BOT:');
    });
    expect((await stub.getRuntime('default', undefined, 'alerts'))?.botToken).toBe('740010:rotated-token');
  });

  it('rechecks the legacy tenant version after command synchronization before saving a token', async () => {
    const stub = registry();
    await runInDurableObject(stub, async instance => {
      let release!: () => void, started!: () => void;
      const entered = new Promise<void>(resolve => {started = resolve;});
      const finish = new Promise<void>(resolve => {release = resolve;});
      vi.mocked(globalThis.fetch).mockImplementation(async request => {
        if (method(request) === 'setMyCommands') {started(); await finish;}
        return success(request);
      });
      const pending = instance.configureBot('default', '740011:pending-token');
      await entered;
      await instance.updateTenant('default', {name: 'Changed during sync'});
      release();
      await expect(pending).rejects.toThrow('STALE_TENANT:');
    });
    expect((await stub.getRuntime('default'))?.botToken).toBe('');
  });
});
