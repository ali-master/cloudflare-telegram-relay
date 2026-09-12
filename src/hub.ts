import {DurableObject} from 'cloudflare:workers';
import type {
  Env,
  NotificationInput,
  NotificationRecord,
  Overview,
  Page,
  Settings,
  SourceContext,
  Subscriber,
  TenantRuntime,
  TenantUsage,
  Application
} from './types';
import {AppError, DEFAULT_SETTINGS, LEVELS} from './types';
import {formatNotification, telegramCall, TelegramError} from './telegram';

type Row = Record<string, SqlStorageValue>;

interface NotificationRow extends Row {
  id: string;
  input: string;
  source: string;
  created_at: number;
  fingerprint: string
}

interface DeliveryRow extends Row {
  id: number;
  notification_id: string | null;
  chat_id: string;
  status: string;
  attempts: number;
  stage_attempts: number;
  stage: number;
  rendered: string;
  image: string | null;
  silent: number;
  error: string | null;
  next_attempt: number;
  updated_at: number;
  system_payload: string | null;
  application_id: string | null;
}

const PAGE_SIZE = 20;
const MAX_ATTEMPTS = 5;
const DAY = 86_400_000;
const CACHE_TTL = 30_000;
const CACHE_ENTRIES = 64;
const CLEANUP_INTERVAL = 60_000;

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJSON(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** One object coordinates this bot's subscriptions, fan-out and global Telegram rate. */
export class NotificationHub extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private tenantId: string | null = null;
  private lastCleanupAt = -Infinity;
  private wakeEpoch = 0;
  private readonly readCache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly rateCounters = new Map<string, {count: number; expiresAt: number}>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      const legacyDatabase = this.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").length > 0;
      this.sql.exec(`
          CREATE TABLE IF NOT EXISTS settings
          (
              id
              INTEGER
              PRIMARY
              KEY
              CHECK
          (
              id =
              1
          ), body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS subscribers
          (
              chat_id
              TEXT
              PRIMARY
              KEY,
              first_name
              TEXT
              NOT
              NULL,
              username
              TEXT,
              active
              INTEGER
              NOT
              NULL
              DEFAULT
              1,
              joined_at
              INTEGER
              NOT
              NULL,
              updated_at
              INTEGER
              NOT
              NULL,
              next_send_at
              INTEGER
              NOT
              NULL
              DEFAULT
              0
          );
          CREATE TABLE IF NOT EXISTS notifications
          (
              id
              TEXT
              PRIMARY
              KEY,
              input
              TEXT
              NOT
              NULL,
              source
              TEXT
              NOT
              NULL,
              created_at
              INTEGER
              NOT
              NULL,
              idempotency_key
              TEXT
              UNIQUE,
              fingerprint
              TEXT
              NOT
              NULL,
              purging
              INTEGER
              NOT
              NULL
              DEFAULT
              0
          );
          CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at DESC);
          CREATE TABLE IF NOT EXISTS deliveries
          (
              id
              INTEGER
              PRIMARY
              KEY
              AUTOINCREMENT,
              notification_id
              TEXT
              REFERENCES
              notifications
          (
              id
          ) ON DELETE CASCADE,
              chat_id TEXT NOT NULL REFERENCES subscribers
          (
              chat_id
          ), status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0, stage_attempts INTEGER NOT NULL DEFAULT 0, stage INTEGER NOT NULL DEFAULT 0,
              rendered TEXT NOT NULL, image TEXT, silent INTEGER NOT NULL DEFAULT 0,
              next_attempt INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, error TEXT,
              UNIQUE
          (
              notification_id,
              chat_id
          )
              );
          CREATE INDEX IF NOT EXISTS deliveries_queue ON deliveries(status, next_attempt, id);
          CREATE INDEX IF NOT EXISTS deliveries_notification ON deliveries(notification_id, status);
          CREATE TABLE IF NOT EXISTS rate_limits
          (
              key
              TEXT
              PRIMARY
              KEY,
              count
              INTEGER
              NOT
              NULL,
              expires_at
              INTEGER
              NOT
              NULL
          );
          CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
          CREATE TABLE IF NOT EXISTS telegram_updates
          (
              id
              INTEGER
              PRIMARY
              KEY,
              received_at
              INTEGER
              NOT
              NULL
          );
          CREATE INDEX IF NOT EXISTS telegram_updates_age ON telegram_updates(received_at);
          CREATE TABLE IF NOT EXISTS queue_state
          (
              key
              TEXT
              PRIMARY
              KEY,
              value
              INTEGER
              NOT
              NULL
          );
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS tenant_identity (id INTEGER PRIMARY KEY CHECK(id = 1), tenant_id TEXT);
        CREATE TABLE IF NOT EXISTS daily_usage (day TEXT PRIMARY KEY, notifications INTEGER NOT NULL DEFAULT 0);
      `);
      this.sql.exec('INSERT OR IGNORE INTO tenant_identity (id, tenant_id) VALUES (1, ?)', legacyDatabase ? 'default' : null);
      const storedTenant = this.rows('SELECT tenant_id FROM tenant_identity WHERE id = 1')[0].tenant_id;
      this.tenantId = typeof storedTenant === 'string' ? storedTenant : null;
      // Upgrade existing local/deployed databases without discarding their queued work.
      if (!this.rows('PRAGMA table_info(notifications)').some((column) => column.name === 'purging')) {
        this.sql.exec('ALTER TABLE notifications ADD COLUMN purging INTEGER NOT NULL DEFAULT 0');
      }
      const subscriberColumns = this.rows('PRAGMA table_info(subscribers)');
      if (!subscriberColumns.some((column) => column.name === 'banned')) this.sql.exec('ALTER TABLE subscribers ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
      if (!subscriberColumns.some((column) => column.name === 'ban_reason')) this.sql.exec('ALTER TABLE subscribers ADD COLUMN ban_reason TEXT');
      if (!subscriberColumns.some((column) => column.name === 'application_mode')) this.sql.exec("ALTER TABLE subscribers ADD COLUMN application_mode TEXT NOT NULL DEFAULT 'all'");
      if (!this.rows('PRAGMA table_info(deliveries)').some((column) => column.name === 'system_payload')) this.sql.exec('ALTER TABLE deliveries ADD COLUMN system_payload TEXT');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS subscriber_applications (
        chat_id TEXT NOT NULL REFERENCES subscribers(chat_id) ON DELETE CASCADE,
        application_id TEXT NOT NULL, PRIMARY KEY(chat_id, application_id)
      )`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS notifications_visible_created ON notifications(purging, created_at DESC)');
      this.sql.exec('INSERT OR IGNORE INTO settings (id, body) VALUES (1, ?)', JSON.stringify(DEFAULT_SETTINGS));
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(String(this.rows('SELECT body FROM settings WHERE id = 1')[0].body)) };
      this.lastCleanupAt = Number(this.rows("SELECT value FROM queue_state WHERE key = 'last_cleanup_at'")[0]?.value ?? -Infinity);
      const today = new Date(Date.now()).toISOString().slice(0, 10);
      this.sql.exec('INSERT OR IGNORE INTO daily_usage (day, notifications) SELECT ?, COUNT(*) FROM notifications WHERE created_at >= ?', today, Date.parse(`${today}T00:00:00.000Z`));
      // A persisted network attempt cannot be safely repeated after an isolate restart.
      this.recoverInterrupted();
      const alarm = await ctx.storage.getAlarm();
      if (alarm === null && (this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status = 'pending'") || this.count('SELECT COUNT(*) AS count FROM notifications'))) {
        await ctx.storage.setAlarm(Date.now() + 1_000);
      }
    });
  }

  private rows<T extends Row = Row>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }

  private count(query: string, ...bindings: SqlStorageValue[]): number {
    return Number(this.rows(query, ...bindings)[0]?.count ?? 0);
  }

  private cached<T>(key: string, read: () => T): T {
    const cached = this.readCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.value) as T;
    this.readCache.delete(key);
    const value = read();
    if (this.readCache.size >= CACHE_ENTRIES) this.readCache.delete(this.readCache.keys().next().value!);
    this.readCache.set(key, { expiresAt: Date.now() + CACHE_TTL, value });
    return structuredClone(value);
  }

  private invalidate(): void { this.readCache.clear(); }

  async initializeTenant(id: string, name?: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new AppError(400, 'TENANT_DISABLED', 'TENANT_DISABLED: Invalid tenant identity.');
    if (this.tenantId !== null) {
      if (this.tenantId !== id) throw new AppError(409, 'TENANT_DISABLED', 'TENANT_DISABLED: This hub already belongs to a different tenant.');
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE tenant_identity SET tenant_id = ? WHERE id = 1', id);
      if (name) {
        this.settings = { ...this.settings, projectName: name.slice(0, 80) };
        this.sql.exec('UPDATE settings SET body = ? WHERE id = 1', JSON.stringify(this.settings));
      }
    });
    this.tenantId = id;
    this.invalidate();
  }

  async wake(): Promise<void> {
    // Registry mutations call this method; it must never call back into the registry.
    this.wakeEpoch++;
    await this.ensureAlarm(Date.now() + 100);
  }

  private async runtime(): Promise<TenantRuntime> {
    if (!this.tenantId || !this.env.TENANTS) throw new AppError(403, 'TENANT_DISABLED', 'TENANT_DISABLED: Tenant is unavailable.');
    const runtime = await this.env.TENANTS.getByName('registry').getRuntime(this.tenantId);
    if (!runtime || runtime.id !== this.tenantId) throw new AppError(403, 'TENANT_DISABLED', 'TENANT_DISABLED: Tenant is unavailable.');
    return runtime;
  }

  getUsage(): TenantUsage {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    return this.cached(`usage:${day}`, () => ({
      day,
      notificationsToday: Number(this.rows('SELECT notifications FROM daily_usage WHERE day = ?', day)[0]?.notifications ?? 0),
      activeSubscribers: this.count('SELECT COUNT(*) AS count FROM subscribers WHERE active = 1 AND banned = 0'),
      // Welcome messages share the same durable queue and therefore also consume capacity.
      pendingDeliveries: this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending', 'sending')"),
    }));
  }

  getSettings(): Settings {
    return structuredClone(this.settings);
  }

  setSubscriberBan(chatIds: string[], banned: boolean, reason?: string): {updated: number} {
    if (!Array.isArray(chatIds) || chatIds.length < 1 || chatIds.length > 100 || chatIds.some((id) => typeof id !== 'string' || !/^-?\d{1,20}$/.test(id)) || typeof banned !== 'boolean') {
      throw new AppError(400, 'INVALID_BAN', 'Select between 1 and 100 valid subscriber IDs.');
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) throw new AppError(400, 'INVALID_BAN', 'The ban reason must contain at most 200 characters.');
    const now = Date.now();
    const updated = this.ctx.storage.transactionSync(() => {
      let count = 0;
      for (const id of new Set(chatIds)) {
        if (!this.rows('SELECT chat_id FROM subscribers WHERE chat_id = ?', id).length) continue;
        this.sql.exec('UPDATE subscribers SET banned = ?, ban_reason = ?, active = CASE WHEN ? = 1 THEN 0 ELSE active END, updated_at = ? WHERE chat_id = ?', banned ? 1 : 0, banned ? reason?.trim() || null : null, banned ? 1 : 0, now, id);
        if (banned) this.sql.exec("UPDATE deliveries SET status = 'skipped', error = 'Subscriber was banned.', updated_at = ? WHERE chat_id = ? AND status = 'pending'", now, id);
        count++;
      }
      return count;
    });
    this.invalidate();
    return {updated};
  }

  async updateSettings(settings: Settings): Promise<Settings> {
    await this.ctx.storage.transaction(async () => {
      // The settings and their wakeup commit together, including after an isolate crash.
      if (!settings.paused) await this.ensureAlarm(Date.now() + 100);
      this.sql.exec('UPDATE settings SET body = ? WHERE id = 1', JSON.stringify(settings));
      this.settings = structuredClone(settings);
      this.invalidate();
    });
    return this.getSettings();
  }

  rateLimit(key: string, limit: number, windowSeconds: number): boolean {
    const now = Date.now();
    let counter = this.rateCounters.get(key);
    if (!counter) {
      const row = this.rows('SELECT count, expires_at FROM rate_limits WHERE key = ?', key)[0];
      if (row) counter = {count: Number(row.count), expiresAt: Number(row.expires_at)};
    }
    if (!counter || counter.expiresAt <= now) {
      this.sql.exec('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < ? LIMIT 100)', now);
      this.sql.exec('INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, expires_at = excluded.expires_at', key, now + windowSeconds * 1_000);
      this.cacheRateCounter(key, {count: 1, expiresAt: now + windowSeconds * 1_000});
      return true;
    }
    this.cacheRateCounter(key, counter);
    if (counter.count >= limit) return false;
    this.sql.exec('UPDATE rate_limits SET count = count + 1 WHERE key = ?', key);
    counter.count++;
    return true;
  }

  private cacheRateCounter(key: string, counter: {count: number; expiresAt: number}): void {
    if (!this.rateCounters.has(key) && this.rateCounters.size >= 256) this.rateCounters.delete(this.rateCounters.keys().next().value!);
    this.rateCounters.set(key, counter);
  }

  async enqueue(input: NotificationInput, source: SourceContext, idempotencyKey?: string, requestFingerprint?: string): Promise<{
    notification: NotificationRecord;
    duplicate: boolean
  }> {
    const runtime = await this.runtime();
    if (!runtime.enabled) throw new AppError(403, 'TENANT_DISABLED', 'TENANT_DISABLED: This tenant is disabled.');
    if (!runtime.botToken) throw new AppError(503, 'BOT_NOT_CONFIGURED', 'BOT_NOT_CONFIGURED: This tenant has no bot credentials.');
    const fingerprint = requestFingerprint ?? stableJSON(input);
    this.cleanup();
    const outcome = await this.ctx.storage.transaction(async () => {
      // Alarm and fan-out commit atomically, so an accepted job always has a wakeup.
      await this.ensureAlarm(Date.now() + 100);
      if (idempotencyKey) {
        const existing = this.rows<NotificationRow>('SELECT * FROM notifications WHERE idempotency_key = ? AND purging = 0', idempotencyKey)[0];
        if (existing) {
          if (existing.fingerprint !== fingerprint) return {error: new AppError(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT: This idempotency key was already used for a different notification.')};
          return {notification: this.toNotification(existing), duplicate: true};
        }
      }
      const now = Date.now();
      const id = crypto.randomUUID();
      const settings = this.getSettings();
      const rendered = formatNotification(input, source, settings.showCountryFlag);
      if (rendered.length > 4_000) return {error: new AppError(400, 'MESSAGE_TOO_LONG', 'The formatted notification must contain at most 4000 characters.')};
      const day = new Date(now).toISOString().slice(0, 10);
      const used = Number(this.rows('SELECT notifications FROM daily_usage WHERE day = ?', day)[0]?.notifications ?? 0);
      if (used >= runtime.limits.notificationsPerDay) return { error: new AppError(429, 'DAILY_LIMIT', 'DAILY_LIMIT: The daily notification quota has been reached.') };
      const recipients = this.count(`SELECT COUNT(*) AS count FROM subscribers s WHERE active = 1 AND banned = 0 AND (
        application_mode = 'all' OR EXISTS (SELECT 1 FROM subscriber_applications p WHERE p.chat_id = s.chat_id AND p.application_id = ?)
      )`, input.applicationId ?? null);
      const pending = this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending', 'sending')");
      if (pending + recipients > runtime.limits.maxPendingDeliveries) return { error: new AppError(429, 'QUEUE_LIMIT', 'QUEUE_LIMIT: There is not enough capacity for this notification in the delivery queue.') };
      this.sql.exec('INSERT INTO daily_usage (day, notifications) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET notifications = notifications + 1', day);
      this.sql.exec('INSERT INTO notifications (id, input, source, created_at, idempotency_key, fingerprint) VALUES (?, ?, ?, ?, ?, ?)', id, JSON.stringify(input), JSON.stringify(source), now, idempotencyKey ?? null, fingerprint);
      // INSERT SELECT gives the notification one atomic snapshot of active subscribers.
      this.sql.exec(`INSERT INTO deliveries (notification_id, chat_id, rendered, image, silent, updated_at)
                     SELECT ?, chat_id, ?, ?, ?, ?
                     FROM subscribers s
                     WHERE active = 1 AND banned = 0 AND (application_mode = 'all' OR EXISTS (
                       SELECT 1 FROM subscriber_applications p WHERE p.chat_id = s.chat_id AND p.application_id = ?
                     ))`, id, rendered, input.image ?? null, input.silent ? 1 : 0, now, input.applicationId ?? null);
      this.invalidate();
      return {
        notification: this.toNotification(this.rows<NotificationRow>('SELECT * FROM notifications WHERE id = ?', id)[0]),
        duplicate: false
      };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome;
  }

  private toNotification(row: NotificationRow): NotificationRecord {
    const counts = Object.fromEntries(this.rows('SELECT status, COUNT(*) AS count FROM deliveries WHERE notification_id = ? GROUP BY status', row.id).map((entry) => [String(entry.status), Number(entry.count)]));
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const pending = (counts.pending ?? 0) + (counts.sending ?? 0);
    const sent = counts.sent ?? 0;
    const failed = counts.failed ?? 0;
    const photoDelivered = this.count('SELECT COUNT(*) AS count FROM deliveries WHERE notification_id = ? AND stage > 0', row.id) > 0;
    let status: NotificationRecord['status'];
    if (!total) status = 'empty';
    else if (pending) status = counts.sending || pending !== total || photoDelivered ? 'sending' : 'queued';
    else if (sent === total) status = 'completed';
    else if (failed === total && !photoDelivered) status = 'failed';
    else status = 'partial';
    return {
      ...JSON.parse(row.input) as NotificationInput,
      id: row.id,
      source: JSON.parse(row.source),
      createdAt: new Date(row.created_at).toISOString(),
      status,
      total,
      sent,
      failed,
      pending,
      unknown: counts.unknown ?? 0,
      skipped: counts.skipped ?? 0
    };
  }

  listNotifications(page: number, level?: string, search?: string, applicationId?: string): Page<NotificationRecord> {
    return this.cached(`notifications:${JSON.stringify([page, level, search, applicationId])}`, () => this.readNotifications(page, level, search, applicationId));
  }

  private readNotifications(page: number, level?: string, search?: string, applicationId?: string): Page<NotificationRecord> {
    page = Math.max(1, Math.floor(page || 1));
    const conditions: string[] = ['purging = 0'];
    const bindings: SqlStorageValue[] = [];
    if (applicationId) {
      conditions.push("json_extract(input, '$.applicationId') = ?");
      bindings.push(applicationId);
    }
    if (level) {
      conditions.push("json_extract(input, '$.level') = ?");
      bindings.push(level);
    }
    if (search) {
      conditions.push("(instr(lower(json_extract(input, '$.application')), lower(?)) > 0 OR instr(lower(json_extract(input, '$.event')), lower(?)) > 0 OR instr(lower(json_extract(input, '$.text')), lower(?)) > 0)");
      bindings.push(search, search, search);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const total = this.count(`SELECT COUNT(*) AS count
                              FROM notifications ${where}`, ...bindings);
    return {
      items: this.rows<NotificationRow>(`SELECT *
                                         FROM notifications${where}
                                         ORDER BY created_at DESC, id DESC LIMIT ?
                                         OFFSET ?`, ...bindings, PAGE_SIZE, (page - 1) * PAGE_SIZE).map((row) => this.toNotification(row)),
      total,
      page,
      pageSize: PAGE_SIZE
    };
  }

  getNotification(id: string) {
    return this.cached(`notification:${id}`, () => this.readNotification(id));
  }

  private readNotification(id: string): {
    notification: NotificationRecord;
    deliveryTotal: number;
    deliveries: Array<{
      chatId: string;
      status: string;
      attempts: number;
      error: string | null;
      stage: number;
      partial: boolean
    }>
  } | null {
    const row = this.rows<NotificationRow>('SELECT * FROM notifications WHERE id = ? AND purging = 0', id)[0];
    if (!row) return null;
    const notification = this.toNotification(row);
    return {
      notification, deliveryTotal: notification.total,
      deliveries: this.rows<DeliveryRow>('SELECT * FROM deliveries WHERE notification_id = ? ORDER BY id LIMIT 100', id).map((entry) => ({
        chatId: entry.chat_id,
        status: entry.status,
        attempts: entry.attempts,
        error: entry.error,
        stage: entry.stage,
        partial: entry.stage > 0 && entry.status !== 'sent'
      })),
    };
  }

  listSubscribers(page: number): Page<Subscriber> {
    return this.cached(`subscribers:${page}`, () => this.readSubscribers(page));
  }

  private readSubscribers(page: number): Page<Subscriber> {
    page = Math.max(1, Math.floor(page || 1));
    return {
      items: this.rows('SELECT * FROM subscribers ORDER BY joined_at DESC, chat_id LIMIT ? OFFSET ?', PAGE_SIZE, (page - 1) * PAGE_SIZE).map((row) => ({
        chatId: String(row.chat_id),
        firstName: String(row.first_name),
        username: row.username === null ? null : String(row.username),
        active: row.active === 1,
        banned: row.banned === 1,
        banReason: row.ban_reason === null ? null : String(row.ban_reason),
        applicationMode: row.application_mode === 'selected' ? 'selected' as const : 'all' as const,
        applicationIds: this.rows('SELECT application_id FROM subscriber_applications WHERE chat_id = ? ORDER BY application_id', row.chat_id).map((entry) => String(entry.application_id)),
        joinedAt: new Date(Number(row.joined_at)).toISOString(),
        updatedAt: new Date(Number(row.updated_at)).toISOString()
      })),
      total: this.count('SELECT COUNT(*) AS count FROM subscribers'), page, pageSize: PAGE_SIZE,
    };
  }

  getOverview(): Overview {
    return this.cached(`overview:${new Date(Date.now()).toISOString().slice(0, 10)}`, () => this.readOverview());
  }

  private readOverview(): Overview {
    const now = new Date(Date.now());
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const counts = Object.fromEntries(this.rows(`SELECT d.status, COUNT(*) AS count
                                                 FROM deliveries d
                                                     JOIN notifications n
                                                 ON n.id = d.notification_id
                                                 WHERE n.purging = 0
                                                 GROUP BY d.status`).map((entry) => [String(entry.status), Number(entry.count)]));
    const dailyRows = this.rows(`SELECT strftime('%Y-%m-%d', d.updated_at / 1000, 'unixepoch') AS date,
      SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed
                                 FROM deliveries d JOIN notifications n
                                 ON n.id = d.notification_id
                                 WHERE n.purging = 0 AND d.updated_at >= ?
                                 GROUP BY date`, today - 6 * DAY);
    return {
      subscribers: {
        total: this.count('SELECT COUNT(*) AS count FROM subscribers'),
        active: this.count('SELECT COUNT(*) AS count FROM subscribers WHERE active = 1 AND banned = 0')
      },
      notifications: {
        total: this.count('SELECT COUNT(*) AS count FROM notifications WHERE purging = 0'),
        today: this.count('SELECT COUNT(*) AS count FROM notifications WHERE purging = 0 AND created_at >= ?', today)
      },
      deliveries: {
        sent: counts.sent ?? 0,
        failed: counts.failed ?? 0,
        pending: (counts.pending ?? 0) + (counts.sending ?? 0),
        unknown: counts.unknown ?? 0,
        skipped: counts.skipped ?? 0
      },
      daily: Array.from({length: 7}, (_, index) => {
        const date = new Date(today - (6 - index) * DAY).toISOString().slice(0, 10);
        const row = dailyRows.find((entry) => entry.date === date);
        return {date, sent: Number(row?.sent ?? 0), failed: Number(row?.failed ?? 0)};
      }),
      levels: LEVELS.map((level) => ({
        level,
        count: this.count("SELECT COUNT(*) AS count FROM notifications WHERE purging = 0 AND json_extract(input, '$.level') = ?", level)
      })),
      recent: this.listNotifications(1).items.slice(0, 6),
    };
  }

  async handleUpdate(update: unknown): Promise<void> {
    if (!update || typeof update !== 'object') return;
    const value = update as Record<string, unknown>;
    if (!Number.isSafeInteger(value.update_id)) return;
    const runtime = await this.runtime();
    const callback = value.callback_query as {
      id?: unknown; data?: unknown; from?: {id?: unknown};
      message?: {message_id?: unknown; chat?: {id?: unknown; type?: string}};
    } | undefined;
    const ownsCallback = callback?.message?.chat?.type === 'private' &&
      Number.isSafeInteger(callback.message.chat.id) && callback.from?.id === callback.message.chat.id &&
      Number.isSafeInteger(callback.message.message_id) && Number(callback.message.message_id) > 0 &&
      typeof callback.id === 'string' && callback.id.length <= 256 && typeof callback.data === 'string';
    const messageText = (value.message as {text?: unknown} | undefined)?.text;
    const preferencesCommand = typeof messageText === 'string' && /^\/(apps|all)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(messageText);
    const applications = runtime.enabled && (ownsCallback || preferencesCommand)
      ? (await this.env.TENANTS.getByName('registry').listApplications(runtime.id)).filter((app) => app.enabled)
      : [];
    let acknowledge = false;
    let acknowledgement = 'تنظیمات دریافت اعلان ذخیره شد.';
    const outcome = await this.ctx.storage.transaction(async () => {
      // Membership changes, update deduplication and wakeup commit as one unit.
      await this.ensureAlarm(Date.now() + 100);
      const updateId = value.update_id as number;
      if (this.rows('SELECT id FROM telegram_updates WHERE id = ?', updateId).length) return;
      const now = Date.now();
      this.sql.exec('INSERT INTO telegram_updates (id, received_at) VALUES (?, ?)', updateId, now);
      if (ownsCallback && callback) {
        if (!runtime.enabled) return;
        const chatId = String(callback.message!.chat!.id);
        const subscriber = this.rows('SELECT active, banned FROM subscribers WHERE chat_id = ?', chatId)[0];
        if (!subscriber || subscriber.active !== 1 || subscriber.banned === 1) return;
        const appId = /^apps:toggle:([a-z0-9][a-z0-9_-]{0,63})$/.exec(String(callback.data))?.[1];
        const pageMatch = /^apps:page:(\d{1,3})$/.exec(String(callback.data));
        const page = pageMatch ? Number(pageMatch[1]) : appId ? Math.floor(applications.findIndex((app) => app.id === appId) / 20) : 0;
        if (pageMatch) {
          if (page >= Math.max(1, Math.ceil(applications.length / 20))) return;
          acknowledgement = 'فهرست اپلیکیشن‌ها به‌روز شد.';
        } else {
          if (callback.data !== 'apps:all' && (!appId || !applications.some((app) => app.id === appId))) return;
          this.changeApplications(chatId, appId ?? null);
        }
        this.queueApplicationPrompt(chatId, applications, runtime, Number(callback.message!.message_id), page);
        acknowledge = true;
        return;
      }
      const message = value.message as {
        chat?: { id?: unknown; type?: string };
        from?: { first_name?: string; username?: string };
        text?: unknown
      } | undefined;
      if (message?.chat?.type === 'private' && Number.isSafeInteger(message.chat.id) && typeof message.text === 'string') {
        const chatId = String(message.chat.id);
        const command = /^\/(start|stop|apps|all)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(message.text)?.[1];
        if (command === 'start') {
          // Opt-out events remain valid while disabled; disabled tenants cannot enroll users.
          if (!runtime.enabled) return;
          const previous = this.rows('SELECT active, banned FROM subscribers WHERE chat_id = ?', chatId)[0];
          if (previous?.banned === 1) return;
          const activating = !previous || previous.active !== 1;
          const welcome = this.settings.welcomeMessage;
          if (activating && this.count('SELECT COUNT(*) AS count FROM subscribers WHERE active = 1 AND banned = 0') >= runtime.limits.maxSubscribers) {
            return new AppError(429, 'SUBSCRIBER_LIMIT', 'SUBSCRIBER_LIMIT: This tenant has reached its active subscriber limit.');
          }
          if (activating && welcome && this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending', 'sending')") >= runtime.limits.maxPendingDeliveries) {
            return new AppError(429, 'QUEUE_LIMIT', 'QUEUE_LIMIT: There is no capacity for the subscription welcome message.');
          }
          this.sql.exec(`INSERT INTO subscribers (chat_id, first_name, username, active, joined_at, updated_at)
                         VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(chat_id) DO
                         UPDATE
                         SET
                             first_name = excluded.first_name, username = excluded.username, active = 1, updated_at = excluded.updated_at`, chatId, String(message.from?.first_name ?? '').slice(0, 200), typeof message.from?.username === 'string' ? message.from.username.slice(0, 100) : null, now, now);
          if (activating && welcome) {
            this.sql.exec('INSERT INTO deliveries (chat_id, rendered, updated_at) VALUES (?, ?, ?)', chatId, welcome, now);
          }
          this.invalidate();
        } else if (command === 'stop') this.deactivate(chatId, 'Subscriber stopped notifications.');
        else if (command === 'apps' || command === 'all') {
          const subscriber = this.rows('SELECT active, banned FROM subscribers WHERE chat_id = ?', chatId)[0];
          if (!runtime.enabled || !subscriber || subscriber.active !== 1 || subscriber.banned === 1) return;
          if (command === 'all') this.changeApplications(chatId, null);
          if (!this.queueApplicationPrompt(chatId, applications, runtime)) return new AppError(429, 'QUEUE_LIMIT', 'QUEUE_LIMIT: There is no capacity for the application preferences menu.');
        }
      }
      const membership = value.my_chat_member as {
        chat?: { id?: unknown; type?: string };
        new_chat_member?: { status?: string }
      } | undefined;
      if (membership?.chat?.type === 'private' && Number.isSafeInteger(membership.chat.id) && ['kicked', 'left'].includes(membership.new_chat_member?.status ?? '')) {
        this.deactivate(String(membership.chat.id), 'Bot blocked or removed.');
      }
    });
    this.cleanup();
    if (acknowledge && runtime.botToken) {
      // Acknowledging a button does not send another message or change delivery outcomes.
      try { await telegramCall(runtime.botToken, 'answerCallbackQuery', {callback_query_id: callback!.id, text: acknowledgement}); }
      catch { /* Preferences remain durable even when Telegram cannot dismiss its spinner. */ }
    }
    if (outcome) throw outcome;
  }

  private changeApplications(chatId: string, applicationId: string | null): void {
    const subscriber = this.rows('SELECT application_mode FROM subscribers WHERE chat_id = ?', chatId)[0];
    if (!subscriber) return;
    if (applicationId === null) {
      this.sql.exec('DELETE FROM subscriber_applications WHERE chat_id = ?', chatId);
      this.sql.exec("UPDATE subscribers SET application_mode = 'all', updated_at = ? WHERE chat_id = ?", Date.now(), chatId);
    } else {
      if (subscriber.application_mode !== 'selected') this.sql.exec('DELETE FROM subscriber_applications WHERE chat_id = ?', chatId);
      const selected = this.rows('SELECT application_id FROM subscriber_applications WHERE chat_id = ? AND application_id = ?', chatId, applicationId).length > 0;
      if (selected) this.sql.exec('DELETE FROM subscriber_applications WHERE chat_id = ? AND application_id = ?', chatId, applicationId);
      else this.sql.exec('INSERT INTO subscriber_applications (chat_id, application_id) VALUES (?, ?)', chatId, applicationId);
      const count = this.count('SELECT COUNT(*) AS count FROM subscriber_applications WHERE chat_id = ?', chatId);
      this.sql.exec('UPDATE subscribers SET application_mode = ?, updated_at = ? WHERE chat_id = ?', count ? 'selected' : 'all', Date.now(), chatId);
      if (count) this.sql.exec(`UPDATE deliveries SET status = 'skipped', error = 'Subscriber excluded this application.', updated_at = ?
        WHERE chat_id = ? AND status = 'pending' AND notification_id IN (
          SELECT n.id FROM notifications n WHERE NOT EXISTS (
            SELECT 1 FROM subscriber_applications p WHERE p.chat_id = ? AND p.application_id = json_extract(n.input, '$.applicationId')
          )
        )`, Date.now(), chatId, chatId);
    }
    this.invalidate();
  }

  private queueApplicationPrompt(chatId: string, applications: Application[], runtime: TenantRuntime, messageId?: number, page = 0): boolean {
    if (this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending', 'sending')") >= runtime.limits.maxPendingDeliveries) return false;
    const all = this.rows('SELECT application_mode FROM subscribers WHERE chat_id = ?', chatId)[0]?.application_mode !== 'selected';
    const selected = new Set(this.rows('SELECT application_id FROM subscriber_applications WHERE chat_id = ?', chatId).map((row) => String(row.application_id)));
    const text = all
      ? '📬 دریافت اعلان: همه اپلیکیشن‌ها\nبرای دریافت فقط از یک اپلیکیشن، دکمه آن را انتخاب کنید. انتخاب دوباره آخرین مورد، دریافت همه را فعال می‌کند.'
      : '📬 دریافت اعلان: فقط اپلیکیشن‌های انتخاب‌شده\nبا دکمه‌ها انتخاب‌ها را تغییر دهید. تغییرات همان لحظه ذخیره می‌شوند؛ انتخاب دوباره آخرین مورد، دریافت همه را فعال می‌کند.';
    const inline_keyboard = [
      [{text: `${all ? '✅ ' : ''}همه اپلیکیشن‌ها`, callback_data: 'apps:all'}],
      ...applications.slice(page * 20, (page + 1) * 20).map((app) => [{text: `${!all && selected.has(app.id) ? '✅ ' : ''}${app.name.slice(0, 50)}`, callback_data: `apps:toggle:${app.id}`}]),
    ];
    const navigation = [];
    if (page > 0) navigation.push({text: 'قبلی', callback_data: `apps:page:${page - 1}`});
    if ((page + 1) * 20 < applications.length) navigation.push({text: 'بعدی', callback_data: `apps:page:${page + 1}`});
    if (navigation.length) inline_keyboard.push(navigation);
    const payload = {method: messageId ? 'editMessageText' : 'sendMessage', ...(messageId ? {message_id: messageId} : {}), reply_markup: {inline_keyboard}};
    this.sql.exec('INSERT INTO deliveries (chat_id, rendered, system_payload, updated_at) VALUES (?, ?, ?, ?)', chatId, text, JSON.stringify(payload), Date.now());
    this.invalidate();
    return true;
  }

  private deactivate(chatId: string, reason: string): void {
    const now = Date.now();
    this.sql.exec('UPDATE subscribers SET active = 0, updated_at = ? WHERE chat_id = ?', now, chatId);
    this.sql.exec("UPDATE deliveries SET status = 'skipped', error = ?, updated_at = ? WHERE chat_id = ? AND status = 'pending'", reason, now, chatId);
    this.invalidate();
  }

  private recoverInterrupted(): void {
    const result = this.sql.exec(`UPDATE deliveries
                   SET status     = 'unknown',
                       error      = CASE
                                        WHEN stage > 0
                                            THEN 'Photo was delivered; text delivery was interrupted and cannot be safely retried.'
                                        ELSE 'Delivery was interrupted; Telegram may have accepted it. It was not sent again.' END,
                       updated_at = ?
                   WHERE status = 'sending'`, Date.now());
    if (result.rowsWritten > 0) this.invalidate();
  }

  private async ensureAlarm(at: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const wakeEpoch = this.wakeEpoch;
    // Persist the watchdog before network I/O. Alarm retries alone are bounded by the platform.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    this.recoverInterrupted();
    this.cleanup();
    let runtime: TenantRuntime | null = null;
    let runtimeUnavailable = true;
    try {
      runtime = await this.runtime();
      runtimeUnavailable = false;
      for (let index = 0; index < 20; index++) {
        if (index > 0) {
          runtimeUnavailable = true;
          runtime = await this.runtime();
          runtimeUnavailable = false;
        }
        if (!runtime.enabled || !runtime.botToken) break;
        const settings = this.getSettings();
        if (settings.paused) break;
        const now = Date.now();
        const globalNext = Number(this.rows("SELECT value FROM queue_state WHERE key = 'next_send_at'")[0]?.value ?? 0);
        if (globalNext > now) break;
        const delivery = this.rows<DeliveryRow>(`SELECT d.*, json_extract(n.input, '$.applicationId') AS application_id
                                                 FROM deliveries d
                                                          JOIN subscribers s ON s.chat_id = d.chat_id
                                                          LEFT JOIN notifications n ON n.id = d.notification_id
                                                 WHERE d.status = 'pending'
                                                   AND d.next_attempt <= ?
                                                   AND s.next_send_at <= ?
                                                   AND s.active = 1
                                                   AND s.banned = 0
                                                 ORDER BY d.id LIMIT 1`, now, now)[0];
        if (!delivery) break;
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("UPDATE deliveries SET status = 'sending', attempts = attempts + 1, stage_attempts = stage_attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'", now, delivery.id);
          this.sql.exec('UPDATE subscribers SET next_send_at = ? WHERE chat_id = ?', now + 1_000, delivery.chat_id);
          this.sql.exec("INSERT INTO queue_state (key, value) VALUES ('next_send_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", now + Math.ceil(1_000 / Math.max(1, Math.min(20, settings.deliveryPerSecond))));
          this.invalidate();
        });
        await this.ctx.storage.sync();
        const recipient = this.rows('SELECT active, banned, application_mode FROM subscribers WHERE chat_id = ?', delivery.chat_id)[0];
        const acceptsApplication = !delivery.notification_id || recipient?.application_mode !== 'selected' || this.rows('SELECT application_id FROM subscriber_applications WHERE chat_id = ? AND application_id = ?', delivery.chat_id, delivery.application_id).length > 0;
        if (!recipient || recipient.active !== 1 || recipient.banned === 1 || !acceptsApplication) {
          this.sql.exec("UPDATE deliveries SET status = 'skipped', error = 'Subscriber was banned, opted out, or excluded this application before delivery.', updated_at = ? WHERE id = ?", Date.now(), delivery.id);
          this.invalidate();
          continue;
        }
        await this.deliver(delivery, runtime.botToken);
      }
    } finally {
      await this.scheduleRemaining(!!runtime?.enabled && !!runtime?.botToken, wakeEpoch, runtimeUnavailable);
    }
  }

  private async deliver(delivery: DeliveryRow, botToken: string): Promise<void> {
    const isPhoto = !!delivery.image && delivery.stage === 0;
    const separateText = isPhoto && delivery.rendered.length > 1_024;
    const payload: Record<string, unknown> = {chat_id: delivery.chat_id, disable_notification: !!delivery.silent};
    const system = delivery.system_payload ? JSON.parse(delivery.system_payload) as {method?: string; message_id?: number; reply_markup?: unknown} : null;
    if (system?.reply_markup) payload.reply_markup = system.reply_markup;
    if (system?.message_id) payload.message_id = system.message_id;
    if (isPhoto) {
      payload.photo = delivery.image;
      payload.caption = separateText ? `${delivery.rendered.split('\n')[0].slice(0, 900)}\nDetails follow in the next message.` : delivery.rendered;
    } else {
      payload.text = delivery.rendered;
      payload.link_preview_options = {is_disabled: true};
    }
    try {
      const method = system?.method === 'editMessageText' ? 'editMessageText' : isPhoto ? 'sendPhoto' : 'sendMessage';
      if (method === 'editMessageText') delete payload.disable_notification;
      const result = await telegramCall(botToken, method, payload);
      if (!result.result || !Number.isSafeInteger(result.result.message_id) || Number(result.result.message_id) <= 0) {
        throw new TelegramError('Telegram response is uncertain (missing message identifier).', 0, true);
      }
      const now = Date.now();
      if (separateText) {
        const subscriber = this.rows('SELECT active, banned FROM subscribers WHERE chat_id = ?', delivery.chat_id)[0];
        const acceptsApplication = this.rows("SELECT chat_id FROM subscribers WHERE chat_id = ? AND (application_mode = 'all' OR EXISTS (SELECT 1 FROM subscriber_applications p WHERE p.chat_id = subscribers.chat_id AND p.application_id = ?))", delivery.chat_id, delivery.application_id).length > 0;
        const active = subscriber?.active === 1 && subscriber.banned !== 1 && acceptsApplication;
        this.sql.exec('UPDATE deliveries SET status = ?, stage = 1, stage_attempts = 0, error = ?, next_attempt = ?, updated_at = ? WHERE id = ?', active ? 'pending' : 'skipped', active ? null : 'Photo was delivered; subscriber stopped before text delivery.', now + 1_000, now, delivery.id);
      } else {
        this.sql.exec("UPDATE deliveries SET status = 'sent', error = NULL, updated_at = ? WHERE id = ?", now, delivery.id);
      }
    } catch (error) {
      const failure = error instanceof TelegramError ? error : new TelegramError('Delivery result is uncertain.', 0, true);
      const now = Date.now();
      const subscriber = this.rows('SELECT active, banned FROM subscribers WHERE chat_id = ?', delivery.chat_id)[0];
      const acceptsApplication = !delivery.notification_id || this.rows("SELECT chat_id FROM subscribers WHERE chat_id = ? AND (application_mode = 'all' OR EXISTS (SELECT 1 FROM subscriber_applications p WHERE p.chat_id = subscribers.chat_id AND p.application_id = ?))", delivery.chat_id, delivery.application_id).length > 0;
      const active = subscriber?.active === 1 && subscriber.banned !== 1 && acceptsApplication;
      const partial = delivery.stage > 0 ? 'Photo was delivered. ' : '';
      if (failure.code === 429 && failure.retryAfter) {
        const retryAt = now + failure.retryAfter * 1_000;
        this.sql.exec("INSERT INTO queue_state (key, value) VALUES ('next_send_at', ?) ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)", retryAt);
        if (delivery.stage_attempts + 1 < MAX_ATTEMPTS && active) {
          this.sql.exec("UPDATE deliveries SET status = 'pending', next_attempt = ?, error = ?, updated_at = ? WHERE id = ?", retryAt, partial + failure.message, now, delivery.id);
          return;
        }
      }
      const status = failure.uncertain ? 'unknown' : !active && failure.code === 429 ? 'skipped' : 'failed';
      this.sql.exec('UPDATE deliveries SET status = ?, error = ?, updated_at = ? WHERE id = ?', status, partial + failure.message, now, delivery.id);
      if (failure.code === 403 && !failure.uncertain) this.deactivate(delivery.chat_id, 'Bot blocked or access to this chat was revoked.');
    } finally {
      this.invalidate();
    }
  }

  private async scheduleRemaining(tenantReady = true, wakeEpoch = this.wakeEpoch, runtimeUnavailable = false): Promise<void> {
    const settings = this.getSettings();
    const now = Date.now();
    if (wakeEpoch !== this.wakeEpoch) {
      // A registry update may have changed availability after this alarm fetched its runtime.
      await this.ensureAlarm(now + 100);
      return;
    }
    if (runtimeUnavailable) {
      await this.ctx.storage.setAlarm(now + 30_000);
      return;
    }
    if (tenantReady && !settings.paused) {
      const next = this.rows(`SELECT MIN(MAX(d.next_attempt, s.next_send_at)) AS due
                              FROM deliveries d
                                       JOIN subscribers s ON s.chat_id = d.chat_id
                              WHERE d.status = 'pending'
                                AND s.active = 1 AND s.banned = 0`)[0]?.due;
      if (typeof next === 'number') {
        const globalNext = Number(this.rows("SELECT value FROM queue_state WHERE key = 'next_send_at'")[0]?.value ?? 0);
        // No await separates queue inspection and scheduling; an enqueue cannot interleave here.
        await this.ctx.storage.setAlarm(Math.max(now + 25, next, globalNext));
        return;
      }
    }
    const interrupted = this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status = 'sending'");
    // Idle objects wake daily for retention, rather than keeping the watchdog's 30-second loop.
    await this.ctx.storage.setAlarm(now + (interrupted ? 30_000 : DAY));
  }

  private cleanup(): void {
    const now = Date.now();
    if (now >= this.lastCleanupAt && now - this.lastCleanupAt < CLEANUP_INTERVAL) return;
    const cutoff = now - this.getSettings().retentionDays * DAY;
    this.ctx.storage.transactionSync(() => {
      // Remove expired terminal parents from all views before deleting children in chunks.
      // Otherwise a visible parent's reported total would shrink during partial cleanup.
      this.sql.exec(`UPDATE notifications
                     SET purging         = 1,
                         idempotency_key = NULL
                     WHERE id IN (SELECT n.id
                                  FROM notifications n
                                  WHERE n.purging = 0
                                    AND n.created_at < ?
                                    AND NOT EXISTS (SELECT 1
                                                    FROM deliveries d
                                                    WHERE d.notification_id = n.id
                                                      AND d.status IN ('pending', 'sending'))
                                  ORDER BY n.created_at LIMIT 100
                         )`, cutoff);
      // Bound cleanup work even after a long idle period, and preserve every unfinished job.
      this.sql.exec(`DELETE
                     FROM deliveries
                     WHERE id IN (SELECT d.id
                                  FROM deliveries d
                                           JOIN notifications n ON n.id = d.notification_id
                                  WHERE n.purging = 1
                                  ORDER BY n.created_at LIMIT 500
                         )`);
      this.sql.exec(`DELETE
                     FROM notifications
                     WHERE id IN (SELECT n.id
                                  FROM notifications n
                                  WHERE n.purging = 1
                                    AND NOT EXISTS (SELECT 1
                                                    FROM deliveries d
                                                    WHERE d.notification_id = n.id)
                                  ORDER BY n.created_at LIMIT 100
                         )`);
      this.sql.exec("DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries WHERE notification_id IS NULL AND status NOT IN ('pending', 'sending') AND updated_at < ? LIMIT 500)", cutoff);
      this.sql.exec('DELETE FROM telegram_updates WHERE id IN (SELECT id FROM telegram_updates WHERE received_at < ? LIMIT 500)', now - 7 * DAY);
      this.sql.exec('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < ? LIMIT 500)', now);
      this.sql.exec("INSERT INTO queue_state (key, value) VALUES ('last_cleanup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", now);
    });
    this.lastCleanupAt = now;
    this.invalidate();
  }
}
