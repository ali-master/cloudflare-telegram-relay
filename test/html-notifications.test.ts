import {env} from 'cloudflare:workers';
import {evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject, SELF} from 'cloudflare:test';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Env, NotificationRecord} from '../src/types';
import {notificationInput} from '../src/validation';

const bindings = env as unknown as Env;
const registry = () => bindings.TENANTS.getByName('registry');
const hub = () => bindings.HUB.getByName('primary');
const source = {ip: '203.0.113.20', country: 'DE', source: 'api'};
const origin = 'https://relay.test';
const base = {application: 'Ignored client name', event: 'deploy.ready', level: 'success', text: '<b>Ready</b>'};
let key: string;
let now: number;

async function send(body: unknown, idempotencyKey?: string, path = '/api/v1/tenants/default/notifications') {
  return SELF.fetch(`${origin}${path}`, {method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-API-Key': key,
    ...(idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {}),
  }, body: JSON.stringify(body)});
}
async function tick(ms = 1001) {now += ms; await runDurableObjectAlarm(hub());}
const deliveries = () => runInDurableObject(hub(), (_, state) => state.storage.sql.exec('SELECT * FROM deliveries WHERE notification_id IS NOT NULL').toArray());
const outgoing = () => vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => /\/(sendRichMessage|editMessageText)$/.test(String(url)));

beforeEach(async () => {
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async request => new Response(JSON.stringify({ok: true,
    result: String(request).endsWith('/getMe') ? {id: 123456, is_bot: true, username: 'html_fixture_bot'}
      : /\/(setMyCommands|setChatMenuButton)$/.test(String(request)) ? true : {message_id: 710},
  })));
  await registry().configureBot('default', '123456:html-fixture-token');
  key = (await registry().createApplication('default', {id: 'html-app', name: 'HTML App'})).apiKey;
  await hub().initializeTenant('default');
  await hub().updateSettings({...await hub().getSettings(), paused: true, welcomeMessage: ''});
  await hub().handleUpdate({update_id: 1, message: {chat: {id: 99101, type: 'private'}, from: {first_name: 'HTML fixture'}, text: '/start'}});
  vi.mocked(globalThis.fetch).mockClear();
});
afterEach(async () => {vi.restoreAllMocks(); await reset();});

