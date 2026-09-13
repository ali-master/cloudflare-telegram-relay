import {env} from 'cloudflare:workers';
import {evictDurableObject, runDurableObjectAlarm, runInDurableObject} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {NotificationHub} from '../src/hub';
import {hubName, type Env, type NotificationInput} from '../src/types';
import type {AutomationPolicy, SubscriberPreferences} from '../src/automation';

const bindings = env as unknown as Env;
let hub: DurableObjectStub<NotificationHub>;
let now: number;
let updateId: number;
let tenantId: string;
const source = {ip:'203.0.113.10',country:'DE',source:'api'};
const input: NotificationInput = {applicationId:'payments',application:'Payments',event:'service.firing',level:'error',environment:'production',timestamp:'2026-09-13T10:00:00.000Z',text:'Health check failed',fingerprint:'service-42'};
async function subscribe(id:number,text='/start') {await hub.handleUpdate({update_id:++updateId,message:{chat:{id,type:'private'},from:{id,first_name:`User ${id}`},text}});}
async function policy(patch: Partial<AutomationPolicy>) {const current=await hub.getAutomationPolicy();const {version,...body}=current.policy;return hub.updateAutomationPolicy(null,{...body,...patch,expectedVersion:version});}
async function preferences(id:string,patch:Partial<SubscriberPreferences>) {const {version,...body}=await hub.getSubscriberPreferences(id);return hub.updateSubscriberPreferences(id,{...body,...patch,expectedVersion:version});}
async function tick(ms=1001) {now+=ms;await runDurableObjectAlarm(hub);}
async function resume() {await hub.updateSettings({...await hub.getSettings(),paused:false});}
function network() {let receipt=100;return vi.spyOn(globalThis,'fetch').mockImplementation(async () => new Response(JSON.stringify({ok:true,result:{message_id:++receipt}})));}
async function deliveries() {return runInDurableObject(hub,(_,state)=>state.storage.sql.exec('SELECT * FROM deliveries ORDER BY id').toArray());}

beforeEach(async()=>{
  now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
  tenantId=`auto-${crypto.randomUUID().slice(0,8)}`;updateId=0;
  const registry=bindings.TENANTS.getByName('registry');
  await registry.createTenant({id:tenantId,name:'Automation tests'});
  const botId=Math.floor(Math.random()*100000000)+100000;
  const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({ok:true,result:{id:botId,is_bot:true,first_name:'Automation',username:'automation_bot'}})));
  await registry.configureBot(tenantId,`${botId}:automation-test-token`);mock.mockRestore();
  await registry.createApplication(tenantId,{id:'payments',name:'Payments'});
  await registry.createApplication(tenantId,{id:'deployments',name:'Deployments'});
  hub=bindings.HUB.getByName(hubName(tenantId));await hub.initializeTenant(tenantId);
  await hub.updateSettings({...await hub.getSettings(),paused:true,welcomeMessage:''});
});
afterEach(()=>vi.restoreAllMocks());

