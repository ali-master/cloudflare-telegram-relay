import {DurableObject} from 'cloudflare:workers';
import type {
  Application,
  ApplicationCreate,
  ApplicationUpdate,
  BotStatus,
  Env,
  LoginAuditInput,
  LoginAuditPage,
  LoginAuditQuery,
  Tenant,
  TenantCreate,
  TenantLimits,
  TenantRuntime,
  TenantUpdate,
  TelegramBot, TelegramBotCreate, TelegramBotUpdate, Page, TenantUsage
} from './types';
import {DEFAULT_SETTINGS, DEFAULT_TENANT_LIMITS, hubName} from './types';
import {telegramCall, TelegramError} from './telegram';
import {applicationAudience, ApplicationStore} from './applications';
import {LoginAuditStore} from './login-audit';
import {BotStore, type StoredBot} from './bots';
import {TELEGRAM_BOT_COMMANDS, type TelegramBotCommand} from './bot-commands';

interface StoredTenant {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  limits: TenantLimits;
  botToken: string | null;
  webhookSecret: string | null;
  botId: string | null;
  botUsername: string | null;
}

interface TenantRow extends Record<string, SqlStorageValue> {
  id: string;
  body: string
}

interface StatusEntry {
  signature: string;
  expires: number;
  status: BotStatus
}

const MAX_TENANTS = 500;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

const clone = <T>(value: T): T => structuredClone(value);
const randomSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');

function record(value: unknown, code = 'INVALID_TENANT'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, 'A JSON object is required.');
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: string[], code = 'INVALID_TENANT'): void {
  if (Object.keys(value).some(key => !keys.includes(key))) fail(code, 'An unsupported field was supplied.');
}

function tenantId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,47}$/.test(value)) fail('INVALID_TENANT', 'Tenant IDs must contain 2–48 lowercase URL-safe characters.');
  return value;
}

function tenantName(value: unknown, code = 'INVALID_TENANT'): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail(code, 'Names must contain 1–80 characters.');
  return value.trim();
}

function mergedLimits(value: unknown, current: TenantLimits): TenantLimits {
  if (value === undefined) return {...current};
  const input = record(value);
  onlyKeys(input, Object.keys(DEFAULT_TENANT_LIMITS));
  const result = {...current, ...input} as TenantLimits;
  for (const key of Object.keys(DEFAULT_TENANT_LIMITS) as Array<keyof TenantLimits>) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > (key === 'requestsPerMinute' ? 10_000 : 1_000_000)) {
      fail('INVALID_TENANT', 'Tenant limits must be positive integers within the supported range.');
    }
  }
  return result;
}

function expectedVersion(value: unknown, code = 'INVALID_TENANT'): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1)) fail(code, 'expectedVersion must be a positive integer.');
  return value as number | undefined;
}

function tokenIdentity(token: string): string | null {
  const prefix = /^([1-9][0-9]*):/.exec(token)?.[1];
  return prefix && Number.isSafeInteger(Number(prefix)) ? prefix : null;
}

