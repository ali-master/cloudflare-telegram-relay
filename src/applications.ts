import type {Application, ApplicationCreate, ApplicationUpdate} from './types';

type StoredApplication = Omit<Application, 'keyConfigured'> & { keyHash: string | null };
const fail = (code: string): never => {
  throw new Error(`${code}: Application operation rejected.`);
};
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$/.test(id);
const validName = (name: unknown): name is string => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 80;
const digest = async (key: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), byte => byte.toString(16).padStart(2, '0')).join('');
const newKey = () => `app_${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
type Audience = Pick<Application, 'audienceMode' | 'audienceChatIds'>;

/** Normalize before cross-object validation so malformed or aliased chat IDs never reach the hub. */
export function applicationAudience(input: ApplicationCreate | ApplicationUpdate, updating = false): Audience | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_APPLICATION');
  const hasMode = input.audienceMode !== undefined, hasIds = input.audienceChatIds !== undefined;
  if (updating && hasMode !== hasIds) return fail('INVALID_APPLICATION');
  if (updating && !hasMode) return undefined;
  const audienceMode = input.audienceMode === undefined ? 'all' : input.audienceMode;
  const ids = input.audienceChatIds === undefined ? [] : input.audienceChatIds;
  if (!['all', 'selected'].includes(audienceMode) || !Array.isArray(ids) || ids.length > 1000) return fail('INVALID_APPLICATION');
  if (ids.some(id => typeof id !== 'string' || !/^-?\d{1,20}$/.test(id) || BigInt(id).toString() !== id) || new Set(ids).size !== ids.length) return fail('INVALID_APPLICATION');
  if (audienceMode === 'all' && ids.length !== 0) return fail('INVALID_APPLICATION');
  return {audienceMode, audienceChatIds: [...ids]};
}

/** Registry-owned cache: all mutations and key checks reach the same Durable Object. */
export class ApplicationStore {
  private cache = new Map<string, Map<string, StoredApplication>>();

  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS tenant_applications
    (
        tenant_id
        TEXT
        NOT
        NULL,
        id
        TEXT
        NOT
        NULL,
        data
        TEXT
        NOT
        NULL,
        PRIMARY
        KEY
              (
        tenant_id,
        id
              )
        )`);
  }

  private rows(tenantId: string) {
    let rows = this.cache.get(tenantId);
    if (!rows) {
      rows = new Map([...this.sql.exec<{
        id: string;
        data: string
      }>('SELECT id, data FROM tenant_applications WHERE tenant_id = ?', tenantId)].map(row => {
        const stored = JSON.parse(row.data) as StoredApplication;
        return [row.id, {
          ...stored,
          audienceMode: stored.audienceMode ?? 'all',
          audienceChatIds: stored.audienceChatIds ?? [],
          showInDirectory: stored.showInDirectory ?? true
        }];
      }));
    }
    this.cache.delete(tenantId);
    this.cache.set(tenantId, rows);
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
    return rows;
  }

  private persist(tenantId: string, application: StoredApplication) {
    this.sql.exec('INSERT INTO tenant_applications (tenant_id, id, data) VALUES (?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET data = excluded.data', tenantId, application.id, JSON.stringify(application));
  }

  private public(application: StoredApplication): Application {
    const {keyHash, ...result} = application;
    return {...result, audienceChatIds: [...result.audienceChatIds], keyConfigured: !!keyHash};
  }

  private current(tenantId: string, id: string, expectedVersion?: number) {
    const application = this.rows(tenantId).get(id);
    if (!application) return fail('APPLICATION_NOT_FOUND');
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) return fail('INVALID_APPLICATION');
    if (expectedVersion !== undefined && application.version !== expectedVersion) return fail('STALE_APPLICATION');
    return application;
  }

  list(tenantId: string): Application[] {
    return [...this.rows(tenantId).values()].map(application => this.public(application));
  }

  revision(tenantId: string): string {
    return [...this.rows(tenantId).values()].map(application => `${application.id}:${application.version}`).sort().join(',');
  }

  get(tenantId: string, id: string): Application | null {
    const application = this.rows(tenantId).get(id);
    return application ? this.public(application) : null;
  }

  async create(tenantId: string, input: ApplicationCreate): Promise<{ application: Application; apiKey: string }> {
    if (!input || !validId(input.id) || !validName(input.name)) return fail('INVALID_APPLICATION');
    const audience = applicationAudience(input)!;
    if (input.showInDirectory !== undefined && typeof input.showInDirectory !== 'boolean') return fail('INVALID_APPLICATION');
    const id = input.id, name = input.name.trim(), showInDirectory = input.showInDirectory ?? true;
    const apiKey = newKey(), keyHash = await digest(apiKey);
    const rows = this.rows(tenantId);
    if (rows.has(id)) return fail('APPLICATION_EXISTS');
    if (rows.size >= 100) return fail('APPLICATION_LIMIT');
    const now = new Date().toISOString();
    const application: StoredApplication = {
      id,
      name,
      enabled: true, ...audience,
      showInDirectory,
      createdAt: now,
      updatedAt: now,
      version: 1,
      isLegacy: false,
      keyHash
    };
    this.persist(tenantId, application);
    rows.set(application.id, application);
    return {application: this.public(application), apiKey};
  }

  update(tenantId: string, id: string, input: ApplicationUpdate): Application {
    if (!input || (input.name !== undefined && !validName(input.name)) || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) return fail('INVALID_APPLICATION');
    const audience = applicationAudience(input, true);
    if (input.showInDirectory !== undefined && typeof input.showInDirectory !== 'boolean') return fail('INVALID_APPLICATION');
    const current = this.current(tenantId, id, input.expectedVersion);
    const application = {
      ...current, ...audience,
      name: input.name?.trim() ?? current.name,
      enabled: input.enabled ?? current.enabled,
      showInDirectory: input.showInDirectory ?? current.showInDirectory,
      version: current.version + 1,
      updatedAt: new Date().toISOString()
    };
    this.persist(tenantId, application);
    this.rows(tenantId).set(id, application);
    return this.public(application);
  }

  async rotateKey(tenantId: string, id: string, expectedVersion?: number): Promise<{
    application: Application;
    apiKey: string
  }> {
    const before = this.current(tenantId, id, expectedVersion);
    const apiKey = newKey(), keyHash = await digest(apiKey);
    const current = this.current(tenantId, id, before.version);
    const application = {...current, keyHash, version: current.version + 1, updatedAt: new Date().toISOString()};
    this.persist(tenantId, application);
    this.rows(tenantId).set(id, application);
    return {application: this.public(application), apiKey};
  }

  async verifyKey(tenantId: string, key: string): Promise<Application | null> {
    if (!key || key.length > 1024) return null;
    const keyHash = await digest(key);
    // Hash first, then inspect the latest map so a rotation during crypto invalidates the old key.
    const application = [...this.rows(tenantId).values()].find(row => row.enabled && row.keyHash === keyHash);
    if (application) return this.public(application);
    return null;
  }
}