describe('durable incident automation',()=>{
  it('groups occurrences once per recipient, deduplicates retries, then edits the confirmed message after eviction',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:300}});
    const first=await hub.enqueue(input,source,'initial');
    const second=await hub.enqueue({...input,text:'Second failure'},source,'second');
    await hub.enqueue({...input,text:'Second failure'},source,'second');
    const incident=(await hub.listIncidents(1)).items[0];
    expect(incident.occurrences).toBe(2);expect((await deliveries()).length).toBe(1);
    expect(first.notification.incidentId).toBe(incident.id);expect(second.notification.incidentId).toBe(incident.id);
    const fetch=network();await resume();await tick();
    expect(String(fetch.mock.calls[0][0])).toContain('/sendRichMessage');
    const messageId=(await deliveries())[0].telegram_message_id;
    await evictDurableObject(hub);
    await hub.enqueue({...input,incidentStatus:'resolved',level:'success',text:'Recovered'},source,'resolved');
    await tick();
    expect(String(fetch.mock.calls[1][0])).toContain('/editMessageText');
    const payload=JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(payload.message_id).toBe(messageId);expect(JSON.stringify(payload.rich_message)).toContain('resolved');
    expect((await hub.getIncident(incident.id))?.incident).toMatchObject({status:'resolved',occurrences:3});
  });
  it('uses a fixed first-seen grouping window and application-scoped fingerprints',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:60}});
    await hub.enqueue(input,source);now+=50000;await hub.enqueue(input,source);
    await hub.enqueue({...input,applicationId:'deployments',application:'Deployments'},source);
    now+=11000;await hub.enqueue(input,source);
    expect((await hub.listIncidents(1)).items.map(i=>i.occurrences).sort()).toEqual([1,1,2]);
  });
  it('allows an owning authorized responder callback and rejects forged, foreign, and banned actors',async()=>{
    await subscribe(1);await subscribe(2);await policy({grouping:{enabled:true,windowSeconds:300},responders:['1']});
    await hub.enqueue(input,source);const fetch=network();await resume();await tick();await tick();
    const incident=(await hub.listIncidents(1)).items[0];const receipt=(await deliveries()).find(r=>r.chat_id==='1')!.telegram_message_id;
    const callback=async(from:number,chat:number,messageId:number)=>hub.handleUpdate({update_id:++updateId,callback_query:{id:`cb-${updateId}`,from:{id:from},message:{message_id:messageId,chat:{id:chat,type:'private'}},data:`inc:ack:${incident.id}`}});
    await callback(2,1,Number(receipt));await callback(1,1,99999);await callback(2,2,Number(receipt));
    expect((await hub.getIncident(incident.id))?.incident.status).toBe('open');
    await callback(1,1,Number(receipt));
    expect((await hub.getIncident(incident.id))?.incident).toMatchObject({status:'acknowledged',assigneeChatId:'1'});
    expect((await hub.getIncident(incident.id))?.timeline.at(-1)).toMatchObject({actorChatId:'1',actorName:'User 1'});
    expect(fetch.mock.calls.some(c=>String(c[0]).endsWith('/answerCallbackQuery'))).toBe(true);
  });
  it('escalates in order through the queue, survives eviction, and stops on acknowledgement',async()=>{
    await subscribe(1);await subscribe(2);await policy({grouping:{enabled:true,windowSeconds:300},escalation:{enabled:true,afterMinutes:1,targetChatIds:['1','2']}});
    await hub.enqueue({...input,level:'critical'},source);const fetch=network();await resume();await tick();await tick();
    await evictDurableObject(hub);await tick(60001);
    const incident=(await hub.listIncidents(1)).items[0];expect(incident.escalationCount).toBe(1);
    expect(fetch.mock.calls.some(c=>String(c[1]?.body).includes('Escalation 1'))).toBe(true);
    await hub.actOnIncident(incident.id,{action:'acknowledge',expectedVersion:incident.version});await tick(60001);
    expect((await hub.getIncident(incident.id))?.incident.escalationCount).toBe(1);
  });
  it('snoozes durably, wakes, and restarts escalation deadline without losing incident history',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:300},escalation:{enabled:true,afterMinutes:1,targetChatIds:['1']}});
    await hub.enqueue({...input,level:'critical'},source);const incident=(await hub.listIncidents(1)).items[0];
    await hub.actOnIncident(incident.id,{action:'snooze',minutes:2,expectedVersion:incident.version});await evictDurableObject(hub);
    network();await resume();await tick(60001);expect((await hub.getIncident(incident.id))?.incident.status).toBe('snoozed');
    await tick(60001);const resumed=(await hub.getIncident(incident.id))!;
    expect(resumed.incident.status).toBe('open');expect(resumed.incident.escalationCount).toBe(0);expect(resumed.timeline.some(e=>e.action==='resumed')).toBe(true);
  });
  it('rejects stale actions and cross-tenant IDs without modifying another tenant',async()=>{
    await policy({grouping:{enabled:true,windowSeconds:300}});await hub.enqueue(input,source);const incident=(await hub.listIncidents(1)).items[0];
    await expect((async()=>hub.actOnIncident(incident.id,{action:'resolve',expectedVersion:99}))()).rejects.toThrow('STALE_INCIDENT');
    expect(await bindings.HUB.getByName('unrelated').getIncident(incident.id)).toBeNull();
    expect((await hub.getIncident(incident.id))?.incident.status).toBe('open');
  });
});

