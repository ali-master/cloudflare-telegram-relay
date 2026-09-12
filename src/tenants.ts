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
  TenantUpdate
} from './types';
import {DEFAULT_SETTINGS, DEFAULT_TENANT_LIMITS, hubName} from './types';
import {telegramCall, TelegramError} from './telegram';
import {applicationAudience, ApplicationStore} from './applications';
import {LoginAuditStore} from './login-audit';

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

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_TENANT', 'A JSON object is required.');
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_TENANT', 'An unsupported tenant field was supplied.');
}

function tenantId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,47}$/.test(value)) fail('INVALID_TENANT', 'Tenant IDs must contain 2–48 lowercase URL-safe characters.');
  return value;
}

function tenantName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail('INVALID_TENANT', 'Tenant names must contain 1–80 characters.');
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

function expectedVersion(value: unknown): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1)) fail('INVALID_TENANT', 'expectedVersion must be a positive integer.');
  return value as number | undefined;
}

function tokenIdentity(token: string): string | null {
  const prefix = /^([1-9][0-9]*):/.exec(token)?.[1];
  return prefix && Number.isSafeInteger(Number(prefix)) ? prefix : null;
}

/** The registry loads its bounded table once; tenant/runtime reads never query SQLite. */
export class TenantRegistry extends DurableObject<Env> {
  private readonly applications: ApplicationStore;
  private readonly loginAudit: LoginAuditStore;
  private readonly tenants = new Map<string, StoredTenant>();
  private readonly statuses = new Map<string, StatusEntry>();
  private readonly statusRequests = new Map<string, { signature: string; promise: Promise<BotStatus> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.applications = new ApplicationStore(ctx.storage.sql);
    this.loginAudit = new LoginAuditStore(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
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
      }
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
    this.loginAudit.cleanup();
    const next = this.loginAudit.nextCleanupAt();
    if (next !== null) await this.ctx.storage.setAlarm(next);
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
    this.statuses.delete(next.id);
    this.statusRequests.delete(next.id);
  }

  private changed(current: StoredTenant, patch: Partial<StoredTenant>): StoredTenant {
    return {...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString()};
  }

  private async wakeHub(tenant: StoredTenant): Promise<void> {
    const hub = this.env.HUB.getByName(hubName(tenant.id));
    await hub.initializeTenant(tenant.id, tenant.name);
    await hub.refreshApplicationAccess(this.applications.list(tenant.id));
    await hub.wake();
  }

  private async validateApplicationAudience(tenant: StoredTenant, chatIds: string[]): Promise<void> {
    const hub = this.env.HUB.getByName(hubName(tenant.id));
    await hub.initializeTenant(tenant.id, tenant.name);
    await hub.validateApplicationAudience(chatIds);
  }

