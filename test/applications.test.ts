import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { ApplicationCreate, ApplicationUpdate, Env } from '../src/types';
import { hubName } from '../src/types';
import { applicationAudience, ApplicationStore } from '../src/applications';
const bindings = env as unknown as Env;
const registry = () => bindings.TENANTS.getByName(`applications-${crypto.randomUUID()}`);
const rejects = (operation: () => PromiseLike<unknown>) => (async () => await operation())();

describe('application credentials and registry cache', () => {
  it('isolates keys, persists hashes and immediately revokes rotated or disabled credentials', async () => {
    const stub = registry();
    await stub.createTenant({ id: 'other', name: 'Other tenant' });
    const first = await stub.createApplication('default', { id: 'payments', name: 'Payments' });
    const second = await stub.createApplication('default', { id: 'monitoring', name: 'Monitoring' });
    expect(await stub.verifyApplicationKey('default', first.apiKey)).toMatchObject({ id: 'payments' });
    expect(await stub.verifyApplicationKey('other', first.apiKey)).toBeNull();
    expect(JSON.stringify(await stub.listApplications('default'))).not.toContain(first.apiKey);
    const stored = await runInDurableObject(stub, (_, state) => [...state.storage.sql.exec<{ data: string }>('SELECT data FROM tenant_applications')].map(row => row.data).join(''));
    expect(stored).not.toContain(first.apiKey);
    const rotated = await stub.rotateApplicationKey('default', first.application.id, first.application.version);
    expect(await stub.verifyApplicationKey('default', first.apiKey)).toBeNull();
    expect(await stub.verifyApplicationKey('default', rotated.apiKey)).toMatchObject({ id: 'payments' });
    await stub.updateApplication('default', first.application.id, { enabled: false });
    expect(await stub.verifyApplicationKey('default', rotated.apiKey)).toBeNull();
    expect(await stub.verifyApplicationKey('default', second.apiKey)).toMatchObject({ id: 'monitoring' });
    await evictDurableObject(stub);
    expect(await stub.verifyApplicationKey('default', second.apiKey)).toMatchObject({ id: 'monitoring' });
    expect(await stub.verifyApplicationKey('default', rotated.apiKey)).toBeNull();
  });
  it('does not provision an application or authenticate a key until the admin creates one', async () => {
    const stub = registry();
    expect(await stub.listApplications('default')).toEqual([]);
    expect(await stub.verifyApplicationKey('default', bindings.API_KEY)).toBeNull();
    expect(await stub.verifyApplicationKey('default', 'test-ingestion-key')).toBeNull();
    const created = await stub.createApplication('default', { id: 'notifications', name: 'Notifications' });
    expect(await stub.verifyApplicationKey('default', created.apiKey)).toMatchObject({ id: 'notifications' });
  });
  it('preserves an existing legacy application but requires a stored key hash', async () => {
    const stub = registry();
    await runInDurableObject(stub, (_, state) => {
      const now = new Date().toISOString();
      state.storage.sql.exec('INSERT INTO tenant_applications (tenant_id, id, data) VALUES (?, ?, ?)', 'default', 'legacy', JSON.stringify({ id: 'legacy', name: 'Legacy integration', enabled: true, createdAt: now, updatedAt: now, version: 1, isLegacy: true, keyHash: null }));
    });
    expect(await stub.listApplications('default')).toMatchObject([{ id: 'legacy', keyConfigured: false, audienceMode: 'all', audienceChatIds: [], showInDirectory: true }]);
    expect(await stub.verifyApplicationKey('default', 'test-ingestion-key')).toBeNull();
    const rotated = await stub.rotateApplicationKey('default', 'legacy');
    expect(await stub.verifyApplicationKey('default', rotated.apiKey)).toMatchObject({ id: 'legacy', keyConfigured: true, audienceMode: 'all', audienceChatIds: [], showInDirectory: true });
  });
  it('serves repeated application/key reads without SQL and rehydrates after LRU eviction', async () => {
    const stub = registry();
    await runInDurableObject(stub, async (_, state) => {
      const store = new ApplicationStore(state.storage.sql);
      const created = await store.create('cache-test', { id: 'backend', name: 'Backend' });
      const exec = vi.spyOn(state.storage.sql, 'exec');
      try {
        for (let i = 0; i < 20; i++) {
          expect(store.list('cache-test')).toHaveLength(1);
          expect((await store.verifyKey('cache-test', created.apiKey))?.id).toBe('backend');
        }
        expect(exec).not.toHaveBeenCalled();
        for (let i = 0; i < 33; i++) store.list(`evict-${i}`);
        exec.mockClear();
        expect((await store.verifyKey('cache-test', created.apiKey))?.id).toBe('backend');
        expect(exec).toHaveBeenCalledTimes(1);
      } finally { exec.mockRestore(); }
    });
  });
  it('checks versions at commit and rejects invalid or duplicate application IDs', async () => {
    const stub = registry();
    const created = await stub.createApplication('default', { id: 'api', name: 'API' });
    await stub.updateApplication('default', 'api', { name: 'Renamed', expectedVersion: created.application.version });
    await expect((async () => await stub.rotateApplicationKey('default', 'api', created.application.version))()).rejects.toThrow('STALE_APPLICATION');
    await expect((async () => await stub.createApplication('default', { id: 'api', name: 'Duplicate' }))()).rejects.toThrow('APPLICATION_EXISTS');
    await expect((async () => await stub.createApplication('default', { id: '../bad', name: 'Bad' }))()).rejects.toThrow('INVALID_APPLICATION');
  });
});