describe('delivery rules and subscriber schedules',()=>{
  it('combines due items into one bounded digest after restart and retains delivery receipts',async()=>{
    await subscribe(1);await preferences('1',{delivery:'digest',digestMinutes:5});
    await hub.enqueue(input,source);await hub.enqueue({...input,event:'deploy.failed'},source);
    const fetch=network();await resume();await tick();expect(fetch).not.toHaveBeenCalled();
    await evictDurableObject(hub);await tick(300001);
    expect(fetch).toHaveBeenCalledTimes(1);const payload=JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(JSON.stringify(payload.rich_message)).toContain('Notification digest · 2');expect(JSON.stringify(payload.rich_message)).toContain('deploy.failed');
    expect((await deliveries()).map(d=>d.status)).toEqual(['sent','sent']);
    expect(new Set((await deliveries()).map(d=>d.telegram_message_id)).size).toBe(1);
  });
  it('rechecks filters, ban and application access before digest release',async()=>{
    await subscribe(1);await subscribe(2);await preferences('1',{delivery:'digest',digestMinutes:5});await preferences('2',{delivery:'digest',digestMinutes:5});
    await hub.enqueue(input,source);
    await preferences('1',{levels:['success']});await hub.setSubscriberBan(['2'],true);
    const fetch=network();await resume();await tick(300001);expect(fetch).not.toHaveBeenCalled();
    expect((await deliveries()).every(d=>d.status==='skipped')).toBe(true);
  });
  it('delays quiet-hours traffic but never lets Critical bypass a forbidden application or level filter',async()=>{
    now=Date.parse(new Date(now+86400000).toISOString().slice(0,10)+'T10:00:00.000Z');
    await subscribe(1);await preferences('1',{timezone:'UTC',quietHours:{enabled:true,start:'09:00',end:'11:00'},criticalBypass:true});
    await hub.enqueue(input,source);await hub.enqueue({...input,level:'critical'},source);
    const fetch=network();await resume();await tick();expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][1]?.body)).toContain('critical');await tick(3600001);expect(fetch).toHaveBeenCalledTimes(2);
    await preferences('1',{levels:['error']});const result=await hub.previewDelivery({applicationId:'payments',chatId:'1',level:'critical'});expect(result.mode).toBe('mute');
  });
  it('applies per-application overrides and safe reset while preserving monotonic policy versions',async()=>{
    const tenant=await policy({grouping:{enabled:true,windowSeconds:300}});
    const override=await hub.updateAutomationPolicy('payments',{expectedVersion:tenant.policy.version,grouping:{enabled:false,windowSeconds:300}});
    expect(override.inherited).toBe(false);expect((await hub.getAutomationPolicy('deployments')).policy.grouping.enabled).toBe(true);
    const reset=await hub.resetAutomationPolicy('payments',override.policy.version);expect(reset.inherited).toBe(true);expect(reset.policy.version).toBeGreaterThan(override.policy.version);
    await expect((async()=>hub.updateAutomationPolicy('payments',{expectedVersion:override.policy.version}))()).rejects.toThrow();
  });
  it('keeps preview read-only and exposes private self-service preference controls',async()=>{
    await subscribe(1);const before=await hub.getUsage();await hub.previewDelivery({applicationId:'payments',chatId:'1',level:'info'});expect(await hub.getUsage()).toEqual(before);
    await subscribe(1,'/preferences');const fetch=network();await resume();await tick();const sent=JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent.reply_markup.inline_keyboard.flat().some((b:{callback_data:string})=>b.callback_data==='prefs:digest')).toBe(true);
    await subscribe(1,'/timezone Europe/Berlin');expect((await hub.getSubscriberPreferences('1')).timezone).toBe('Europe/Berlin');
    await subscribe(1,'/quiet 23:00 07:00');expect((await hub.getSubscriberPreferences('1')).quietHours).toEqual({enabled:true,start:'23:00',end:'07:00'});
  });
});