describe('HTML notification acceptance and durable delivery', () => {
  it('persists HTML source and a plain preview, then sends native rich blocks after restart', async () => {
    const text = '<p><b>Ready</b> &amp; <code>v2</code></p><p>سلام</p>';
    const accepted = await send({...base, text, parseMode: 'HTML', title: '<i>Literal title</i>', metadata: {build: '<b>literal</b>'}});
    expect(accepted.status).toBe(202);
    const {notification} = await accepted.json() as {notification: NotificationRecord};
    expect(notification).toMatchObject({text, parseMode: 'HTML', application: 'HTML App', total: 1});
    expect(notification.plainText).toContain('Ready & v2');
    expect(notification.plainText).not.toContain('<b>');
    const stored = (await deliveries())[0];
    expect(String(stored.rendered)).toContain('Ready & v2');
    expect(String(stored.rendered)).not.toContain('<code>');
    await evictDurableObject(hub());
    await hub().updateSettings({...await hub().getSettings(), paused: false});
    await tick();
    expect(outgoing()).toHaveLength(1);
    const payload = JSON.parse(String(outgoing()[0][1]?.body));
    expect(payload.chat_id).toBe('99101');
    expect(payload.rich_message.blocks[0].text).toBe('✅ <i>Literal title</i>');
    expect(JSON.stringify(payload.rich_message.blocks[1])).toContain('"type":"bold"');
    expect(JSON.stringify(payload.rich_message)).toContain('<b>literal</b>');
    expect(payload).not.toHaveProperty('parse_mode');
    expect((await hub().getNotification(notification.id))?.notification).toMatchObject({parseMode: 'HTML', sent: 1});
    expect((await hub().listNotifications(1)).items[0].plainText).toEqual(notification.plainText);
  });

  it('keeps literal text as the default and treats a changed parse mode as an idempotency conflict', async () => {
    const first = await send(base, 'literal-source', '/api/v1/notifications');
    expect(first.status).toBe(202);
    const firstBody = await first.json() as any;
    expect(firstBody.notification).not.toHaveProperty('parseMode');
    expect(firstBody.notification).not.toHaveProperty('plainText');
    expect(JSON.parse(String((await deliveries())[0].system_payload)).rich_message.blocks[1]).toEqual({type: 'paragraph', text: base.text});
    expect((await send({...base, parseMode: 'HTML'}, 'literal-source')).status).toBe(409);
    const html = await send({...base, parseMode: 'HTML'}, 'html-source');
    expect(html.status).toBe(202);
    const duplicate = await send({...base, parseMode: 'HTML'}, 'html-source');
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({duplicate: true});
    expect((await hub().listNotifications(1)).total).toBe(2);
  });

  it('rejects invalid HTML and unsupported modes before queueing or sending anything', async () => {
    for (const text of ['<script>private-content</script>', '<b><i>Mismatch</b></i>', '<a href="javascript:alert(1)">unsafe</a>']) {
      const response = await send({...base, text, parseMode: 'HTML'});
      expect(response.status).toBe(400);
      const error = await response.json() as any;
      expect(error.error.code).toBe('INVALID_HTML');
      expect(error.error.message).not.toContain('private-content');
    }
    for (const parseMode of ['html', 'Markdown', '', null, false]) expect((await send({...base, parseMode})).status).toBe(400);
    expect((await hub().listNotifications(1)).total).toBe(0);
    expect(await deliveries()).toHaveLength(0);
    expect(outgoing()).toHaveLength(0);
  });

  it('counts visible content separately from markup and keeps the full-message bound', () => {
    const longSource = '<b>' + '&amp;'.repeat(700) + '</b>';
    expect(longSource.length).toBeGreaterThan(3000);
    expect(notificationInput({...base, text: longSource, parseMode: 'HTML'}, source).text).toBe(longSource);
    for (const text of ['<b>' + 'x'.repeat(3001) + '</b>', '<b> </b>', '<b>' + '&#0000000000000000000038;'.repeat(550) + '</b>']) {
      expect(() => notificationInput({...base, text, parseMode: 'HTML'}, source)).toThrow();
    }
    expect(() => notificationInput({...base, text: '<b>' + 'x'.repeat(2900) + '</b>', parseMode: 'HTML',
      metadata: {one: 'x'.repeat(500), two: 'x'.repeat(500), three: 'x'.repeat(500)}}, source)).toThrow();
  });

  it('uses HTML formatting for grouped incident updates to an already delivered message', async () => {
    const policy = await hub().getAutomationPolicy();
    const {version, ...body} = policy.policy;
    await hub().updateAutomationPolicy(null, {...body, grouping: {...body.grouping, enabled: true}, expectedVersion: version});
    const first = await send({...base, parseMode: 'HTML', fingerprint: 'html-incident', level: 'error'});
    expect(first.status).toBe(202);
    await hub().updateSettings({...await hub().getSettings(), paused: false});
    await tick();
    await evictDurableObject(hub());
    const recovered = await send({...base, text: '<p><i>Recovered</i></p><p>All checks passed</p>', parseMode: 'HTML', fingerprint: 'html-incident', incidentStatus: 'resolved'});
    expect(recovered.status).toBe(202);
    await tick();
    const edits = outgoing().filter(([url]) => String(url).endsWith('/editMessageText'));
    expect(edits).toHaveLength(1);
    const payload = JSON.parse(String(edits[0][1]?.body));
    expect(payload.message_id).toBe(710);
    expect(JSON.stringify(payload.rich_message)).toContain('"type":"italic"');
    expect(JSON.stringify(payload.rich_message)).not.toContain('<i>');
  });
});