async function audienceTenant(stub: ReturnType<typeof registry>, chatIds: string[] = []) {
  const id = `audience-${crypto.randomUUID().slice(0, 8)}`;
  await stub.createTenant({ id, name: 'Audience test' });
  const hub = bindings.HUB.getByName(hubName(id));
  await runInDurableObject(hub, (_, state) => {
    state.storage.sql.exec('INSERT INTO subscribers (chat_id, first_name, joined_at, updated_at) SELECT value, ?, 1, 1 FROM json_each(?)', 'Test subscriber', JSON.stringify(chatIds));
  });
  return { id, hub };
}

describe('application audience policies', () => {
  it('defaults to future-inclusive access and returns versioned runtime snapshots only when changed', async () => {
    const stub = registry();
    const created = await stub.createApplication('default', { id: 'audience-default', name: 'Default audience' });
    expect(created.application).toMatchObject({ audienceMode: 'all', audienceChatIds: [], showInDirectory: true });
    const initial = (await stub.getRuntime('default'))!;
    expect(initial.applications).toMatchObject([{ id: created.application.id, audienceMode: 'all' }]);
    const unchanged = (await stub.getRuntime('default', initial.applicationRevision))!;
    expect(unchanged.applicationRevision).toBe(initial.applicationRevision);
    expect(unchanged.applications).toBeUndefined();
    await stub.updateApplication('default', created.application.id, { showInDirectory: false });
    const changed = (await stub.getRuntime('default', initial.applicationRevision))!;
    expect(changed.applicationRevision).not.toBe(initial.applicationRevision);
    expect(changed.applications).toMatchObject([{ showInDirectory: false }]);
    expect(await stub.verifyApplicationKey('default', created.apiKey)).toMatchObject({ showInDirectory: false });
    await evictDurableObject(stub);
    expect((await stub.getRuntime('default', changed.applicationRevision))?.applications).toBeUndefined();
  });

  it('validates recipients in their tenant before create/update and persists complete policy snapshots', async () => {
    const stub = registry();
    const first = await audienceTenant(stub, ['11', '12']);
    const other = await audienceTenant(stub, ['99']);
    await expect(rejects(() => stub.createApplication(first.id, { id: 'rejected', name: 'Unknown audience', audienceMode: 'selected', audienceChatIds: ['99'] }))).rejects.toThrow('INVALID_APPLICATION');
    expect(await stub.listApplications(first.id)).toEqual([]);
    const created = await stub.createApplication(first.id, { id: 'restricted', name: 'Restricted', audienceMode: 'selected', audienceChatIds: ['11'], showInDirectory: false });
    await expect(rejects(() => stub.updateApplication(first.id, 'restricted', { audienceMode: 'selected', audienceChatIds: ['12', '99'] }))).rejects.toThrow('INVALID_APPLICATION');
    expect(await stub.getApplication(first.id, 'restricted')).toEqual(created.application);
    expect(await stub.listApplications(other.id)).toEqual([]);
    const snapshot = await runInDurableObject(first.hub, (_, state) => ({
      policy: [...state.storage.sql.exec('SELECT audience_mode, show_in_directory, version FROM application_access WHERE application_id = ?', 'restricted')][0],
      ids: [...state.storage.sql.exec<{ chat_id: string }>('SELECT chat_id FROM application_audience WHERE application_id = ?', 'restricted')].map(row => row.chat_id),
    }));
    expect(snapshot).toEqual({ policy: { audience_mode: 'selected', show_in_directory: 0, version: 1 }, ids: ['11'] });
    const denied = await stub.updateApplication(first.id, 'restricted', { audienceMode: 'selected', audienceChatIds: [] });
    expect(denied).toMatchObject({ audienceMode: 'selected', audienceChatIds: [], showInDirectory: false });
    const rotated = await stub.rotateApplicationKey(first.id, 'restricted', denied.version);
    expect(rotated.application).toMatchObject({ audienceMode: 'selected', audienceChatIds: [], showInDirectory: false });
    expect(await stub.verifyApplicationKey(first.id, created.apiKey)).toBeNull();
    expect(await stub.verifyApplicationKey(first.id, rotated.apiKey)).toMatchObject({ audienceMode: 'selected', audienceChatIds: [] });
    const restored = await runInDurableObject(stub, (_, state) => new ApplicationStore(state.storage.sql).get(first.id, 'restricted'));
    expect(restored).toEqual(rotated.application);
  });

  it('enforces paired updates, canonical unique numeric IDs, and the 1000-recipient bound', async () => {
    const valid = { audienceMode: 'selected' as const, audienceChatIds: Array.from({ length: 1000 }, (_, index) => String(index + 1)) };
    expect(applicationAudience(valid, true)?.audienceChatIds).toHaveLength(1000);
    for (const patch of [
      { audienceMode: 'selected' }, { audienceChatIds: [] }, { audienceMode: 'all', audienceChatIds: ['1'] },
      { audienceMode: null, audienceChatIds: [] }, { audienceMode: 'selected', audienceChatIds: null },
      { audienceMode: 'selected', audienceChatIds: ['01'] }, { audienceMode: 'selected', audienceChatIds: ['-0'] },
      { audienceMode: 'selected', audienceChatIds: ['1', '1'] }, { audienceMode: 'selected', audienceChatIds: [1] },
      { audienceMode: 'selected', audienceChatIds: ['1e3'] }, { audienceMode: 'selected', audienceChatIds: ['1'.repeat(21)] },
      { ...valid, audienceChatIds: [...valid.audienceChatIds, '1001'] },
    ]) expect(() => applicationAudience(patch as ApplicationUpdate, true)).toThrow('INVALID_APPLICATION');
    expect(applicationAudience({ audienceMode: 'selected' } as ApplicationCreate)).toEqual({ audienceMode: 'selected', audienceChatIds: [] });
    const worstCase = { id: 'a'.repeat(48), name: 'a'.repeat(80), audienceMode: 'selected', audienceChatIds: valid.audienceChatIds.map(id => `${id.padStart(20, '9')}`), showInDirectory: false };
    expect(new TextEncoder().encode(JSON.stringify(worstCase)).byteLength).toBeLessThan(65_536);
  });

  it('rejects invalid directory flags and keeps cached audiences immutable to callers', async () => {
    const stub = registry();
    await runInDurableObject(stub, async (_, state) => {
      const store = new ApplicationStore(state.storage.sql);
      await expect(store.create('flags', { id: 'invalid', name: 'Invalid', showInDirectory: null } as unknown as ApplicationCreate)).rejects.toThrow('INVALID_APPLICATION');
      const created = await store.create('flags', { id: 'private', name: 'Private', audienceMode: 'selected', audienceChatIds: ['1'] });
      created.application.audienceChatIds.push('2');
      store.list('flags')[0].audienceChatIds.push('3');
      (await store.verifyKey('flags', created.apiKey))!.audienceChatIds.push('4');
      expect(store.get('flags', 'private')?.audienceChatIds).toEqual(['1']);
      expect(() => store.update('flags', 'private', { showInDirectory: 'false' } as unknown as ApplicationUpdate)).toThrow('INVALID_APPLICATION');
      expect(store.get('flags', 'private')?.version).toBe(1);
    });
  });

  it('rejects a delayed audience edit after key rotation even when expectedVersion was omitted', async () => {
    const stub = registry();
    const { id } = await audienceTenant(stub, ['1']);
    const created = await stub.createApplication(id, { id: 'race', name: 'Original' });
    await runInDurableObject(stub, async (instance) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const target = instance as unknown as { validateApplicationAudience: () => Promise<void> };
      const validation = vi.spyOn(target, 'validateApplicationAudience').mockImplementation(() => gate);
      const pending = instance.updateApplication(id, 'race', { audienceMode: 'selected', audienceChatIds: ['1'], name: 'Stale name' });
      try {
        expect(validation).toHaveBeenCalledTimes(1);
        const rotated = await instance.rotateApplicationKey(id, 'race');
        release();
        await expect(pending).rejects.toThrow('STALE_APPLICATION');
        expect(await instance.getApplication(id, 'race')).toEqual(rotated.application);
        expect(await instance.verifyApplicationKey(id, created.apiKey)).toBeNull();
        expect(await instance.verifyApplicationKey(id, rotated.apiKey)).toMatchObject({ name: 'Original', audienceMode: 'all', audienceChatIds: [] });
      } finally { release(); validation.mockRestore(); }
    });
  });
});