describe('automation concurrency and delivery safety',()=>{
  it('coalesces at full queue capacity and still charges unique occurrences to the daily quota',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:300}});
    await bindings.TENANTS.getByName('registry').updateTenant(tenantId,{limits:{maxPendingDeliveries:1,notificationsPerDay:2}});
    await hub.enqueue(input,source,'one');const second=await hub.enqueue(input,source,'two');
    expect(second.notification).toMatchObject({grouped:true,total:1,pending:1});expect((await deliveries()).length).toBe(1);
    await expect((async()=>hub.enqueue(input,source,'three'))()).rejects.toThrow('DAILY_LIMIT');
    expect((await hub.getIncidentOverview()).totalOccurrences).toBe(2);
  });
  it('closes all active fixed windows on one recovery and schedules escalation when severity becomes Critical',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:60},escalation:{enabled:true,afterMinutes:1,targetChatIds:['1']}});
    await hub.enqueue({...input,level:'warning'},source);await hub.enqueue({...input,level:'critical'},source);
    expect((await hub.listIncidents(1)).items[0].nextEscalationAt).not.toBeNull();
    now+=61000;await hub.enqueue(input,source);expect((await hub.listIncidents(1,'open')).total).toBe(2);
    await hub.enqueue({...input,incidentStatus:'resolved',level:'success'},source);
    expect((await hub.listIncidents(1,'open')).total).toBe(0);expect((await hub.listIncidents(1,'resolved')).total).toBe(2);
    const fetch=network();await resume();await tick();await tick();
    expect(fetch.mock.calls.every(c=>String(c[1]?.body).includes('resolved'))).toBe(true);
  });
  it.each(['mute','digest'] as const)('honors a %s preference change during the final persistence boundary',async(mode)=>{
    await subscribe(1);await hub.enqueue(input,source);const fetch=network();await resume();
    await runInDurableObject(hub,async(instance,state)=>{
      const original=state.storage.sync.bind(state.storage);
      const sync=vi.spyOn(state.storage,'sync').mockImplementationOnce(async()=>{
        const prefs=instance.getSubscriberPreferences('1');
        await instance.updateSubscriberPreferences('1',{expectedVersion:prefs.version,...(mode==='mute'?{levels:['success']}:{delivery:'digest',digestMinutes:60})});await original();
      });
      await instance.alarm();sync.mockRestore();
    });
    expect(fetch).not.toHaveBeenCalled();await tick();expect(fetch).not.toHaveBeenCalled();expect((await deliveries())[0].status).toBe(mode==='mute'?'skipped':'pending');
    if(mode==='digest') expect(Number((await deliveries())[0].next_attempt)).toBe((Math.floor(now/3600000)+1)*3600000);
  });
  it('never retries an uncertain new digest as an edit of its previously confirmed incident message',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:3600}});await hub.enqueue(input,source);const fetch=network();await resume();await tick();
    await preferences('1',{delivery:'digest',digestMinutes:5});await hub.enqueue(input,source);
    fetch.mockImplementationOnce(async()=>new Response('failure',{status:503}));await tick(300001);
    const failed=(await deliveries())[0];expect(failed.status).toBe('unknown');expect(failed.telegram_message_id).toBeNull();
    expect(JSON.parse(String(failed.system_payload)).method).toBe('sendRichMessage');
    await evictDurableObject(hub);await hub.enqueue(input,source);await tick(300001);expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps an incident change arriving during digest I/O queued for the next digest',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:3600}});await preferences('1',{delivery:'digest',digestMinutes:5});await hub.enqueue(input,source);await resume();
    let release!:()=>void;let started!:()=>void;
    const wait=new Promise<void>(r=>{release=r;});const announcement=new Promise<void>(r=>{started=r;});
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementationOnce(async()=>{const response=new Response(JSON.stringify({ok:true,result:{message_id:200}}));started();await wait;return response;});
    now+=300001;const alarm=runDurableObjectAlarm(hub);await announcement;
    await bindings.HUB.get(hub.id).enqueue({...input,incidentStatus:'resolved',level:'success'},source);
    release();await alarm;hub=bindings.HUB.get(hub.id);
    expect((await deliveries())[0].status).toBe('pending');expect((await deliveries())[0].telegram_message_id).toBeNull();
    fetch.mockImplementation(async()=>new Response(JSON.stringify({ok:true,result:{message_id:201}})));
    await tick(300001);await tick(300001);expect(fetch).toHaveBeenCalledTimes(2);expect(String(fetch.mock.calls[1][0])).toContain('sendRichMessage');
  });
  it('bounds digest batches to 20 items and retains remaining work for a later queue slot',async()=>{
    await subscribe(1);await preferences('1',{delivery:'digest',digestMinutes:5});
    for(let i=0;i<23;i++) await hub.enqueue({...input,event:`event.${i}`},source);
    const fetch=network();await resume();await tick(300001);expect(fetch).toHaveBeenCalledTimes(1);expect(String(fetch.mock.calls[0][1]?.body)).toContain('Notification digest · 20');
    await tick();expect(fetch).toHaveBeenCalledTimes(2);expect(String(fetch.mock.calls[1][1]?.body)).toContain('Notification digest · 3');expect((await deliveries()).every(r=>r.status==='sent')).toBe(true);
  });
});