/** The registry loads its bounded table once; tenant/runtime reads never query SQLite. */
export class TenantRegistry extends DurableObject<Env> {
  private readonly applications: ApplicationStore;
  private readonly bots: BotStore;
  private readonly loginAudit: LoginAuditStore;
  private readonly tenants = new Map<string, StoredTenant>();
  private readonly statuses = new Map<string, StatusEntry>();
  private readonly statusRequests = new Map<string, { signature: string; promise: Promise<BotStatus> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.applications = new ApplicationStore(ctx.storage.sql);
    this.bots = new BotStore(ctx.storage.sql);
    this.loginAudit = new LoginAuditStore(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tenant_wake_jobs (tenant_id TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL)");
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS tenant_bot_usage (tenant_id TEXT NOT NULL, bot_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant_id,bot_id))');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
      const now = new Date().toISOString();
      const initial: StoredTenant = {
        id: 'default', name: DEFAULT_SETTINGS.projectName, enabled: true, createdAt: now, updatedAt: now,
        version: 1, limits: {...DEFAULT_TENANT_LIMITS},
        botToken: null, webhookSecret: null, botId: null, botUsername: null,
      };
      ctx.storage.sql.exec('INSERT OR IGNORE INTO tenants (id, body) VALUES (?, ?)', initial.id, JSON.stringify(initial));
      const rows = ctx.storage.sql.exec<TenantRow>('SELECT id, body FROM tenants LIMIT 501').toArray();
      if (rows.length > MAX_TENANTS) fail('INVALID_TENANT', 'Tenant registry capacity was exceeded.');
      for (const row of rows) {
        const stored = JSON.parse(row.body);
        delete stored.apiKeyHash;
        this.tenants.set(row.id, stored as StoredTenant);
        this.migrateDefaultBot(stored as StoredTenant);
      }
      if (ctx.storage.sql.exec('SELECT 1 FROM tenant_wake_jobs LIMIT 1').toArray().length) await this.scheduleRegistryAlarm(Date.now() + 100);
    });
  }

  async recordLoginAttempt(input: LoginAuditInput): Promise<void> {
    const next = this.ctx.storage.transactionSync(() => this.loginAudit.append(input));
    const current = await this.ctx.storage.getAlarm();
    if (next !== null && (current === null || current > next)) await this.ctx.storage.setAlarm(next);
  }

  listLoginAudit(query: LoginAuditQuery = {}): LoginAuditPage {
    return this.loginAudit.list(query);
  }

  async alarm(): Promise<void> {
    // A watchdog retains wake work if a hub is temporarily unavailable.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    await this.processWakeJobs();
    this.loginAudit.cleanup();
    const next = this.loginAudit.nextCleanupAt();
    if (this.ctx.storage.sql.exec('SELECT 1 FROM tenant_wake_jobs LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now() + 100);
    else if (next !== null) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  private async scheduleRegistryAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private async processWakeJobs(): Promise<void> {
    const job = this.ctx.storage.sql.exec<{tenant_id: string; cursor: string; version: number}>('SELECT tenant_id,cursor,version FROM tenant_wake_jobs ORDER BY tenant_id LIMIT 1').toArray()[0];
    if (!job) return;
    const ids = this.bots.ids(job.tenant_id, job.cursor).slice(0, 5);
    for (const id of ids) await this.wakeHub(this.stored(job.tenant_id), id);
    if (ids.length < 5) this.ctx.storage.sql.exec('DELETE FROM tenant_wake_jobs WHERE tenant_id = ? AND version = ?', job.tenant_id, job.version);
    else this.ctx.storage.sql.exec('UPDATE tenant_wake_jobs SET cursor = ? WHERE tenant_id = ? AND version = ?', ids.at(-1)!, job.tenant_id, job.version);
  }

  private stored(id: string): StoredTenant {
    const tenant = this.tenants.get(tenantId(id));
    if (!tenant) fail('TENANT_NOT_FOUND', 'Tenant was not found.');
    return tenant;
  }

  private token(tenant: StoredTenant): string {
    return tenant.botToken ?? '';
  }

  private secret(tenant: StoredTenant): string {
    return tenant.webhookSecret ?? (tenant.id === 'default' ? this.env.TELEGRAM_WEBHOOK_SECRET || '' : '');
  }

  private publicTenant(tenant: StoredTenant): Tenant {
    return {
      id: tenant.id, name: tenant.name, enabled: tenant.enabled, isDefault: tenant.id === 'default',
      createdAt: tenant.createdAt, updatedAt: tenant.updatedAt, version: tenant.version,
      limits: {...tenant.limits}, botConfigured: !!this.token(tenant),
      botId: tenant.botId ?? tokenIdentity(this.token(tenant)), botUsername: tenant.botUsername,
    };
  }

  private checkVersion(tenant: StoredTenant, version: number | undefined): void {
    if (version !== undefined && tenant.version !== version) fail('STALE_TENANT', 'Tenant changed; refresh it before applying this change.');
  }

  private commit(next: StoredTenant): void {
    // SQLite commits before the authoritative in-memory entry is replaced.
    this.ctx.storage.sql.exec('INSERT INTO tenants (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body', next.id, JSON.stringify(next));
    this.tenants.set(next.id, next);
    for (const key of this.statuses.keys()) if (key.startsWith(`${next.id}:`)) this.statuses.delete(key);
    for (const key of this.statusRequests.keys()) if (key.startsWith(`${next.id}:`)) this.statusRequests.delete(key);
  }

  private changed(current: StoredTenant, patch: Partial<StoredTenant>): StoredTenant {
    return {...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString()};
  }

  private migrateDefaultBot(tenant: StoredTenant): void {
    this.bots.migrate({tenantId: tenant.id, id: 'default', name: tenant.name, enabled: true,
      telegramId: tenant.botId ?? tokenIdentity(tenant.botToken ?? ''), username: tenant.botUsername,
      botToken: tenant.botToken, webhookSecret: tenant.webhookSecret,
      createdAt: tenant.createdAt, updatedAt: tenant.updatedAt, version: tenant.version});
  }

  private storedBot(id: string, botId = 'default'): StoredBot {
    this.stored(id);
    if (typeof botId !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,47}$/.test(botId)) fail('INVALID_BOT', 'Bot IDs must contain 2–48 lowercase URL-safe characters.');
    const bot = this.bots.get(id, botId);
    if (!bot) fail('BOT_NOT_FOUND', 'Telegram bot was not found in this tenant.');
    return bot;
  }

  private botSecret(bot: StoredBot): string {
    return bot.webhookSecret ?? (bot.tenantId === 'default' && bot.id === 'default' ? this.env.TELEGRAM_WEBHOOK_SECRET || '' : '');
  }

  private checkBotVersion(bot: StoredBot, version?: number): void {
    if (version !== undefined && bot.version !== version) fail('STALE_BOT', 'Bot changed; refresh it before applying this change.');
  }

  private publicBot(bot: StoredBot): TelegramBot {
    return {...this.bots.public(bot), applicationCount: this.applications.list(bot.tenantId, bot.id).length};
  }

  private persistBot(bot: StoredBot): void {
    this.bots.put(bot);
    const tenant = this.stored(bot.tenantId);
    this.commit(this.changed(tenant, bot.id === 'default' ? {
      botToken: bot.botToken, webhookSecret: bot.webhookSecret, botId: bot.telegramId, botUsername: bot.username
    } : {}));
  }

  private async wakeHub(tenant: StoredTenant, botId?: string): Promise<void> {
    if (botId !== undefined) {
      const hub = this.env.HUB.getByName(hubName(tenant.id, botId));
      await hub.initializeTenant(tenant.id, tenant.name, botId);
      await hub.refreshApplicationAccess(this.applications.list(tenant.id, botId));
      await hub.wake();
      return;
    }
    // Tenant-wide changes enqueue durable pages instead of waiting on an unbounded fan-out.
    this.ctx.storage.sql.exec("INSERT INTO tenant_wake_jobs(tenant_id,cursor,version) VALUES(?,'',?) ON CONFLICT(tenant_id) DO UPDATE SET cursor='',version=excluded.version", tenant.id, tenant.version);
    await this.scheduleRegistryAlarm(Date.now() + 100);
  }

  private async validateApplicationAudience(tenant: StoredTenant, botId: string, chatIds: string[]): Promise<void> {
    const hub = this.env.HUB.getByName(hubName(tenant.id, botId));
    await hub.initializeTenant(tenant.id, tenant.name, botId);
    await hub.validateApplicationAudience(chatIds);
  }

  async listTenants(): Promise<Tenant[]> {
    return [...this.tenants.values()].sort((a, b) => a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(tenant => this.publicTenant(tenant));
  }

  async getTenant(id: string): Promise<Tenant | null> {
    const tenant = this.tenants.get(tenantId(id));
    return tenant ? this.publicTenant(tenant) : null;
  }

  async getRuntime(id: string, knownApplicationRevision?: string, botId = 'default'): Promise<TenantRuntime | null> {
    const tenant = this.tenants.get(tenantId(id));
    if (!tenant) return null;
    const bot = this.bots.get(id, botId);
    if (!bot) return null;
    const applicationRevision = this.applications.revision(id, botId);
    return {
      ...this.publicTenant(tenant), botConfigured: !!bot.botToken, botId: bot.telegramId, botUsername: bot.username,
      selectedBotId: bot.id, botEnabled: bot.enabled, botVersion: bot.version,
      botToken: bot.botToken ?? '', webhookSecret: this.botSecret(bot), applicationRevision,
      ...(knownApplicationRevision === applicationRevision ? {} : {applications: this.applications.list(id, botId)})
    };
  }

  async createTenant(input: TenantCreate): Promise<{ tenant: Tenant }> {
    const data = record(input);
    onlyKeys(data, ['id', 'name', 'limits']);
    const id = tenantId(data.id);
    if (id === 'default' || this.tenants.has(id)) fail('TENANT_EXISTS', 'Tenant ID is already in use.');
    if (this.tenants.size >= MAX_TENANTS) fail('INVALID_TENANT', 'A deployment supports at most 500 tenants.');
    const name = tenantName(data.name), limits = mergedLimits(data.limits, DEFAULT_TENANT_LIMITS);
    const now = new Date().toISOString();
    const next: StoredTenant = {
      id,
      name,
      limits,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      version: 1,
      botToken: null,
      webhookSecret: null,
      botId: null,
      botUsername: null
    };
    this.commit(next);
    this.migrateDefaultBot(next);
    await this.wakeHub(next, 'default');
    return {tenant: this.publicTenant(next)};
  }

  async updateTenant(id: string, input: TenantUpdate): Promise<Tenant> {
    const data = record(input);
    onlyKeys(data, ['name', 'enabled', 'limits', 'expectedVersion']);
    const current = this.stored(id);
    this.checkVersion(current, expectedVersion(data.expectedVersion));
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') fail('INVALID_TENANT', 'enabled must be a boolean.');
    const next = this.changed(current, {
      name: data.name === undefined ? current.name : tenantName(data.name),
      enabled: data.enabled === undefined ? current.enabled : data.enabled as boolean,
      limits: mergedLimits(data.limits, current.limits),
    });
    this.commit(next);
    await this.wakeHub(next);
    return this.publicTenant(next);
  }

  async listApplications(tenantId: string, botId?: string): Promise<Application[]> {
    this.stored(tenantId);
    if (botId !== undefined) this.storedBot(tenantId, botId);
    return this.applications.list(tenantId, botId);
  }

  async getApplication(tenantId: string, id: string): Promise<Application | null> {
    this.stored(tenantId);
    return this.applications.get(tenantId, id);
  }

  async createApplication(tenantId: string, input: ApplicationCreate): Promise<{
    application: Application;
    apiKey: string
  }> {
    const tenant = this.stored(tenantId);
    const audience = applicationAudience(input)!;
    const selectedBot = this.storedBot(tenantId, input.botId ?? 'default');
    const next = {...input, ...audience};
    if (audience.audienceMode === 'selected') await this.validateApplicationAudience(tenant, selectedBot.id, audience.audienceChatIds);
    const result = await this.applications.create(tenantId, next);
    this.statuses.delete(`${tenantId}:${result.application.botId}`);
    this.statusRequests.delete(`${tenantId}:${result.application.botId}`);
    await this.wakeHub(this.stored(tenantId), result.application.botId);
    return result;
  }

  async updateApplication(tenantId: string, id: string, input: ApplicationUpdate): Promise<Application> {
    const tenant = this.stored(tenantId);
    const audience = applicationAudience(input, true);
    const current = this.applications.get(tenantId, id);
    if (!current) fail('APPLICATION_NOT_FOUND', 'Application does not exist.');
    if (input.botId !== undefined && input.botId !== current.botId) fail('APPLICATION_BOT_IMMUTABLE', 'Create a new application to use a different bot.');
    const next = {
      ...input, ...audience,
      expectedVersion: input.expectedVersion === undefined ? current.version : input.expectedVersion
    };
    if (audience?.audienceMode === 'selected') await this.validateApplicationAudience(tenant, current.botId, audience.audienceChatIds);
    const result = this.applications.update(tenantId, id, next);
    this.statuses.delete(`${tenantId}:${result.botId}`);
    this.statusRequests.delete(`${tenantId}:${result.botId}`);
    await this.wakeHub(this.stored(tenantId), result.botId);
    return result;
  }

  async rotateApplicationKey(tenantId: string, id: string, version?: number): Promise<{
    application: Application;
    apiKey: string
  }> {
    this.stored(tenantId);
    const result = await this.applications.rotateKey(tenantId, id, version);
    this.statuses.delete(`${tenantId}:${result.application.botId}`);
    this.statusRequests.delete(`${tenantId}:${result.application.botId}`);
    await this.wakeHub(this.stored(tenantId), result.application.botId);
    return result;
  }

  async verifyApplicationKey(tenantId: string, key: string): Promise<Application | null> {
    if (!this.stored(tenantId).enabled) return null;
    const result = await this.applications.verifyKey(tenantId, key);
    return this.stored(tenantId).enabled ? result : null;
  }

  private checkBotIdentity(bot: StoredBot, telegramId: string): void {
    if (bot.telegramId && bot.telegramId !== telegramId) fail('BOT_CHANGE_REQUIRES_NEW_BOT', 'Create a new bot entry when switching Telegram bot identity.');
    const owner = this.bots.identityOwner(telegramId);
    if (owner && (owner.tenant_id !== bot.tenantId || owner.id !== bot.id)) fail('BOT_ALREADY_ASSIGNED', 'This Telegram bot is already assigned.');
  }

  private async validateBotToken(before: StoredBot, botToken: string): Promise<{telegramId: string; username: string | null}> {
    if (typeof botToken !== 'string' || botToken.length > 512 || !/^[1-9][0-9]*:[A-Za-z0-9_-]{5,256}$/.test(botToken)) fail('INVALID_BOT_TOKEN', 'Provide a valid Telegram bot token.');
    const inferredId = tokenIdentity(botToken);
    if (!inferredId) fail('INVALID_BOT_TOKEN', 'Provide a valid Telegram bot token.');
    this.checkBotIdentity(before, inferredId);
    let bot: Record<string, unknown>;
    try {
      bot = (await telegramCall(botToken, 'getMe')).result;
      if (!bot || bot.is_bot !== true || !Number.isSafeInteger(bot.id) || Number(bot.id) <= 0 || String(bot.id) !== inferredId) fail('INVALID_BOT_TOKEN', 'Telegram did not confirm this bot identity.');
    } catch (error) {
      if (error instanceof TelegramError && error.code === 401) fail('INVALID_BOT_TOKEN', 'Telegram rejected the bot token.');
      if (error instanceof TelegramError) {
        switch (error.reason) {
          case 'timeout':
            fail('TELEGRAM_TIMEOUT', 'Telegram did not respond before the request deadline.');
          case 'network':
            fail('TELEGRAM_NETWORK_ERROR', 'The connection to Telegram failed.');
          case 'invalid_response':
            fail('TELEGRAM_INVALID_RESPONSE', 'Telegram returned an invalid response.');
          case 'upstream_error':
            fail('TELEGRAM_UPSTREAM_ERROR', 'Telegram is temporarily unavailable.');
          case 'rate_limited':
            fail('TELEGRAM_RATE_LIMITED', 'Telegram temporarily limited requests. Try again later.');
        }
      }
      if (error instanceof Error && error.message.startsWith('INVALID_BOT_TOKEN:')) throw error;
      fail('TELEGRAM_UNAVAILABLE', 'Telegram could not validate the bot. Try again later.');
    }
    return {telegramId: inferredId, username: typeof bot!.username === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(bot!.username) ? bot!.username : null};
  }

  async listBots(id: string, page = 1, search = ''): Promise<Page<TelegramBot>> {
    this.stored(id);
    const result = this.bots.list(id, page, search);
    const counts = new Map<string, number>();
    for (const app of this.applications.list(id)) counts.set(app.botId, (counts.get(app.botId) ?? 0) + 1);
    return {...result, items: result.items.map(bot => ({...bot, applicationCount: counts.get(bot.id) ?? 0}))};
  }

  async getBot(id: string, botId: string): Promise<TelegramBot | null> {
    this.stored(id);
    const bot = this.bots.get(id, botId);
    return bot ? this.publicBot(bot) : null;
  }

  async createBot(id: string, input: TelegramBotCreate): Promise<{bot: TelegramBot}> {
    const tenant = this.stored(id), data = record(input, 'INVALID_BOT');
    onlyKeys(data, ['id', 'name', 'botToken', 'enabled'], 'INVALID_BOT');
    if (typeof data.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,47}$/.test(data.id)) fail('INVALID_BOT', 'Bot IDs must contain 2–48 lowercase URL-safe characters.');
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) fail('INVALID_BOT', 'Bot names must contain 1–80 characters.');
    const botId = data.id, name = data.name.trim();
    if (botId === 'default' || this.bots.get(id, botId)) fail('BOT_EXISTS', 'Bot ID is already in use.');
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') fail('INVALID_BOT', 'enabled must be a boolean.');
    const now = new Date().toISOString();
    const proposed: StoredBot = {tenantId: id, id: botId, name, enabled: data.enabled !== false, telegramId: null,
      username: null, botToken: null, webhookSecret: randomSecret(), createdAt: now, updatedAt: now, version: 1};
    const identity = await this.validateBotToken(proposed, data.botToken as string);
    // Seed persisted pre-multi-bot usage once so adding a bot cannot reset tenant limits.
    const existing = this.ctx.storage.sql.exec('SELECT 1 FROM tenant_bot_usage WHERE tenant_id = ? AND bot_id = ?', id, 'default').toArray().length;
    if (!existing) {
      const hub = this.env.HUB.getByName(hubName(id));
      await hub.initializeTenant(id, tenant.name);
      const usage = await hub.getUsage();
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO tenant_bot_usage(tenant_id,bot_id,revision,body) VALUES(?,?,0,?)', id, 'default', JSON.stringify(usage));
    }
    if (this.bots.get(id, botId)) fail('BOT_EXISTS', 'Bot ID is already in use.');
    this.checkBotIdentity(proposed, identity.telegramId);
    const tenantVersion = this.stored(id).version;
    await this.syncBotCommands(data.botToken as string);
    if (this.bots.get(id, botId)) fail('BOT_EXISTS', 'Bot ID is already in use.');
    this.checkBotIdentity(proposed, identity.telegramId);
    this.checkVersion(this.stored(id), tenantVersion);
    const bot = {...proposed, ...identity, botToken: data.botToken as string};
    this.persistBot(bot);
    await this.wakeHub(this.stored(id), botId);
    return {bot: this.publicBot(bot)};
  }

  async updateBot(id: string, botId: string, input: TelegramBotUpdate): Promise<TelegramBot> {
    const data = record(input, 'INVALID_BOT');
    onlyKeys(data, ['name', 'enabled', 'botToken', 'expectedVersion'], 'INVALID_BOT');
    const before = this.storedBot(id, botId);
    this.checkBotVersion(before, expectedVersion(data.expectedVersion, 'INVALID_BOT'));
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') fail('INVALID_BOT', 'enabled must be a boolean.');
    const name = data.name === undefined ? before.name : tenantName(data.name, 'INVALID_BOT');
    const identity = data.botToken === undefined ? {telegramId: before.telegramId, username: before.username}
      : await this.validateBotToken(before, data.botToken as string);
    const current = this.storedBot(id, botId);
    this.checkBotVersion(current, before.version);
    if (identity.telegramId) this.checkBotIdentity(current, identity.telegramId);
    if (data.botToken !== undefined) {
      const tenantVersion = this.stored(id).version;
      await this.syncBotCommands(data.botToken as string);
      this.checkBotVersion(this.storedBot(id, botId), before.version);
      if (identity.telegramId) this.checkBotIdentity(current, identity.telegramId);
      this.checkVersion(this.stored(id), tenantVersion);
    }
    const currentSecret = this.botSecret(current);
    const bot: StoredBot = {...current, ...identity, name, enabled: data.enabled === undefined ? current.enabled : data.enabled as boolean,
      botToken: data.botToken === undefined ? current.botToken : data.botToken as string,
      webhookSecret: data.botToken === undefined ? current.webhookSecret : /^[A-Za-z0-9_-]{1,256}$/.test(currentSecret) ? currentSecret : randomSecret(),
      version: current.version + 1, updatedAt: new Date().toISOString()};
    this.persistBot(bot);
    await this.wakeHub(this.stored(id), botId);
    return this.publicBot(bot);
  }

  async configureBot(id: string, botToken: string, version?: number): Promise<Tenant> {
    const before = this.stored(id);
    this.checkVersion(before, expectedVersion(version));
    const bot = this.storedBot(id);
    // Keep the legacy endpoint's tenant version concurrency contract.
    let identity: {telegramId: string; username: string | null};
    try { identity = await this.validateBotToken(bot, botToken); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('BOT_CHANGE_REQUIRES_NEW_BOT:')) fail('BOT_CHANGE_REQUIRES_NEW_TENANT', 'Create a new bot entry when switching Telegram bot identity.');
      throw error;
    }
    this.checkVersion(this.stored(id), before.version);
    this.checkBotVersion(this.storedBot(id), bot.version);
    this.checkBotIdentity(bot, identity.telegramId);
    await this.syncBotCommands(botToken);
    this.checkVersion(this.stored(id), before.version);
    this.checkBotVersion(this.storedBot(id), bot.version);
    this.checkBotIdentity(bot, identity.telegramId);
    const secret = this.botSecret(bot);
    this.persistBot({...bot, ...identity, botToken, webhookSecret: /^[A-Za-z0-9_-]{1,256}$/.test(secret) ? secret : randomSecret(), version: bot.version + 1, updatedAt: new Date().toISOString()});
    await this.wakeHub(this.stored(id), 'default');
    return this.publicTenant(this.stored(id));
  }

  async getBotStatus(id: string, force = false, botId = 'default'): Promise<BotStatus> {
    const bot = this.storedBot(id, botId);
    const runtime = (await this.getRuntime(id, undefined, botId))!;
    const key = `${id}:${botId}`;
    const signature = `${runtime.version}:${bot.version}:${runtime.botToken}:${runtime.webhookSecret}`;
    const cached = this.statuses.get(key);
    if (!force && cached?.signature === signature && cached.expires > Date.now()) return clone(cached.status);
    const inFlight = this.statusRequests.get(key);
    if (inFlight?.signature === signature) return clone(await inFlight.promise);
    const request = this.loadBotStatus(runtime);
    this.statusRequests.set(key, {signature, promise: request});
    if (this.statusRequests.size > 256) this.statusRequests.delete(this.statusRequests.keys().next().value!);
    try {
      const status = await request;
      if (this.statusRequests.get(key)?.promise === request) {
        this.statuses.set(key, {signature, expires: Date.now() + 60_000, status});
        if (this.statuses.size > 256) this.statuses.delete(this.statuses.keys().next().value!);
      }
      return clone(status);
    } finally {
      if (this.statusRequests.get(key)?.promise === request) this.statusRequests.delete(key);
    }
  }

  private async loadBotStatus(runtime: TenantRuntime): Promise<BotStatus> {
    const status: BotStatus = {
      configured: {
        bot: !!runtime.botToken,
        webhookSecret: !!runtime.webhookSecret,
        apiKey: this.applications.list(runtime.id, runtime.selectedBotId).some(app => app.enabled && app.keyConfigured)
      },
      bot: null, webhook: null, checkedAt: new Date().toISOString(),
    };
    if (!runtime.botToken) return status;
    try {
      const [bot, webhook] = await Promise.all([
        telegramCall(runtime.botToken, 'getMe'),
        telegramCall(runtime.botToken, 'getWebhookInfo'),
      ]);
      if (!bot.result || bot.result.is_bot !== true || !Number.isSafeInteger(bot.result.id) || String(bot.result.id) !== runtime.botId) throw new Error('Invalid bot identity.');
      status.bot = this.redact(bot.result, runtime);
      status.webhook = this.redact(webhook.result, runtime);
    } catch {
      status.telegramError = 'Telegram status could not be loaded. Check the bot token and retry.';
    }
    return status;
  }

  private redact(value: Record<string, unknown>, runtime: TenantRuntime): Record<string, unknown> {
    const safe = (item: unknown): unknown => {
      if (typeof item === 'string') {
        let text = item;
        for (const secret of [runtime.botToken, runtime.webhookSecret, this.env.API_KEY]) if (secret) text = text.split(secret).join('[redacted]');
        return text;
      }
      if (Array.isArray(item)) return item.map(safe);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, safe(val)]));
      return item;
    };
    return safe(value) as Record<string, unknown>;
  }

  private validateUsage(revision: number, usage: TenantUsage): void {
    if (!Number.isSafeInteger(revision) || revision < 1 || !usage || !/^\d{4}-\d{2}-\d{2}$/.test(usage.day) ||
      [usage.notificationsToday, usage.activeSubscribers, usage.pendingDeliveries].some(value => !Number.isSafeInteger(value) || value < 0)) fail('INVALID_QUOTA', 'Invalid tenant quota snapshot.');
  }

  private quotaTotals(id: string, excludingBot?: string): TenantUsage {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const totals = this.ctx.storage.sql.exec<{notifications: number; subscribers: number; pending: number}>(`
      SELECT COALESCE(SUM(CASE WHEN json_extract(body,'$.day') = ? THEN json_extract(body,'$.notificationsToday') ELSE 0 END),0) AS notifications,
        COALESCE(SUM(json_extract(body,'$.activeSubscribers')),0) AS subscribers,
        COALESCE(SUM(json_extract(body,'$.pendingDeliveries')),0) AS pending
      FROM tenant_bot_usage WHERE tenant_id = ? AND (? IS NULL OR bot_id != ?)`, day, id, excludingBot ?? null, excludingBot ?? null).one();
    return {day, notificationsToday: totals.notifications, activeSubscribers: totals.subscribers, pendingDeliveries: totals.pending};
  }

  private storeUsage(id: string, botId: string, revision: number, usage: TenantUsage): void {
    this.ctx.storage.sql.exec(`INSERT INTO tenant_bot_usage(tenant_id,bot_id,revision,body) VALUES(?,?,?,?)
      ON CONFLICT(tenant_id,bot_id) DO UPDATE SET revision=excluded.revision,body=excluded.body`, id, botId, revision, JSON.stringify(usage));
  }

  async getTenantUsage(id: string): Promise<TenantUsage> {
    const tenant = this.stored(id);
    if (!this.ctx.storage.sql.exec('SELECT 1 FROM tenant_bot_usage WHERE tenant_id = ? AND bot_id = ?', id, 'default').toArray().length) {
      const hub = this.env.HUB.getByName(hubName(id));
      await hub.initializeTenant(id, tenant.name);
      const usage = await hub.getUsage();
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO tenant_bot_usage(tenant_id,bot_id,revision,body) VALUES(?,?,0,?)', id, 'default', JSON.stringify(usage));
    }
    return this.quotaTotals(id);
  }

  reserveQuota(id: string, botId: string, revision: number, actual: TenantUsage, requested: {notifications: number; subscribers: number; pending: number}): {maxPendingDeliveries: number} {
    const tenant = this.stored(id), bot = this.storedBot(id, botId);
    this.validateUsage(revision, actual);
    if (!requested || [requested.notifications, requested.subscribers, requested.pending].some(value => !Number.isSafeInteger(value) || value < 0)) fail('INVALID_QUOTA', 'Invalid tenant quota reservation.');
    if (requested.notifications > 0 || requested.subscribers > 0) {
      if (!tenant.enabled) fail('TENANT_DISABLED', 'Tenant is disabled.');
      if (!bot.enabled) fail('BOT_DISABLED', 'Telegram bot is disabled.');
    }
    const old = this.ctx.storage.sql.exec<{revision: number}>('SELECT revision FROM tenant_bot_usage WHERE tenant_id = ? AND bot_id = ?', id, botId).toArray()[0];
    if (old && old.revision >= revision) fail('STALE_QUOTA', 'A newer quota snapshot already exists.');
    const totals = this.quotaTotals(id, botId);
    const notificationsToday = actual.day === totals.day ? actual.notificationsToday : 0;
    if (requested.notifications > 0 && totals.notificationsToday + notificationsToday + requested.notifications > tenant.limits.notificationsPerDay) fail('TENANT_DAILY_LIMIT', 'Tenant daily notification limit reached across all bots.');
    if (requested.subscribers > 0 && totals.activeSubscribers + actual.activeSubscribers + requested.subscribers > tenant.limits.maxSubscribers) fail('SUBSCRIBER_LIMIT', 'Tenant subscriber limit reached across all bots.');
    const headroom = tenant.enabled && bot.enabled ? Math.max(0, tenant.limits.maxPendingDeliveries - totals.pendingDeliveries - actual.pendingDeliveries) : 0;
    const maxPendingDeliveries = actual.pendingDeliveries + Math.min(requested.pending, headroom);
    this.storeUsage(id, botId, revision, {day: totals.day, notificationsToday: notificationsToday + requested.notifications,
      activeSubscribers: actual.activeSubscribers + requested.subscribers, pendingDeliveries: maxPendingDeliveries});
    return {maxPendingDeliveries};
  }

  reportQuotaUsage(id: string, botId: string, revision: number, actual: TenantUsage): void {
    this.storedBot(id, botId);
    this.validateUsage(revision, actual);
    const old = this.ctx.storage.sql.exec<{revision: number}>('SELECT revision FROM tenant_bot_usage WHERE tenant_id = ? AND bot_id = ?', id, botId).toArray()[0];
    if (old && old.revision >= revision) return;
    this.storeUsage(id, botId, revision, actual);
  }

  /** Sync is explicit or configuration-time; normal notification and runtime reads never call Telegram. */
  async registerBotCommands(id: string, botId = 'default'): Promise<{ok: true; commands: TelegramBotCommand[]}> {
    const tenant = this.stored(id), before = this.storedBot(id, botId);
    if (!before.botToken) fail('BOT_NOT_CONFIGURED', 'Configure this Telegram bot before registering its commands.');
    await this.syncBotCommands(before.botToken);
    this.checkBotVersion(this.storedBot(id, botId), before.version);
    this.checkVersion(this.stored(id), tenant.version);
    return {ok: true, commands: TELEGRAM_BOT_COMMANDS.map(command => ({...command}))};
  }

  private async syncBotCommands(token: string): Promise<void> {
    try {
      // Persian-specific lists take precedence over fallback lists in Telegram clients.
      for (const language_code of ['', 'fa']) {
        const result = await telegramCall<boolean>(token, 'setMyCommands', {
          commands: TELEGRAM_BOT_COMMANDS, scope: {type: 'all_private_chats'}, language_code,
        });
        if (result.result !== true) throw new Error('Command registration was not confirmed.');
      }
      const menu = await telegramCall<boolean>(token, 'setChatMenuButton', {menu_button: {type: 'commands'}});
      if (menu.result !== true) throw new Error('Command menu was not confirmed.');
    } catch {
      fail('TELEGRAM_COMMANDS_SYNC_FAILED', 'Telegram could not confirm command menu registration. Retry command synchronization.');
    }
  }

  async registerWebhook(id: string, value: string, botId?: string): Promise<{ ok: true; url: string }> {
    const selectedBotId = botId ?? 'default';
    const invalidCode = botId === undefined ? 'INVALID_TENANT' : 'INVALID_WEBHOOK';
    const tenant = this.stored(id), before = this.storedBot(id, selectedBotId);
    if (!tenant.enabled) fail('TENANT_DISABLED', 'Enable the tenant before registering its webhook.');
    if (!before.enabled) fail('BOT_DISABLED', 'Enable the Telegram bot before registering its webhook.');
    const token = before.botToken, secret = this.botSecret(before);
    if (!token || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) fail('BOT_NOT_CONFIGURED', 'Configure the bot and webhook secret first.');
    let url: URL;
    try { url = new URL(value); }
    catch { fail(invalidCode, 'A public HTTPS webhook URL is required.'); }
    const paths = [`/telegram/${id}/bots/${selectedBotId}/webhook`, ...(selectedBotId === 'default' ? [`/telegram/${id}/webhook`, ...(id === 'default' ? ['/telegram/webhook'] : [])] : [])];
    if (url!.protocol !== 'https:' || url!.username || url!.password || url!.hash || url!.search || !paths.includes(url!.pathname)) fail(invalidCode, 'Use this bot’s public HTTPS webhook URL.');
    await this.syncBotCommands(token);
    let registrationFailed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.checkVersion(this.stored(id), tenant.version);
        this.checkBotVersion(this.storedBot(id, selectedBotId), before.version);
        const result = await telegramCall<boolean>(token, 'setWebhook', {url: url!.toString(), secret_token: secret,
          allowed_updates: ['message', 'my_chat_member', 'callback_query'], drop_pending_updates: false});
        if (result.result !== true) fail('TELEGRAM_UNAVAILABLE', 'Telegram did not confirm webhook registration.');
        this.persistBot({...before, version: before.version + 1, updatedAt: new Date().toISOString()});
      } catch { registrationFailed = true; }
    });
    if (registrationFailed) fail('TELEGRAM_UNAVAILABLE', 'Telegram could not register the webhook. Check configuration and retry.');
    await this.wakeHub(this.stored(id), selectedBotId);
    return {ok: true, url: url!.toString()};
  }
}