  async listTenants(): Promise<Tenant[]> {
    return [...this.tenants.values()].sort((a, b) => a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(tenant => this.publicTenant(tenant));
  }

  async getTenant(id: string): Promise<Tenant | null> {
    const tenant = this.tenants.get(tenantId(id));
    return tenant ? this.publicTenant(tenant) : null;
  }

  async getRuntime(id: string, knownApplicationRevision?: string): Promise<TenantRuntime | null> {
    const tenant = this.tenants.get(tenantId(id));
    if (!tenant) return null;
    const applicationRevision = this.applications.revision(id);
    return {
      ...this.publicTenant(tenant),
      botToken: this.token(tenant),
      webhookSecret: this.secret(tenant),
      applicationRevision,
      ...(knownApplicationRevision === applicationRevision ? {} : {applications: this.applications.list(id)})
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
    await this.wakeHub(next);
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

  async listApplications(tenantId: string): Promise<Application[]> {
    this.stored(tenantId);
    return this.applications.list(tenantId);
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
    const next = {...input, ...audience};
    if (audience.audienceMode === 'selected') await this.validateApplicationAudience(tenant, audience.audienceChatIds);
    const result = await this.applications.create(tenantId, next);
    this.statuses.delete(tenantId);
    this.statusRequests.delete(tenantId);
    await this.wakeHub(this.stored(tenantId));
    return result;
  }

  async updateApplication(tenantId: string, id: string, input: ApplicationUpdate): Promise<Application> {
    const tenant = this.stored(tenantId);
    const audience = applicationAudience(input, true);
    const current = this.applications.get(tenantId, id);
    if (!current) fail('APPLICATION_NOT_FOUND', 'Application does not exist.');
    const next = {
      ...input, ...audience,
      expectedVersion: input.expectedVersion === undefined ? current.version : input.expectedVersion
    };
    if (audience?.audienceMode === 'selected') await this.validateApplicationAudience(tenant, audience.audienceChatIds);
    const result = this.applications.update(tenantId, id, next);
    this.statuses.delete(tenantId);
    this.statusRequests.delete(tenantId);
    await this.wakeHub(this.stored(tenantId));
    return result;
  }

  async rotateApplicationKey(tenantId: string, id: string, version?: number): Promise<{
    application: Application;
    apiKey: string
  }> {
    this.stored(tenantId);
    const result = await this.applications.rotateKey(tenantId, id, version);
    this.statuses.delete(tenantId);
    this.statusRequests.delete(tenantId);
    await this.wakeHub(this.stored(tenantId));
    return result;
  }

  async verifyApplicationKey(tenantId: string, key: string): Promise<Application | null> {
    if (!this.stored(tenantId).enabled) return null;
    const result = await this.applications.verifyKey(tenantId, key);
    return this.stored(tenantId).enabled ? result : null;
  }

  private checkBotIdentity(tenant: StoredTenant, botId: string): void {
    const assigned = tenant.botId ?? tokenIdentity(this.token(tenant));
    if (assigned && assigned !== botId) fail('BOT_CHANGE_REQUIRES_NEW_TENANT', 'Create a new tenant when switching Telegram bot identity.');
    for (const other of this.tenants.values()) {
      if (other.id !== tenant.id && (other.botId ?? tokenIdentity(this.token(other))) === botId) fail('BOT_ALREADY_ASSIGNED', 'This Telegram bot already belongs to another tenant.');
    }
  }

  async configureBot(id: string, botToken: string, version?: number): Promise<Tenant> {
    const before = this.stored(id);
    this.checkVersion(before, expectedVersion(version));
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
    const current = this.stored(id);
    this.checkVersion(current, before.version);
    this.checkBotIdentity(current, inferredId);
    const existingSecret = this.secret(current);
    const webhookSecret = /^[A-Za-z0-9_-]{1,256}$/.test(existingSecret) ? existingSecret : randomSecret();
    const next = this.changed(current, {
      botToken, webhookSecret, botId: inferredId,
      botUsername: typeof bot!.username === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(bot!.username) ? bot!.username : null,
    });
    this.commit(next);
    await this.wakeHub(next);
    return this.publicTenant(next);
  }

  async getBotStatus(id: string, force = false): Promise<BotStatus> {
    const current = this.stored(id);
    const runtime: TenantRuntime = {
      ...this.publicTenant(current),
      botToken: this.token(current),
      webhookSecret: this.secret(current),
      applicationRevision: this.applications.revision(id),
      applications: this.applications.list(id)
    };
    const signature = `${current.version}:${runtime.botToken}:${runtime.webhookSecret}`;
    const cached = this.statuses.get(id);
    if (!force && cached?.signature === signature && cached.expires > Date.now()) return clone(cached.status);
    const inFlight = this.statusRequests.get(id);
    if (inFlight?.signature === signature) return clone(await inFlight.promise);
    const request = this.loadBotStatus(runtime);
    this.statusRequests.set(id, {signature, promise: request});
    try {
      const status = await request;
      // A slow network request must not repopulate cache after token/key/settings mutation.
      if (this.statusRequests.get(id)?.promise === request) {
        this.statuses.set(id, {signature, expires: Date.now() + 60_000, status});
      }
      return clone(status);
    } finally {
      if (this.statusRequests.get(id)?.promise === request) this.statusRequests.delete(id);
    }
  }

  private async loadBotStatus(runtime: TenantRuntime): Promise<BotStatus> {
    const status: BotStatus = {
      configured: {
        bot: !!runtime.botToken,
        webhookSecret: !!runtime.webhookSecret,
        apiKey: this.applications.list(runtime.id).some(app => app.enabled && app.keyConfigured)
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

  async registerWebhook(id: string, value: string): Promise<{ ok: true; url: string }> {
    const before = this.stored(id);
    if (!before.enabled) fail('TENANT_DISABLED', 'Enable the tenant before registering its webhook.');
    const token = this.token(before), secret = this.secret(before);
    if (!token || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) fail('BOT_NOT_CONFIGURED', 'Configure the tenant bot and webhook secret first.');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail('INVALID_TENANT', 'A public HTTPS webhook URL is required.');
    }
    if (url!.protocol !== 'https:' || url!.username || url!.password || url!.hash || url!.search ||
      ![`/telegram/${id}/webhook`, ...(id === 'default' ? ['/telegram/webhook'] : [])].includes(url!.pathname)) {
      fail('INVALID_TENANT', 'Use this tenant’s public HTTPS webhook URL.');
    }
    // Token/config updates must finish before webhook registration starts, and vice versa.
    let registrationFailed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.checkVersion(this.stored(id), before.version);
        const result = await telegramCall<boolean>(token, 'setWebhook', {
          url: url!.toString(),
          secret_token: secret,
          allowed_updates: ['message', 'my_chat_member', 'callback_query'],
          drop_pending_updates: false,
        });
        if (result.result !== true) fail('TELEGRAM_UNAVAILABLE', 'Telegram did not confirm webhook registration.');
        const next = this.changed(this.stored(id), {});
        this.commit(next);
      } catch {
        registrationFailed = true;
      }
    });
    // Expected network failures must not escape blockConcurrencyWhile and reset this object.
    if (registrationFailed) fail('TELEGRAM_UNAVAILABLE', 'Telegram could not register the webhook. Check configuration and retry.');
    await this.wakeHub(this.stored(id));
    return {ok: true, url: url!.toString()};
  }
}