describe('quiet hours and edit recovery',()=>{
  it('holds an overdue digest throughout quiet hours and releases at the existing quiet-window end',async()=>{
    now=Date.parse(new Date(now+86400000).toISOString().slice(0,10)+'T21:50:00.000Z');
    await subscribe(1);await preferences('1',{timezone:'UTC',delivery:'digest',digestMinutes:5,quietHours:{enabled:true,start:'22:00',end:'08:00'}});
    await hub.enqueue(input,source);const fetch=network();await resume();await tick(40*60000);
    expect(fetch).not.toHaveBeenCalled();const due=Number((await deliveries())[0].next_attempt);expect(new Date(due).toISOString()).toContain('08:00:00');
    now=due;await runDurableObjectAlarm(hub);expect(fetch).toHaveBeenCalledTimes(1);expect(String(fetch.mock.calls[0][1]?.body)).toContain('Notification digest');
  });
  it('retries uncertain edits safely and accepts Telegram already-modified acknowledgements',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:300}});await hub.enqueue(input,source);const fetch=network();await resume();await tick();
    await hub.enqueue({...input,text:'A repeat'},source);
    fetch.mockImplementationOnce(async()=>new Response('upstream failure',{status:502}));await tick(31001);expect((await deliveries())[0].status).toBe('pending');
    fetch.mockImplementationOnce(async()=>new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message is not modified: exactly the same content'}),{status:400}));await tick(31001);
    expect((await deliveries())[0].status).toBe('sent');expect(String(fetch.mock.calls[1][0])).toContain('/editMessageText');expect(String(fetch.mock.calls[2][0])).toContain('/editMessageText');
  });
});

describe('incident action queue backpressure',()=>{
  it('persists acknowledgement at full capacity and promotes its message edit once a slot is available',async()=>{
    await subscribe(1);await policy({grouping:{enabled:true,windowSeconds:300}});
    await bindings.TENANTS.getByName('registry').updateTenant(tenantId,{limits:{maxPendingDeliveries:1}});
    await hub.enqueue(input,source);const fetch=network();await resume();await tick();
    const incident=(await hub.listIncidents(1)).items[0];await hub.enqueue({...input,fingerprint:'another-incident'},source);
    await hub.actOnIncident(incident.id,{action:'acknowledge',expectedVersion:incident.version});
    expect((await hub.getUsage()).pendingDeliveries).toBe(1);expect((await hub.getIncident(incident.id))?.incident.status).toBe('acknowledged');
    await evictDurableObject(hub);await tick();await tick();
    expect(fetch).toHaveBeenCalledTimes(3);expect(String(fetch.mock.calls[2][0])).toContain('/editMessageText');expect(String(fetch.mock.calls[2][1]?.body)).toContain('acknowledged');
  });
});
