import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { ApplicationStore } from '../src/applications';
const bindings = env as unknown as Env;
const registry = () => bindings.TENANTS.getByName(`applications-${crypto.randomUUID()}`);

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
    expect(await stub.listApplications('default')).toMatchObject([{ id: 'legacy', keyConfigured: false }]);
    expect(await stub.verifyApplicationKey('default', 'test-ingestion-key')).toBeNull();
    const rotated = await stub.rotateApplicationKey('default', 'legacy');
    expect(await stub.verifyApplicationKey('default', rotated.apiKey)).toMatchObject({ id: 'legacy', keyConfigured: true });
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
