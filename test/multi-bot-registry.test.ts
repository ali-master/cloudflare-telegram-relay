import {env} from 'cloudflare:workers';
import {evictDurableObject, reset, runInDurableObject} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BotStatus, Env, TenantUsage} from '../src/types';
import {hubName} from '../src/types';
import {BotStore} from '../src/bots';
const bindings = env as unknown as Env;
const registry = () => bindings.TENANTS.getByName('registry');
const rejected = (fn: () => PromiseLike<unknown>) => (async () => await fn())();
const usage = (notificationsToday = 0, activeSubscribers = 0, pendingDeliveries = 0): TenantUsage => ({day: new Date().toISOString().slice(0,10), notificationsToday, activeSubscribers, pendingDeliveries});
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const match = /bot(\d+):.*\/(\w+)$/.exec(String(request));
    const result = match?.[2] === 'getMe' ? {id: Number(match[1]), is_bot: true, username: `bot_${match[1]}`} : match?.[2] === 'setWebhook' ? true : {url: '', pending_update_count: 0};
    return new Response(JSON.stringify({ok: true, result}), {headers: {'content-type':'application/json'}});
  });
});
afterEach(async () => {vi.restoreAllMocks(); await reset();});

describe('multi-bot registry', () => {
  it('migrates default credentials once without overwriting bot edits or changing legacy hub identity', async () => {
    const stub = registry();
    await stub.getTenant('default');
    await runInDurableObject(stub, (_,state)=> {
      const row=state.storage.sql.exec<{body:string}>("SELECT body FROM tenants WHERE id='default'").one();
      const old=JSON.parse(row.body);
      state.storage.sql.exec("UPDATE tenants SET body=? WHERE id='default'",JSON.stringify({...old,botToken:'710001:legacy-token',botId:'710001',botUsername:'legacy_bot'}));
      state.storage.sql.exec("DELETE FROM tenant_bots WHERE tenant_id='default' AND id='default'");
    });
    await evictDurableObject(stub);
    const legacy=(await stub.getTenant('default'))!;
    const before = (await stub.getRuntime('default'))!;
    expect(hubName('default')).toBe('primary');
    expect(hubName('tenant-aa')).toBe('tenant:tenant-aa');
    expect(hubName('default','alerts')).toBe('tenant:default:bot:alerts');
    expect((await stub.getBot('default','default'))).toMatchObject({telegramId: '710001', configured: true, enabled: true});
    await stub.updateBot('default','default',{enabled:false,name:'Renamed default'});
    await evictDurableObject(stub);
    const restored = (await stub.getRuntime('default'))!;
    expect(restored).toMatchObject({selectedBotId:'default',botEnabled:false,botToken: before.botToken,webhookSecret:before.webhookSecret});
    expect((await stub.getBot('default','default'))?.name).toBe('Renamed default');
    expect((await stub.getTenant('default'))!.version).toBeGreaterThan(legacy.version);
  });

  it('isolates bot runtime/application lists and keeps disabled bot keys authenticatable with clear state', async () => {
    const stub = registry();
    const {bot:created} = await stub.createBot('default',{id:'alerts',name:'Alerts',botToken:'710002:alerts-token'});
    const legacyApp = await stub.createApplication('default',{id:'legacy-app',name:'Legacy'});
    const app = await stub.createApplication('default',{id:'monitoring',name:'Monitoring',botId:'alerts'});
    expect(app.application.botId).toBe('alerts');
    expect(legacyApp.application.botId).toBe('default');
    expect((await stub.getRuntime('default'))!.applications!.map(row=>row.id)).toEqual(['legacy-app']);
    const runtime = (await stub.getRuntime('default',undefined,'alerts'))!;
    expect(runtime).toMatchObject({selectedBotId:'alerts',botId:'710002',botEnabled:true});
    expect(runtime.applications!.map(row=>row.id)).toEqual(['monitoring']);
    expect((await stub.getRuntime('default',runtime.applicationRevision,'alerts'))!.applications).toBeUndefined();
    await stub.updateBot('default','alerts',{enabled:false,expectedVersion:created.version});
    expect(await stub.verifyApplicationKey('default',app.apiKey)).toMatchObject({id:'monitoring',botId:'alerts'});
    expect((await stub.getRuntime('default',undefined,'alerts'))!.botEnabled).toBe(false);
    expect((await stub.listBots('default')).items.find(bot=>bot.id==='alerts')?.applicationCount).toBe(1);
    const publicData=JSON.stringify(await stub.listBots('default'));
    expect(publicData).not.toContain('alerts-token');
    expect(publicData).not.toContain('webhookSecret');
    await evictDurableObject(stub);
    expect((await stub.getRuntime('default',undefined,'alerts'))!.botEnabled).toBe(false);
    await expect(rejected(()=>stub.updateApplication('default','monitoring',{botId:'default'}))).rejects.toThrow('APPLICATION_BOT_IMMUTABLE:');
    await expect(rejected(()=>stub.createApplication('default',{id:'bad-app',name:'Bad',botId:'missing'}))).rejects.toThrow('BOT_NOT_FOUND:');
  });

  it('rejects reused identity, identity swaps, stale edits and racing bot claims', async () => {
    const stub = registry();
    await stub.createTenant({id:'other-tenant',name:'Other'});
    const results=await Promise.allSettled([
      rejected(()=>stub.createBot('default',{id:'first',name:'First',botToken:'710003:shared-token'})),
      rejected(()=>stub.createBot('other-tenant',{id:'second',name:'Second',botToken:'710003:shared-token'}))
    ]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(String((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason)).toContain('BOT_ALREADY_ASSIGNED');
    const {bot}=await stub.createBot('default',{id:'versioned',name:'Versioned',botToken:'710004:first-token'});
    const original=(await stub.getRuntime('default',undefined,bot.id))!;
    const changed=await stub.updateBot('default',bot.id,{botToken:'710004:rotated-token',expectedVersion:bot.version});
    expect((await stub.getRuntime('default',undefined,bot.id))!.webhookSecret).toBe(original.webhookSecret);
    await expect(rejected(()=>stub.updateBot('default',bot.id,{enabled:false,expectedVersion:bot.version}))).rejects.toThrow('STALE_BOT:');
    await expect(rejected(()=>stub.updateBot('default',bot.id,{botToken:'710005:other-token'}))).rejects.toThrow('BOT_CHANGE_REQUIRES_NEW_BOT:');
    expect((await stub.getBot('default',bot.id))!.version).toBe(changed.version);
  });

  it('registers isolated webhooks and refuses disabled bots without making Telegram calls', async () => {
    const stub=registry();
    await stub.createBot('default',{id:'alerts',name:'Alerts',botToken:'710006:alerts-token'});
    const runtime=(await stub.getRuntime('default',undefined,'alerts'))!;
    await stub.registerWebhook('default','https://relay.test/telegram/default/bots/alerts/webhook','alerts');
    const fetcher=vi.mocked(globalThis.fetch);
    const payload=JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body));
    expect(payload.secret_token).toBe(runtime.webhookSecret);
    await expect(rejected(()=>stub.registerWebhook('default','https://relay.test/telegram/default/webhook','alerts'))).rejects.toThrow('INVALID_WEBHOOK:');
    await stub.updateBot('default','alerts',{enabled:false});
    fetcher.mockClear();
    await expect(rejected(()=>stub.registerWebhook('default','https://relay.test/telegram/default/bots/alerts/webhook','alerts'))).rejects.toThrow('BOT_DISABLED:');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('paginates beyond 100 bots, bounds credential cache, and persists cold bot entries', async () => {
    const stub=registry();
    await runInDurableObject(stub,(_,state)=>{
      const store=new BotStore(state.storage.sql), date=new Date().toISOString();
      for(let i=0;i<300;i++)store.put({tenantId:'default',id:`bot-${String(i).padStart(3,'0')}`,name:`Bot ${i}`,enabled:true,telegramId:String(720000+i),username:null,botToken:`${720000+i}:fixture`,webhookSecret:null,version:1,createdAt:date,updatedAt:date});
      expect((store as unknown as {cache:Map<string,unknown>}).cache.size).toBe(256);
      expect(store.get('default','bot-000')?.telegramId).toBe('720000');
    });
    const first=await stub.listBots('default',1), last=await stub.listBots('default',16);
    expect(first.total).toBe(301); expect(first.items).toHaveLength(20); expect(first.items[0].id).toBe('default');
    expect(last.items).toHaveLength(1); expect((await stub.listBots('default',1,'bot-29')).total).toBe(10);
    await evictDurableObject(stub);
    expect((await stub.getBot('default','bot-000'))?.telegramId).toBe('720000');
  });

  it('keeps per-bot credential and status reads cached and invalidates the selected application status', async()=>{
    const stub=registry();
    await stub.createBot('default',{id:'alerts',name:'Alerts',botToken:'710010:alerts-token'});
    await stub.getRuntime('default',undefined,'alerts');
    await runInDurableObject(stub,async(instance,state)=>{
      const sql=vi.spyOn(state.storage.sql,'exec');
      try {
        for(let i=0;i<5;i++) await instance.getRuntime('default',undefined,'alerts');
        expect(sql).not.toHaveBeenCalled();
      } finally {sql.mockRestore();}
    });
    const initial=await stub.getBotStatus('default',false,'alerts') as BotStatus;
    expect(initial.configured.apiKey).toBe(false);
    await stub.createApplication('default',{id:'cached-status',name:'Cached status',botId:'alerts'});
    expect((await stub.getBotStatus('default',false,'alerts') as BotStatus).configured.apiKey).toBe(true);
  });

  it('continues tenant-wide wake invalidation in bounded durable pages',async()=>{
    const stub=registry();
    await runInDurableObject(stub,(_,state)=>{
      const store=new BotStore(state.storage.sql), now=new Date().toISOString();
      for(let i=0;i<12;i++)store.put({tenantId:'default',id:`wake-${i}`,name:'Wake',enabled:true,telegramId:null,username:null,botToken:null,webhookSecret:null,version:1,createdAt:now,updatedAt:now});
    });
    await stub.updateTenant('default',{enabled:false});
    await runInDurableObject(stub,async(instance,state)=>{
      expect(state.storage.sql.exec('SELECT * FROM tenant_wake_jobs').toArray()).toHaveLength(1);
      await instance.alarm();
      expect(state.storage.sql.exec<{cursor:string}>('SELECT cursor FROM tenant_wake_jobs').one().cursor).not.toBe('');
      expect(await state.storage.getAlarm()).not.toBeNull();
      await instance.alarm(); await instance.alarm();
      expect(state.storage.sql.exec('SELECT * FROM tenant_wake_jobs').toArray()).toHaveLength(0);
    });
  });

  it('classifies new bot and webhook validation without generic tenant errors',async()=>{
    const stub=registry();
    for(const input of [null,{id:'../bad',name:'Invalid',botToken:'710011:fixture-token'}, {id:'alerts',name:'Alerts',botToken:'710011:fixture-token',unexpected:true}]) {
      await expect(rejected(()=>stub.createBot('default',input as never))).rejects.toThrow('INVALID_BOT:');
    }
    await stub.createBot('default',{id:'alerts',name:'Alerts',botToken:'710011:fixture-token'});
    for(const patch of [{name:' '},{expectedVersion:0},{unexpected:true}]) {
      await expect(rejected(()=>stub.updateBot('default','alerts',patch as never))).rejects.toThrow('INVALID_BOT:');
    }
    for(const url of ['not a url','http://relay.test/telegram/default/bots/alerts/webhook','https://relay.test/telegram/wrong/bots/alerts/webhook']) {
      await expect(rejected(()=>stub.registerWebhook('default',url,'alerts'))).rejects.toThrow('INVALID_WEBHOOK:');
    }
  });

  it('checks audience membership only inside the selected bot', async()=>{
    const stub=registry();
    await stub.createBot('default',{id:'alerts',name:'Alerts',botToken:'710007:alerts-token'});
    const legacy=bindings.HUB.getByName(hubName('default'));
    await runInDurableObject(legacy,(_,state)=>state.storage.sql.exec("INSERT INTO subscribers(chat_id,first_name,joined_at,updated_at) VALUES('11','Legacy member',1,1)"));
    await expect(rejected(()=>stub.createApplication('default',{id:'isolated',name:'Isolated',botId:'alerts',audienceMode:'selected',audienceChatIds:['11']}))).rejects.toThrow('INVALID_APPLICATION:');
    const alertHub=bindings.HUB.getByName(hubName('default','alerts'));
    await runInDurableObject(alertHub,(_,state)=>state.storage.sql.exec("INSERT INTO subscribers(chat_id,first_name,joined_at,updated_at) VALUES('22','Alerts member',1,1)"));
    expect((await stub.createApplication('default',{id:'isolated',name:'Isolated',botId:'alerts',audienceMode:'selected',audienceChatIds:['22']})).application.audienceChatIds).toEqual(['22']);
  });
});

describe('shared tenant quota ledger',()=>{
  it('bootstraps legacy usage before any quota reservation or additional bot exists',async()=>{
    const stub=registry();
    await stub.getTenant('default');
    const hub=bindings.HUB.getByName(hubName('default'));
    await hub.initializeTenant('default','Legacy');
    const day=new Date(Date.now()).toISOString().slice(0,10);
    await runInDurableObject(hub,(_,state)=>{
      state.storage.sql.exec('INSERT INTO daily_usage(day,notifications) VALUES(?,7) ON CONFLICT(day) DO UPDATE SET notifications=7',day);
      state.storage.sql.exec("INSERT INTO subscribers(chat_id,first_name,joined_at,updated_at) VALUES('81','Existing member',1,1)");
    });
    expect(await stub.getTenantUsage('default')).toEqual({day,notificationsToday:7,activeSubscribers:1,pendingDeliveries:0});
    expect((await stub.listBots('default')).total).toBe(1);
    await evictDurableObject(stub);
    expect(await stub.getTenantUsage('default')).toEqual({day,notificationsToday:7,activeSubscribers:1,pendingDeliveries:0});
  });

  it('grants pending capacity across bots, prevents daily/subscriber multiplication and ignores stale reports',async()=>{
    const stub=bindings.TENANTS.getByName(`quota-${crypto.randomUUID()}`);
    await stub.createBot('default',{id:'alerts',name:'Alerts',botToken:'710008:alerts-token'});
    await stub.updateTenant('default',{limits:{notificationsPerDay:2,maxSubscribers:2,maxPendingDeliveries:3}});
    expect(await stub.reserveQuota('default','default',100,usage(),{notifications:1,subscribers:1,pending:2})).toEqual({maxPendingDeliveries:2});
    expect(await stub.reserveQuota('default','alerts',100,usage(),{notifications:1,subscribers:1,pending:2})).toEqual({maxPendingDeliveries:1});
    await stub.reportQuotaUsage('default','default',99,usage());
    expect(await stub.getTenantUsage('default')).toMatchObject({notificationsToday:2,activeSubscribers:2,pendingDeliveries:3});
    await stub.reportQuotaUsage('default','default',101,usage(1,1,0));
    expect(await stub.reserveQuota('default','alerts',102,usage(1,1,1),{notifications:0,subscribers:0,pending:5})).toEqual({maxPendingDeliveries:3});
    await evictDurableObject(stub);
    expect(await stub.getTenantUsage('default')).toMatchObject({notificationsToday:2,activeSubscribers:2,pendingDeliveries:3});
    await expect(rejected(()=>stub.reserveQuota('default','alerts',103,usage(1,1,1),{notifications:1,subscribers:0,pending:0}))).rejects.toThrow('TENANT_DAILY_LIMIT:');
    await expect(rejected(()=>stub.reserveQuota('default','alerts',104,usage(1,1,1),{notifications:0,subscribers:1,pending:0}))).rejects.toThrow('SUBSCRIBER_LIMIT:');
    await expect(rejected(()=>stub.reserveQuota('default','alerts',102,usage(),{notifications:0,subscribers:0,pending:0}))).rejects.toThrow('STALE_QUOTA:');
  });

  it('allows opt-outs/reconciliation after disable but rejects growth and releases nothing on eviction',async()=>{
    const stub=bindings.TENANTS.getByName(`quota-${crypto.randomUUID()}`);
    await stub.createBot('default',{id:'alerts',name:'Alerts',botToken:'710009:alerts-token'});
    await stub.reserveQuota('default','alerts',100,usage(),{notifications:1,subscribers:1,pending:2});
    await stub.updateBot('default','alerts',{enabled:false});
    expect(await stub.reserveQuota('default','alerts',101,usage(1,1,2),{notifications:0,subscribers:0,pending:4})).toEqual({maxPendingDeliveries:2});
    await stub.reportQuotaUsage('default','alerts',102,usage(1,0,2));
    await evictDurableObject(stub);
    expect(await stub.getTenantUsage('default')).toMatchObject({notificationsToday:1,activeSubscribers:0,pendingDeliveries:2});
    await expect(rejected(()=>stub.reserveQuota('default','alerts',101,usage(1,1,2),{notifications:1,subscribers:0,pending:0}))).rejects.toThrow('BOT_DISABLED:');
  });
});
