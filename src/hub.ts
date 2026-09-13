import {DurableObject} from 'cloudflare:workers';
import type {
  Application,
  Env,
  NotificationInput,
  NotificationRecord,
  Overview,
  Page,
  Settings,
  SourceContext,
  Subscriber,
  SubscriberUpdate,
  TenantRuntime,
  TenantUsage
} from './types';
import {AppError, DEFAULT_SETTINGS, LEVELS} from './types';
import {HubAutomation, type IncidentStored} from './hub-automation';
import {DEFAULT_SUBSCRIBER_PREFERENCES, automationPolicyInput, evaluateDelivery, type Incident, type SubscriberPreferences} from './automation';
import {formatRichDigest} from './rich-message';
import {formatNotification, formatRichNotification, telegramCall, TelegramError} from './telegram';

type Row = Record<string, SqlStorageValue>;
type DirectoryApplication = Pick<Application, 'id' | 'name'>;

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
  incident_id: string | null;
  telegram_message_id: number | null;
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
  private automation!: HubAutomation;
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private tenantId: string | null = null;
  private lastCleanupAt = -Infinity;
  private wakeEpoch = 0;
  private readonly readCache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly rateCounters = new Map<string, { count: number; expiresAt: number }>();
  private readonly applicationVersions = new Map<string, number>();
  private applicationDirectoryVersion = 0;
  private applicationRevision = '';
  private maxPendingDeliveries = 0;

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
          CREATE TABLE IF NOT EXISTS tenant_identity
          (
              id
              INTEGER
              PRIMARY
              KEY
              CHECK
          (
              id =
              1
          ), tenant_id TEXT);
          CREATE TABLE IF NOT EXISTS daily_usage
          (
              day
              TEXT
              PRIMARY
              KEY,
              notifications
              INTEGER
              NOT
              NULL
              DEFAULT
              0
          );
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
      if (!subscriberColumns.some((column) => column.name === 'display_name')) this.sql.exec('ALTER TABLE subscribers ADD COLUMN display_name TEXT');
      if (!subscriberColumns.some((column) => column.name === 'notes')) this.sql.exec("ALTER TABLE subscribers ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
      if (!subscriberColumns.some((column) => column.name === 'access_mode')) this.sql.exec("ALTER TABLE subscribers ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'all'");
      if (!subscriberColumns.some((column) => column.name === 'version')) this.sql.exec('ALTER TABLE subscribers ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS subscriber_allowed_applications
      (
          chat_id
          TEXT
          NOT
          NULL
          REFERENCES
          subscribers
                     (
          chat_id
                     ) ON DELETE CASCADE,
          application_id TEXT NOT NULL, PRIMARY KEY
                     (
                         chat_id,
                         application_id
                     )
          )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS application_access (
        application_id TEXT PRIMARY KEY, version INTEGER NOT NULL, enabled INTEGER NOT NULL,
        audience_mode TEXT NOT NULL, show_in_directory INTEGER NOT NULL, name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS application_audience (
        application_id TEXT NOT NULL, chat_id TEXT NOT NULL, PRIMARY KEY(application_id, chat_id)
      )`);
      for (const app of this.rows('SELECT application_id, version FROM application_access')) this.applicationVersions.set(String(app.application_id), Number(app.version));
      this.applicationRevision = [...this.applicationVersions].map(([id, version]) => `${id}:${version}`).sort().join(',');
      this.applicationDirectoryVersion = Number(this.rows("SELECT value FROM queue_state WHERE key = 'application_directory_version'")[0]?.value ?? 0);
      if (!this.rows('PRAGMA table_info(deliveries)').some((column) => column.name === 'system_payload')) this.sql.exec('ALTER TABLE deliveries ADD COLUMN system_payload TEXT');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS subscriber_applications
      (
          chat_id
          TEXT
          NOT
          NULL
          REFERENCES
          subscribers
                     (
          chat_id
                     ) ON DELETE CASCADE,
          application_id TEXT NOT NULL, PRIMARY KEY
                     (
                         chat_id,
                         application_id
                     )
          )`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS notifications_visible_created ON notifications(purging, created_at DESC)');
      this.sql.exec('INSERT OR IGNORE INTO settings (id, body) VALUES (1, ?)', JSON.stringify(DEFAULT_SETTINGS));
      this.settings = {...DEFAULT_SETTINGS, ...JSON.parse(String(this.rows('SELECT body FROM settings WHERE id = 1')[0].body))};
      this.lastCleanupAt = Number(this.rows("SELECT value FROM queue_state WHERE key = 'last_cleanup_at'")[0]?.value ?? -Infinity);
      const today = new Date(Date.now()).toISOString().slice(0, 10);
      this.sql.exec('INSERT OR IGNORE INTO daily_usage (day, notifications) SELECT ?, COUNT(*) FROM notifications WHERE created_at >= ?', today, Date.parse(`${today}T00:00:00.000Z`));
      const deliveryColumns = this.rows('PRAGMA table_info(deliveries)');
      if (!deliveryColumns.some(column => column.name === 'incident_id')) this.sql.exec('ALTER TABLE deliveries ADD COLUMN incident_id TEXT');
      if (!deliveryColumns.some(column => column.name === 'telegram_message_id')) this.sql.exec('ALTER TABLE deliveries ADD COLUMN telegram_message_id INTEGER');
      this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS delivery_incident_recipient ON deliveries(incident_id, chat_id) WHERE incident_id IS NOT NULL');
      this.automation = new HubAutomation(this.sql, () => this.invalidate());
      // A persisted network attempt cannot be safely repeated after an isolate restart.
      this.recoverInterrupted();
      const alarm = await ctx.storage.getAlarm();
      if (alarm === null && (this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status = 'pending'") || this.count('SELECT COUNT(*) AS count FROM notifications') || this.automation.nextDeadline() !== null)) {
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
    this.readCache.set(key, {expiresAt: Date.now() + CACHE_TTL, value});
    return structuredClone(value);
  }

  private invalidate(): void {
    this.readCache.clear();
  }

  async initializeTenant(id: string, name?: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new AppError(400, 'TENANT_DISABLED', 'TENANT_DISABLED: Invalid tenant identity.');
    if (this.tenantId !== null) {
      if (this.tenantId !== id) throw new AppError(409, 'TENANT_DISABLED', 'TENANT_DISABLED: This hub already belongs to a different tenant.');
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE tenant_identity SET tenant_id = ? WHERE id = 1', id);
      if (name) {
        this.settings = {...this.settings, projectName: name.slice(0, 80)};
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
    const knownRevision = this.applicationRevision;
    const runtime = await this.env.TENANTS.getByName('registry').getRuntime(this.tenantId, knownRevision);
    if (!runtime || runtime.id !== this.tenantId) throw new AppError(403, 'TENANT_DISABLED', 'TENANT_DISABLED: Tenant is unavailable.');
    if (runtime.applications) this.refreshApplicationAccess(runtime.applications);
    else if (runtime.applicationRevision !== knownRevision) throw new AppError(503, 'TENANT_DISABLED', 'TENANT_DISABLED: Application policy snapshot is unavailable.');
    this.maxPendingDeliveries = runtime.limits.maxPendingDeliveries;
    return runtime;
  }

  validateApplicationAudience(chatIds: string[]): void {
    if (!Array.isArray(chatIds) || chatIds.length > 1_000 || chatIds.some((id) => typeof id !== 'string' || !/^-?\d{1,20}$/.test(id)) || new Set(chatIds).size !== chatIds.length) {
      throw new AppError(400, 'INVALID_APPLICATION', 'INVALID_APPLICATION: Invalid application audience.');
    }
    if (chatIds.length && this.count('SELECT COUNT(*) AS count FROM subscribers WHERE chat_id IN (SELECT value FROM json_each(?))', JSON.stringify(chatIds)) !== chatIds.length) {
      throw new AppError(400, 'INVALID_APPLICATION', 'INVALID_APPLICATION: Application audience contains an unknown subscriber.');
    }
  }

  /** Registry calls this directly while mutating applications: never call back into the registry. */
  refreshApplicationAccess(applications: Application[]): void {
    const changed: Application[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const app of applications) {
        const version = this.applicationVersions.get(app.id);
        if (typeof version === 'number' && version >= app.version) continue;
        this.sql.exec(`INSERT INTO application_access (application_id, version, enabled, audience_mode,
                                                       show_in_directory, name)
                       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(application_id) DO
                UPDATE SET version = excluded.version, enabled = excluded.enabled,
                    audience_mode = excluded.audience_mode, show_in_directory = excluded.show_in_directory, name = excluded.name`,
          app.id, app.version, app.enabled ? 1 : 0, app.audienceMode, app.showInDirectory ? 1 : 0, app.name);
        this.sql.exec('DELETE FROM application_audience WHERE application_id = ?', app.id);
        if (app.audienceMode === 'selected') {
          this.sql.exec('INSERT INTO application_audience (application_id, chat_id) SELECT ?, value FROM json_each(?)', app.id, JSON.stringify(app.audienceChatIds));
        }
        changed.push(app);
      }
      if (!changed.length) return;
      this.sql.exec("INSERT INTO queue_state (key, value) VALUES ('application_directory_version', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1");
      this.sql.exec(`UPDATE deliveries
                     SET status     = 'skipped',
                         error      = 'Application access or directory changed.',
                         updated_at = ?
                     WHERE status = 'pending'
                       AND ((notification_id IS NULL AND system_payload IS NOT NULL) OR
                            notification_id IN (SELECT n.id
                                                FROM notifications n
                                                WHERE json_extract(n.input, '$.applicationId') IS NOT NULL
                                                  AND NOT EXISTS (SELECT 1
                                                                  FROM application_access a
                                                                  WHERE a.application_id = json_extract(n.input, '$.applicationId')
                                                                    AND a.enabled = 1
                                                                    AND (a.audience_mode = 'all' OR EXISTS (SELECT 1
                                                                                                            FROM application_audience p
                                                                                                            WHERE p.application_id = a.application_id
                                                                                                              AND p.chat_id = deliveries.chat_id)))))`, Date.now());
    });
    if (changed.length) {
      for (const app of changed) this.applicationVersions.set(app.id, app.version);
      this.applicationRevision = [...this.applicationVersions].map(([id, version]) => `${id}:${version}`).sort().join(',');
      this.applicationDirectoryVersion++;
      this.invalidate();
    }
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

  setSubscriberBan(chatIds: string[], banned: boolean, reason?: string): { updated: number } {
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

  private cacheRateCounter(key: string, counter: { count: number; expiresAt: number }): void {
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
      if (used >= runtime.limits.notificationsPerDay) return {error: new AppError(429, 'DAILY_LIMIT', 'DAILY_LIMIT: The daily notification quota has been reached.')};
      const recipients = this.count(`WITH request AS (SELECT ? AS app_id)
                                     SELECT COUNT(*) AS count
                                     FROM subscribers s CROSS JOIN request r
                                     WHERE ${this.recipientWhere('r.app_id')}`, input.applicationId ?? null);
      const existingIncident = this.automation.findOpen(input, now);
      const additional = existingIncident ? this.count(`WITH request AS (SELECT ? AS app_id) SELECT COUNT(*) AS count FROM deliveries d JOIN subscribers s ON s.chat_id = d.chat_id CROSS JOIN request r WHERE ${input.incidentStatus === 'resolved' ? "d.incident_id IN (SELECT id FROM incidents WHERE application_id IS ? AND fingerprint = ? AND status != 'resolved')" : 'd.incident_id = ?'} AND d.status NOT IN ('pending','sending') AND NOT (d.status='unknown' AND d.telegram_message_id IS NULL) AND ${this.recipientWhere('r.app_id')}`, input.applicationId ?? null, ...(input.incidentStatus === 'resolved' ? [input.applicationId ?? null, existingIncident.fingerprint] : [existingIncident.id])) : recipients;
      const pending = this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending', 'sending')");
      if (pending + additional > runtime.limits.maxPendingDeliveries) return {error: new AppError(429, 'QUEUE_LIMIT', 'QUEUE_LIMIT: There is not enough capacity for this notification in the delivery queue.')};
      this.sql.exec('INSERT INTO daily_usage (day, notifications) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET notifications = notifications + 1', day);
      this.sql.exec('INSERT INTO notifications (id, input, source, created_at, idempotency_key, fingerprint) VALUES (?, ?, ?, ?, ?, ?)', id, JSON.stringify(input), JSON.stringify(source), now, idempotencyKey ?? null, fingerprint);
      const tracked = this.automation.accept(input, source, id, now);
      const richPayload = JSON.stringify({method: 'sendRichMessage', rich_message: formatRichNotification(input, source, settings.showCountryFlag, id, tracked?.incident)});
      if (tracked?.repeated) {
        this.refreshIncidentDeliveries(tracked.incident, now, input.incidentStatus === 'resolved');
      } else {
        // Initial fan-out captures eligible users atomically; preferences can only reduce this set later.
        this.sql.exec(`WITH request AS (SELECT ? AS app_id)
          INSERT INTO deliveries (notification_id, chat_id, rendered, image, silent, updated_at, system_payload, incident_id)
          SELECT ?, chat_id, ?, ?, ?, ?, ?, ? FROM subscribers s CROSS JOIN request r WHERE ${this.recipientWhere('r.app_id')}`,
          input.applicationId ?? null, id, rendered, input.image ?? null, input.silent ? 1 : 0, now, richPayload, tracked?.incident.id ?? null);
        if (this.automation.getPolicy(input.applicationId).policy.rules.length || this.count('SELECT COUNT(*) AS count FROM subscriber_preferences')) {
          for (const delivery of this.rows<DeliveryRow>(`SELECT d.* FROM deliveries d WHERE notification_id = ?${this.automation.getPolicy(input.applicationId).policy.rules.length ? '' : ' AND EXISTS (SELECT 1 FROM subscriber_preferences p WHERE p.chat_id = d.chat_id)'}`, id)) this.applyDeliveryPreferences(delivery, input, now);
        }
      }
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
    const incident = this.rows('SELECT incident_id, grouped FROM notification_incidents WHERE notification_id = ?', row.id)[0];
    const incidentId = incident?.incident_id ?? null;
    const counts = Object.fromEntries(this.rows('SELECT status, COUNT(*) AS count FROM deliveries WHERE notification_id = ? OR incident_id = ? GROUP BY status', row.id, incidentId).map((entry) => [String(entry.status), Number(entry.count)]));
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const pending = (counts.pending ?? 0) + (counts.sending ?? 0);
    const sent = counts.sent ?? 0;
    const failed = counts.failed ?? 0;
    const photoDelivered = this.count('SELECT COUNT(*) AS count FROM deliveries WHERE (notification_id = ? OR incident_id = ?) AND stage > 0', row.id, incidentId) > 0;
    let status: NotificationRecord['status'];
    if (!total) status = 'empty';
    else if (pending) status = counts.sending || pending !== total || photoDelivered ? 'sending' : 'queued';
    else if (sent === total) status = 'completed';
    else if (failed === total && !photoDelivered) status = 'failed';
    else status = 'partial';
    return {
      ...JSON.parse(row.input) as NotificationInput,
      ...(incidentId ? {incidentId: String(incidentId), grouped: incident.grouped === 1} : {}),
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
      deliveries: this.rows<DeliveryRow>('SELECT * FROM deliveries WHERE notification_id = ? OR incident_id = ? ORDER BY id LIMIT 100', id, notification.incidentId ?? null).map((entry) => ({
        chatId: entry.chat_id,
        status: entry.status,
        attempts: entry.attempts,
        error: entry.error,
        stage: entry.stage,
        partial: entry.stage > 0 && entry.status !== 'sent'
      })),
    };
  }

  listSubscribers(page: number, search = ''): Page<Subscriber> {
    if (typeof search !== 'string' || search.trim().length > 100) throw new AppError(400, 'INVALID_SUBSCRIBER', 'INVALID_SUBSCRIBER: Search must contain at most 100 characters.');
    page = Math.max(1, Math.floor(page || 1));
    search = search.trim();
    return this.cached(`subscribers:${JSON.stringify([page, search])}`, () => {
      const where = search ? ' WHERE instr(lower(first_name), lower(?)) > 0 OR instr(lower(display_name), lower(?)) > 0 OR instr(lower(username), lower(?)) > 0 OR instr(chat_id, ?) > 0' : '';
      const bindings = search ? [search, search, search, search] : [];
      return {
        items: this.toSubscribers(this.rows(`SELECT * FROM subscribers${where} ORDER BY joined_at DESC, chat_id LIMIT ? OFFSET ?`, ...bindings, PAGE_SIZE, (page - 1) * PAGE_SIZE)),
        total: this.count(`SELECT COUNT(*) AS count FROM subscribers${where}`, ...bindings), page, pageSize: PAGE_SIZE,
      };
    });
  }

  getSubscriber(chatId: string): Subscriber | null {
    this.validateSubscriberId(chatId);
    return this.cached(`subscriber:${chatId}`, () => this.toSubscribers(this.rows('SELECT * FROM subscribers WHERE chat_id = ?', chatId))[0] ?? null);
  }

  private validateSubscriberId(chatId: string): void {
    if (typeof chatId !== 'string' || !/^-?\d{1,20}$/.test(chatId)) throw new AppError(400, 'INVALID_SUBSCRIBER', 'INVALID_SUBSCRIBER: Invalid subscriber identifier.');
  }

  /** Fetch each relation once for the complete page, including administrative and Telegram selections. */
  private toSubscribers(rows: Row[]): Subscriber[] {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.chat_id);
    const placeholders = ids.map(() => '?').join(',');
    const relations = (table: string): Map<string, string[]> => {
      const result = new Map<string, string[]>();
      for (const row of this.rows(`SELECT chat_id, application_id FROM ${table} WHERE chat_id IN (${placeholders}) ORDER BY application_id`, ...ids)) {
        const chatId = String(row.chat_id);
        const values = result.get(chatId) ?? [];
        values.push(String(row.application_id));
        result.set(chatId, values);
      }
      return result;
    };
    const preferences = relations('subscriber_applications');
    const allowed = relations('subscriber_allowed_applications');
    return rows.map((row) => ({
      chatId: String(row.chat_id),
      firstName: String(row.first_name),
      username: row.username === null ? null : String(row.username),
      active: row.active === 1,
      banned: row.banned === 1,
      banReason: row.ban_reason === null ? null : String(row.ban_reason),
      displayName: row.display_name === null ? null : String(row.display_name),
      notes: String(row.notes),
      accessMode: row.access_mode === 'selected' ? 'selected' : 'all',
      allowedApplicationIds: allowed.get(String(row.chat_id)) ?? [],
      version: Number(row.version),
      applicationMode: row.application_mode === 'selected' ? 'selected' : 'all',
      applicationIds: preferences.get(String(row.chat_id)) ?? [],
      joinedAt: new Date(Number(row.joined_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    }));
  }

  async updateSubscriber(chatId: string, patch: SubscriberUpdate): Promise<Subscriber> {
    this.validateSubscriberId(chatId);
    const invalid = (): never => {
      throw new AppError(400, 'INVALID_SUBSCRIBER', 'INVALID_SUBSCRIBER: Invalid subscriber profile or application access policy.');
    };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid();
    const keys = Object.keys(patch);
    if (keys.some((key) => !['expectedVersion', 'displayName', 'notes', 'accessMode', 'allowedApplicationIds'].includes(key)) ||
      !Number.isSafeInteger(patch.expectedVersion) || patch.expectedVersion < 1 || keys.length < 2) invalid();
    const has = (key: string) => Object.prototype.hasOwnProperty.call(patch, key);
    if (has('displayName') && patch.displayName !== null && (typeof patch.displayName !== 'string' || patch.displayName.trim().length > 80)) invalid();
    if (has('notes') && (typeof patch.notes !== 'string' || patch.notes.length > 1_000)) invalid();
    const policyChanged = has('accessMode');
    if (policyChanged !== has('allowedApplicationIds')) invalid();
    if (policyChanged) {
      if (!['all', 'selected'].includes(patch.accessMode!) || !Array.isArray(patch.allowedApplicationIds) || patch.allowedApplicationIds.length > 100 ||
        patch.allowedApplicationIds.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$/.test(id)) ||
        new Set(patch.allowedApplicationIds).size !== patch.allowedApplicationIds.length ||
        (patch.accessMode === 'all' && patch.allowedApplicationIds.length > 0)) invalid();
    }
    if (!this.rows('SELECT chat_id FROM subscribers WHERE chat_id = ?', chatId).length) throw new AppError(404, 'SUBSCRIBER_NOT_FOUND', 'SUBSCRIBER_NOT_FOUND: Subscriber does not exist.');
    if (policyChanged && patch.allowedApplicationIds!.length) {
      await this.runtime();
      if (patch.allowedApplicationIds!.some((id) => !this.applicationVersions.has(id))) invalid();
    }
    this.ctx.storage.transactionSync(() => {
      const current = this.rows('SELECT version FROM subscribers WHERE chat_id = ?', chatId)[0];
      if (!current) throw new AppError(404, 'SUBSCRIBER_NOT_FOUND', 'SUBSCRIBER_NOT_FOUND: Subscriber does not exist.');
      if (current.version !== patch.expectedVersion) throw new AppError(409, 'STALE_SUBSCRIBER', 'STALE_SUBSCRIBER: Subscriber was changed; reload it before saving.');
      const columns = ['version = version + 1', 'updated_at = ?'];
      const bindings: SqlStorageValue[] = [Date.now()];
      if (has('displayName')) {
        columns.push('display_name = ?');
        bindings.push(patch.displayName?.trim() || null);
      }
      if (has('notes')) {
        columns.push('notes = ?');
        bindings.push(patch.notes!);
      }
      if (policyChanged) {
        columns.push('access_mode = ?');
        bindings.push(patch.accessMode!);
        this.sql.exec('DELETE FROM subscriber_allowed_applications WHERE chat_id = ?', chatId);
        for (const id of patch.allowedApplicationIds!) this.sql.exec('INSERT INTO subscriber_allowed_applications (chat_id, application_id) VALUES (?, ?)', chatId, id);
      }
      this.sql.exec(`UPDATE subscribers SET ${columns.join(', ')} WHERE chat_id = ?`, ...bindings, chatId);
      if (policyChanged) {
        this.sql.exec(`UPDATE deliveries
                       SET status     = 'skipped',
                           error      = 'Subscriber application access policy changed.',
                           updated_at = ?
                       WHERE chat_id = ?
                         AND status = 'pending'
                         AND (
                           (notification_id IS NULL AND system_payload IS NOT NULL) OR
                           (? = 'selected' AND notification_id IN (SELECT n.id
                                                                   FROM notifications n
                                                                   WHERE NOT EXISTS (SELECT 1
                                                                                     FROM subscriber_allowed_applications a
                                                                                     WHERE a.chat_id = ?
                                                                                       AND a.application_id = json_extract(n.input, '$.applicationId'))))
                           )`, Date.now(), chatId, patch.accessMode!, chatId);
      }
    });
    this.invalidate();
    return this.getSubscriber(chatId)!;
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

  async getAutomationPolicy(applicationId?: string) {
    if (applicationId) { await this.runtime(); this.assertAutomationApplication(applicationId); }
    return this.cached(`automation:${applicationId ?? ''}`, () => this.automation.getPolicy(applicationId));
  }

  private assertAutomationApplication(applicationId: string): void {
    if (typeof applicationId !== 'string' || !this.applicationVersions.has(applicationId)) throw new AppError(404, 'APPLICATION_NOT_FOUND', 'APPLICATION_NOT_FOUND: Application does not exist.');
  }

  async updateAutomationPolicy(applicationId: string | null, raw: unknown) {
    await this.runtime();
    if (applicationId !== null) this.assertAutomationApplication(applicationId);
    const result = this.ctx.storage.transactionSync(() => {
      const proposed = automationPolicyInput(raw, this.automation.getPolicy(applicationId ?? undefined).policy);
      this.validateApplicationAudience([...new Set([...proposed.responders, ...proposed.escalation.targetChatIds])]);
      return this.automation.updatePolicy(applicationId, raw);
    });
    this.reschedulePreferenceDeliveries(applicationId);
    await this.wake();
    return result;
  }

  async resetAutomationPolicy(applicationId: string, expectedVersion: number) {
    await this.runtime(); this.assertAutomationApplication(applicationId);
    const result = this.ctx.storage.transactionSync(() => this.automation.resetPolicy(applicationId, expectedVersion));
    this.reschedulePreferenceDeliveries(applicationId);
    await this.wake(); return result;
  }

  getSubscriberPreferences(chatId: string): SubscriberPreferences {
    this.validateSubscriberId(chatId);
    return this.cached(`preferences:${chatId}`, () => this.automation.getPreferences(chatId));
  }

  async updateSubscriberPreferences(chatId: string, raw: unknown): Promise<SubscriberPreferences> {
    this.validateSubscriberId(chatId);
    const result = this.ctx.storage.transactionSync(() => this.automation.updatePreferences(chatId, raw));
    this.rescheduleSubscriberPreferences(chatId);
    await this.wake(); return result;
  }

  listIncidents(page: number, status?: string, applicationId?: string) {
    return this.cached(`incidents:${JSON.stringify([page,status,applicationId])}`, () => this.automation.listIncidents(page,status,applicationId));
  }

  getIncident(id: string) { return this.cached(`incident:${id}`, () => this.automation.getIncident(id)); }
  getIncidentOverview() { return this.cached('incident-overview', () => this.automation.overview()); }

  async actOnIncident(id: string, raw: unknown, actorChatId?: string): Promise<{incident: Incident}> {
    const runtime = await this.runtime();
    if (!runtime.enabled) throw new AppError(403, 'TENANT_DISABLED', 'TENANT_DISABLED: This tenant is disabled.');
    const incident = this.ctx.storage.transactionSync(() => {
      const current = this.automation.getStored(id);
      if (!current) throw new AppError(404, 'INCIDENT_NOT_FOUND', 'INCIDENT_NOT_FOUND: Incident does not exist.');
      if (actorChatId && !this.canActOnIncident(current, actorChatId)) throw new AppError(403, 'INCIDENT_FORBIDDEN', 'INCIDENT_FORBIDDEN: Action is not permitted.');
      const result = this.automation.act(id, raw, Date.now(), actorChatId);
      this.refreshIncidentDeliveries(result, Date.now(), true);
      return this.automation.publicIncident(result);
    });
    await this.wake(); return {incident};
  }

  async previewDelivery(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'INVALID_AUTOMATION_PREVIEW', 'INVALID_AUTOMATION_PREVIEW: Invalid preview.');
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(k => !['applicationId','chatId','level','environment','tags','timestamp'].includes(k)) || typeof value.applicationId !== 'string' || !LEVELS.includes(value.level as typeof LEVELS[number]) || (value.environment !== undefined && (typeof value.environment !== 'string' || value.environment.length > 80)) || (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 10 || value.tags.some(t => typeof t !== 'string' || t.length > 50))) || (value.timestamp !== undefined && (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))))) throw new AppError(400, 'INVALID_AUTOMATION_PREVIEW', 'INVALID_AUTOMATION_PREVIEW: Invalid preview.');
    await this.runtime(); this.assertAutomationApplication(value.applicationId);
    const input = {applicationId: value.applicationId, application: 'Preview', event: 'preview', level: value.level, environment: value.environment, tags: value.tags, timestamp: value.timestamp ?? new Date().toISOString(), text: 'Preview'} as NotificationInput;
    let preferences = structuredClone(DEFAULT_SUBSCRIBER_PREFERENCES);
    if (value.chatId !== undefined) {
      if (typeof value.chatId !== 'string') throw new AppError(400, 'INVALID_SUBSCRIBER', 'INVALID_SUBSCRIBER: Invalid subscriber identifier.');
      preferences = this.getSubscriberPreferences(value.chatId);
      if (!this.recipientAllowed(input.applicationId ?? null, value.chatId)) return {mode: 'mute' as const, reason: 'Subscriber is inactive, banned, or excluded from this application.', nextAt: null};
    }
    return evaluateDelivery(input, this.automation.getPolicy(input.applicationId).policy, preferences, value.timestamp ? Date.parse(String(value.timestamp)) : Date.now());
  }

  private recipientAllowed(applicationId: string | null, chatId: string): boolean {
    return this.rows(`WITH request AS (SELECT ? AS app_id) SELECT 1 FROM subscribers s CROSS JOIN request r WHERE s.chat_id = ? AND ${this.recipientWhere('r.app_id')}`, applicationId, chatId).length > 0;
  }

  private canActOnIncident(incident: IncidentStored, chatId: string): boolean {
    if (!this.recipientAllowed(incident.applicationId, chatId)) return false;
    const responders = this.automation.getPolicy(incident.applicationId ?? undefined).policy.responders;
    return !responders.length || responders.includes(chatId);
  }

  private deliveryInput(delivery: DeliveryRow): NotificationInput | null {
    if (delivery.incident_id) return this.automation.getStored(delivery.incident_id)?.input ?? null;
    const system = delivery.system_payload ? JSON.parse(delivery.system_payload) : null;
    if (system?.escalationIncident) return this.automation.getStored(system.escalationIncident)?.input ?? null;
    const row = delivery.notification_id ? this.rows('SELECT input FROM notifications WHERE id = ?', delivery.notification_id)[0] : null;
    return row ? JSON.parse(String(row.input)) as NotificationInput : null;
  }

  private rescheduleSubscriberPreferences(chatId: string): void {
    this.sql.exec("UPDATE deliveries SET next_attempt = MIN(next_attempt, ?) WHERE chat_id = ? AND status='pending' AND json_extract(system_payload, '$.delivery_mode') IS NOT NULL",Date.now(),chatId);
    this.invalidate();
  }

  private reschedulePreferenceDeliveries(applicationId: string | null): void {
    this.sql.exec(`UPDATE deliveries SET next_attempt=MIN(next_attempt, ?) WHERE status='pending' AND ${applicationId ? "notification_id IN (SELECT id FROM notifications WHERE json_extract(input, '$.applicationId') = ?)" : 'notification_id IS NOT NULL'}`,Date.now(),...(applicationId?[applicationId]:[]));
    this.invalidate();
  }

  private applyDeliveryPreferences(delivery: DeliveryRow, input: NotificationInput, now: number): void {
    const policy = this.automation.getPolicy(input.applicationId).policy;
    const preferences = this.getSubscriberPreferences(delivery.chat_id);
    const decision = evaluateDelivery(input, policy, preferences, now);
    const system = JSON.parse(delivery.system_payload || '{}');
    const digestVersion = `${policy.version}:${preferences.version}`;
    if (system.digest_version !== digestVersion) delete system.digest_due;
    system.digest_version = digestVersion;
    system.delivery_mode = decision.mode;
    // Keep a fixed digest deadline. Re-evaluating every alarm must not slide the window forever.
    if (decision.mode === 'digest') system.digest_due ??= decision.nextAt;
    else delete system.digest_due;
    const due = decision.mode === 'digest' ? Math.max(Number(system.digest_due), decision.reason === 'quiet_hours' ? decision.nextAt ?? now : 0) : decision.nextAt ?? now;
    this.sql.exec('UPDATE deliveries SET status = ?, next_attempt = ?, system_payload = ?, error = ?, updated_at = ? WHERE id = ?', decision.mode === 'mute' ? 'skipped' : 'pending', Math.max(delivery.next_attempt || 0, Number(due)), JSON.stringify(system), decision.mode === 'mute' ? decision.reason : null, now, delivery.id);
  }

  private refreshIncidentDeliveries(incident: IncidentStored, now: number, immediate = false): void {
    const rich = formatRichNotification(incident.input, incident.source, this.getSettings().showCountryFlag, incident.notificationId, incident);
    let slots = Math.max(0,this.maxPendingDeliveries-this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending','sending')"));
    for (const delivery of this.rows<DeliveryRow>('SELECT * FROM deliveries WHERE incident_id = ? LIMIT 10001', incident.id)) {
      // Unknown first sends cannot be resent safely; confirmed IDs make subsequent edits idempotent.
      if (delivery.status === 'unknown' && !delivery.telegram_message_id) continue;
      const original = JSON.parse(delivery.system_payload || '{}');
      delete original.incident_refresh_pending; delete original.incident_dirty;
      const messageId = original.was_digest ? null : delivery.telegram_message_id;
      if (original.was_digest) {delete original.message_id; delete original.digest_due; delete original.was_digest;}
      const system = {...original, method: messageId ? 'editMessageText' : 'sendRichMessage', rich_message: rich, incident_version: incident.version, ...(messageId ? {message_id: messageId} : {})};
      if (!this.recipientAllowed(incident.applicationId, delivery.chat_id)) {this.sql.exec("UPDATE deliveries SET status='skipped', error='Recipient is no longer eligible.', updated_at=? WHERE id=? AND status != 'sending'",now,delivery.id);continue;}
      let due = immediate ? now : delivery.status === 'pending' ? Math.max(now,delivery.next_attempt) : messageId ? Math.max(now, delivery.updated_at + 30000) : now;
      if (!immediate && incident.status === 'snoozed' && incident.snoozedUntil) due = Math.max(due, Date.parse(incident.snoozedUntil));
      if (delivery.status === 'sending') {
        this.sql.exec('UPDATE deliveries SET system_payload = ? WHERE id = ?', JSON.stringify({...system, refresh_after_send: true}), delivery.id);
        continue;
      }
      if (delivery.status !== 'pending') {
        if (slots <= 0) {
          this.sql.exec('UPDATE deliveries SET system_payload=?, telegram_message_id=?, updated_at=? WHERE id=?',JSON.stringify({...system, incident_dirty: true, incident_refresh_pending: true}),messageId,now,delivery.id);continue;
        }
        slots--;
      }
      this.sql.exec("UPDATE deliveries SET status = 'pending', stage_attempts = 0, next_attempt = ?, system_payload = ?, rendered = ?, telegram_message_id = ?, updated_at = ? WHERE id = ?", due, JSON.stringify(system), formatNotification(incident.input), messageId, now, delivery.id);
      this.applyDeliveryPreferences({...delivery, next_attempt: due, system_payload: JSON.stringify(system)}, incident.input, now);
    }
    this.invalidate();
  }

  /** State changes are durable even when the delivery queue is full; promote edits as slots free up. */
  private flushIncidentRefreshes(now: number): void {
    const slots = Math.min(20,Math.max(0,this.maxPendingDeliveries-this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending','sending')")));
    if (!slots) return;
    for (const row of this.rows<DeliveryRow>("SELECT * FROM deliveries WHERE status NOT IN ('pending','sending') AND json_extract(system_payload, '$.incident_refresh_pending') = 1 ORDER BY updated_at LIMIT ?",slots)) {
      const system = JSON.parse(row.system_payload!); delete system.incident_refresh_pending;
      const incident = row.incident_id ? this.automation.getStored(row.incident_id) : null;
      const active = incident && this.recipientAllowed(incident.applicationId,row.chat_id);
      this.sql.exec('UPDATE deliveries SET status=?, next_attempt=?, stage_attempts=0, system_payload=?, updated_at=? WHERE id=?',active?'pending':'skipped',now,JSON.stringify(system),now,row.id);
    }
    this.invalidate();
  }

  private processIncidentDeadlines(runtime: TenantRuntime, now: number): void {
    for (const incident of this.automation.due(now)) {
      const policy = this.automation.getPolicy(incident.applicationId ?? undefined).policy;
      if (incident.status === 'snoozed') {
        incident.status = incident.acknowledgedAt ? 'acknowledged' : 'open'; incident.snoozedUntil = null; incident.version++;
        incident.nextEscalationAt = incident.status === 'open' && policy.escalation.enabled && incident.level === 'critical' ? new Date(now + policy.escalation.afterMinutes * 60000).toISOString() : null;
        this.automation.event(incident.id, 'resumed', 'Snooze expired.', now); this.automation.save(incident); this.refreshIncidentDeliveries(incident, now, true); continue;
      }
      if (!policy.escalation.enabled || incident.level !== 'critical' || incident.escalationCount >= policy.escalation.targetChatIds.length) { incident.nextEscalationAt = null; this.automation.save(incident); continue; }
      if (this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending','sending')") >= runtime.limits.maxPendingDeliveries) {
        incident.nextEscalationAt = new Date(now+30000).toISOString(); this.automation.save(incident); continue;
      }
      const target = policy.escalation.targetChatIds[incident.escalationCount];
      incident.escalationCount++; incident.version++;
      incident.nextEscalationAt = incident.escalationCount < policy.escalation.targetChatIds.length ? new Date(now+policy.escalation.afterMinutes*60000).toISOString() : null;
      this.automation.save(incident);
      if (this.recipientAllowed(incident.applicationId, target)) {
        const system = {method: 'sendRichMessage', rich_message: formatRichNotification({...incident.input, title: `Escalation ${incident.escalationCount} · ${incident.title}`}, incident.source, this.getSettings().showCountryFlag, incident.notificationId, incident), escalationIncident: incident.id};
        this.sql.exec('INSERT INTO deliveries (chat_id, rendered, system_payload, updated_at) VALUES (?, ?, ?, ?)', target, `Escalation · ${incident.title}`, JSON.stringify(system), now);
        const delivery = this.rows<DeliveryRow>('SELECT * FROM deliveries WHERE id = last_insert_rowid()')[0];
        this.applyDeliveryPreferences(delivery, incident.input, now);
        this.automation.event(incident.id, 'escalated', `Escalated to subscriber ${target}.`, now);
      } else this.automation.event(incident.id, 'escalation_skipped', 'Escalation recipient is no longer eligible.', now);
    }
  }

  private queuePreferencesPrompt(chatId: string, runtime: TenantRuntime, messageId?: number): boolean {
    if (this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending','sending')") >= runtime.limits.maxPendingDeliveries) return false;
    const prefs = this.getSubscriberPreferences(chatId);
    const keyboard = [
      LEVELS.map(level => ({text: `${prefs.levels.includes(level) ? '✓ ' : ''}${level}`, callback_data: `prefs:level:${level}`})),
      [{text: prefs.environments.length ? 'Environment: production' : 'Environment: all', callback_data: 'prefs:environment'}],
      [{text: prefs.delivery === 'digest' ? `Digest: ${prefs.digestMinutes}m` : 'Delivery: immediate', callback_data: 'prefs:digest'}, {text: `Quiet: ${prefs.quietHours.enabled ? 'on' : 'off'}`, callback_data: 'prefs:quiet'}],
      [{text: `Critical bypass: ${prefs.criticalBypass ? 'on' : 'off'}`, callback_data: 'prefs:critical'}]
    ];
    const system = {method: messageId ? 'editMessageText' : 'sendMessage', ...(messageId ? {message_id: messageId} : {}), preferences_version: prefs.version, reply_markup: {inline_keyboard: keyboard}};
    const text = `⚙️ Notification preferences\nLevels: ${prefs.levels.join(', ')}\nEnvironment: ${prefs.environments.join(', ') || 'all'}\nTimezone: ${prefs.timezone}\nQuiet hours: ${prefs.quietHours.start}–${prefs.quietHours.end}\nChange timezone: /timezone Europe/Berlin\nChange quiet hours: /quiet 22:00 08:00\nOnly applications you are allowed to receive are included.`;
    this.sql.exec('INSERT INTO deliveries (chat_id, rendered, system_payload, updated_at) VALUES (?, ?, ?, ?)', chatId, text, JSON.stringify(system), Date.now()); this.invalidate(); return true;
  }

  async handleUpdate(update: unknown): Promise<void> {
    if (!update || typeof update !== 'object') return;
    const value = update as Record<string, unknown>;
    if (!Number.isSafeInteger(value.update_id)) return;
    const runtime = await this.runtime();
    const callback = value.callback_query as {
      id?: unknown; data?: unknown; from?: { id?: unknown };
      message?: { message_id?: unknown; chat?: { id?: unknown; type?: string } };
    } | undefined;
    const ownsCallback = callback?.message?.chat?.type === 'private' &&
      Number.isSafeInteger(callback.message.chat.id) && callback.from?.id === callback.message.chat.id &&
      Number.isSafeInteger(callback.message.message_id) && Number(callback.message.message_id) > 0 &&
      typeof callback.id === 'string' && callback.id.length <= 256 && typeof callback.data === 'string';
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
        const incidentAction = /^inc:(ack|snooze|resolve):([a-f0-9-]{36})$/.exec(String(callback.data));
        if (incidentAction) {
          const incident = this.automation.getStored(incidentAction[2]);
          const receipt = this.rows(`SELECT 1 FROM deliveries WHERE chat_id = ? AND telegram_message_id = ? AND (incident_id = ? OR json_extract(system_payload, '$.escalationIncident') = ?) LIMIT 1`, chatId, Number(callback.message!.message_id), incidentAction[2], incidentAction[2]).length;
          acknowledge = true;
          if (!incident || !receipt || !this.canActOnIncident(incident, chatId)) { acknowledgement = 'Action is not permitted.'; return; }
          if (incident.status === 'resolved') { acknowledgement = 'This incident is already resolved.'; return; }
          const action = incidentAction[1] === 'ack' ? 'acknowledge' : incidentAction[1];
          const changed = this.automation.act(incident.id, {action, expectedVersion: incident.version, ...(action === 'snooze' ? {minutes: 15} : {})}, now, chatId);
          this.refreshIncidentDeliveries(changed, now, true);
          acknowledgement = `Incident ${changed.status}.`; return;
        }
        if (String(callback.data).startsWith('prefs:')) {
          const receipt = this.rows("SELECT 1 FROM deliveries WHERE chat_id = ? AND telegram_message_id = ? AND json_extract(system_payload, '$.preferences_version') IS NOT NULL LIMIT 1", chatId, Number(callback.message!.message_id)).length;
          if (!receipt) return;
          const preferences = this.getSubscriberPreferences(chatId);
          const {version, ...patch} = preferences;
          const level = /^prefs:level:(info|success|warning|error|critical)$/.exec(String(callback.data))?.[1] as typeof LEVELS[number] | undefined;
          if (level) patch.levels = patch.levels.includes(level) ? patch.levels.filter(item => item !== level) : [...patch.levels, level];
          else if (callback.data === 'prefs:environment') patch.environments = patch.environments.length ? [] : ['production'];
          else if (callback.data === 'prefs:digest') patch.delivery = patch.delivery === 'digest' ? 'immediate' : 'digest';
          else if (callback.data === 'prefs:quiet') patch.quietHours = {...patch.quietHours, enabled: !patch.quietHours.enabled};
          else if (callback.data === 'prefs:critical') patch.criticalBypass = !patch.criticalBypass;
          else return;
          this.automation.updatePreferences(chatId, {...patch, expectedVersion: version});
          this.rescheduleSubscriberPreferences(chatId);
          this.queuePreferencesPrompt(chatId, runtime, Number(callback.message!.message_id)); acknowledge = true; return;
        }
        const visibleApplications = this.allowedApplications(chatId);
        const appId = /^apps:toggle:([a-z0-9][a-z0-9_-]{0,63})$/.exec(String(callback.data))?.[1];
        const pageMatch = /^apps:page:(\d{1,3})$/.exec(String(callback.data));
        const page = pageMatch ? Number(pageMatch[1]) : appId ? Math.floor(visibleApplications.findIndex((app) => app.id === appId) / 20) : 0;
        if (pageMatch) {
          if (page >= Math.max(1, Math.ceil(visibleApplications.length / 20))) return;
          acknowledgement = 'فهرست اپلیکیشن‌ها به‌روز شد.';
        } else {
          if (callback.data !== 'apps:all' && (!appId || !visibleApplications.some((app) => app.id === appId))) return;
          this.changeApplications(chatId, appId ?? null);
        }
        this.queueApplicationPrompt(chatId, visibleApplications, runtime, Number(callback.message!.message_id), page);
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
        const command = /^\/(start|stop|apps|all|preferences|timezone|quiet)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(message.text)?.[1];
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
        else if (command === 'preferences' || command === 'timezone' || command === 'quiet') {
          const subscriber = this.rows('SELECT active, banned FROM subscribers WHERE chat_id = ?', chatId)[0];
          if (!runtime.enabled || !subscriber || subscriber.active !== 1 || subscriber.banned === 1) return;
          if (command !== 'preferences') {
            const prefs = this.getSubscriberPreferences(chatId);
            const {version, ...patch} = prefs;
            const arguments_ = message.text.trim().split(/\s+/).slice(1);
            if (command === 'timezone') patch.timezone = arguments_[0] ?? '';
            else patch.quietHours = {enabled: true, start: arguments_[0] ?? '', end: arguments_[1] ?? ''};
            try { this.automation.updatePreferences(chatId, {...patch, expectedVersion: version}); this.rescheduleSubscriberPreferences(chatId); }
            catch (error) { if (!(error instanceof AppError)) throw error; }
          }
          if (!this.queuePreferencesPrompt(chatId, runtime)) return new AppError(429, 'QUEUE_LIMIT', 'QUEUE_LIMIT: There is no capacity for the preferences menu.');
        }
        else if (command === 'apps' || command === 'all') {
          const subscriber = this.rows('SELECT active, banned FROM subscribers WHERE chat_id = ?', chatId)[0];
          if (!runtime.enabled || !subscriber || subscriber.active !== 1 || subscriber.banned === 1) return;
          if (command === 'all') this.changeApplications(chatId, null);
          if (!this.queueApplicationPrompt(chatId, this.allowedApplications(chatId), runtime)) return new AppError(429, 'QUEUE_LIMIT', 'QUEUE_LIMIT: There is no capacity for the application preferences menu.');
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
      try {
        await telegramCall(runtime.botToken, 'answerCallbackQuery', {
          callback_query_id: callback!.id,
          text: acknowledgement
        });
      } catch { /* Preferences remain durable even when Telegram cannot dismiss its spinner. */
      }
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
      if (count) this.sql.exec(`UPDATE deliveries
                                SET status     = 'skipped',
                                    error      = 'Subscriber excluded this application.',
                                    updated_at = ?
                                WHERE chat_id = ?
                                  AND status = 'pending'
                                  AND notification_id IN (SELECT n.id
                                                          FROM notifications n
                                                          WHERE NOT EXISTS (SELECT 1
                                                                            FROM subscriber_applications p
                                                                            WHERE p.chat_id = ?
                                                                              AND p.application_id = json_extract(n.input, '$.applicationId')))`, Date.now(), chatId, chatId);
    }
    this.invalidate();
  }

  private queueApplicationPrompt(chatId: string, applications: DirectoryApplication[], runtime: TenantRuntime, messageId?: number, page = 0): boolean {
    if (this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('pending', 'sending')") >= runtime.limits.maxPendingDeliveries) return false;
    const subscriber = this.rows('SELECT application_mode, access_mode, version FROM subscribers WHERE chat_id = ?', chatId)[0];
    if (!subscriber) return false;
    const all = subscriber.application_mode !== 'selected';
    const allLabel = subscriber.access_mode === 'selected' ? 'همه اپلیکیشن‌های مجاز' : 'همه اپلیکیشن‌ها';
    const selected = new Set(this.rows('SELECT application_id FROM subscriber_applications WHERE chat_id = ?', chatId).map((row) => String(row.application_id)));
    const text = all
      ? `📬 دریافت اعلان: ${allLabel}\nبرای دریافت فقط از یک اپلیکیشن، دکمه آن را انتخاب کنید. انتخاب دوباره آخرین مورد، دریافت همه اپلیکیشن‌های مجاز را فعال می‌کند.`
      : '📬 دریافت اعلان: فقط اپلیکیشن‌های انتخاب‌شده\nبا دکمه‌ها انتخاب‌ها را تغییر دهید. تغییرات همان لحظه ذخیره می‌شوند؛ انتخاب دوباره آخرین مورد، دریافت همه را فعال می‌کند.';
    const inline_keyboard = [
      [{text: `${all ? '✅ ' : ''}${allLabel}`, callback_data: 'apps:all'}],
      ...applications.slice(page * 20, (page + 1) * 20).map((app) => [{
        text: `${!all && selected.has(app.id) ? '✅ ' : ''}${app.name.slice(0, 50)}`,
        callback_data: `apps:toggle:${app.id}`
      }]),
    ];
    const navigation = [];
    if (page > 0) navigation.push({text: 'قبلی', callback_data: `apps:page:${page - 1}`});
    if ((page + 1) * 20 < applications.length) navigation.push({text: 'بعدی', callback_data: `apps:page:${page + 1}`});
    if (navigation.length) inline_keyboard.push(navigation);
    const payload = {
      method: messageId ? 'editMessageText' : 'sendMessage',
      subscriber_version: Number(subscriber.version),
      directory_version: this.applicationDirectoryVersion, ...(messageId ? {message_id: messageId} : {}),
      reply_markup: {inline_keyboard}
    };
    this.sql.exec('INSERT INTO deliveries (chat_id, rendered, system_payload, updated_at) VALUES (?, ?, ?, ?)', chatId, text, JSON.stringify(payload), Date.now());
    this.invalidate();
    return true;
  }

  private allowedApplications(chatId: string): DirectoryApplication[] {
    // Use the newest local snapshot even if a previous registry read arrived after an update.
    return this.rows(`SELECT a.application_id, a.name FROM application_access a JOIN subscribers s ON s.chat_id = ?
      WHERE a.enabled = 1 AND a.show_in_directory = 1
      AND (a.audience_mode = 'all' OR EXISTS (SELECT 1 FROM application_audience p WHERE p.application_id = a.application_id AND p.chat_id = s.chat_id))
      AND (s.access_mode = 'all' OR EXISTS (SELECT 1 FROM subscriber_allowed_applications p WHERE p.chat_id = s.chat_id AND p.application_id = a.application_id))
      ORDER BY a.application_id`, chatId).map((row) => ({id: String(row.application_id), name: String(row.name)}));
  }

  private recipientWhere(applicationId: string): string {
    return `s.active = 1 AND s.banned = 0
      AND (s.application_mode = 'all' OR EXISTS (SELECT 1 FROM subscriber_applications p WHERE p.chat_id = s.chat_id AND p.application_id = ${applicationId}))
      AND (s.access_mode = 'all' OR EXISTS (SELECT 1 FROM subscriber_allowed_applications p WHERE p.chat_id = s.chat_id AND p.application_id = ${applicationId}))
      AND (${applicationId} IS NULL OR EXISTS (SELECT 1 FROM application_access a WHERE a.application_id = ${applicationId} AND a.enabled = 1
        AND (a.audience_mode = 'all' OR EXISTS (SELECT 1 FROM application_audience p WHERE p.application_id = a.application_id AND p.chat_id = s.chat_id))))`;
  }

  /** Re-read local policy after each await; an in-flight attempt must not resurrect a revoked retry. */
  private acceptsDelivery(delivery: DeliveryRow): boolean {
    const subscriber = this.rows('SELECT active, banned, access_mode, application_mode, version FROM subscribers WHERE chat_id = ?', delivery.chat_id)[0];
    if (!subscriber || subscriber.active !== 1 || subscriber.banned === 1) return false;
    if (delivery.notification_id) {
      return this.rows(`WITH request AS (SELECT ? AS app_id)
        SELECT 1 FROM subscribers s CROSS JOIN request r WHERE s.chat_id = ? AND ${this.recipientWhere('r.app_id')}`, delivery.application_id, delivery.chat_id).length > 0;
    }
    if (!delivery.system_payload) return true;
    try {
      const system = JSON.parse(delivery.system_payload) as {
        preferences_version?: number;
        escalationIncident?: string;
        subscriber_version?: number;
        directory_version?: number;
        reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
      };
      if (system.preferences_version !== undefined && this.getSubscriberPreferences(delivery.chat_id).version !== system.preferences_version) return false;
      if (system.escalationIncident) {
        const incident = this.automation.getStored(system.escalationIncident);
        if (!incident || incident.status !== 'open' || incident.level !== 'critical' || !this.recipientAllowed(incident.applicationId, delivery.chat_id)) return false;
        const policy = this.automation.getPolicy(incident.applicationId ?? undefined).policy;
        if (!policy.escalation.enabled || !policy.escalation.targetChatIds.includes(delivery.chat_id)) return false;
      }
      if (system.subscriber_version !== undefined && system.subscriber_version !== subscriber.version) return false;
      if (system.directory_version !== undefined && system.directory_version !== this.applicationDirectoryVersion) return false;
      // Old queued menus predate the version marker: inspect their actual application buttons.
      const ids = system.reply_markup?.inline_keyboard?.flat().map((button) => /^apps:toggle:(.+)$/.exec(button.callback_data ?? '')?.[1]).filter((id): id is string => !!id) ?? [];
      if (subscriber.access_mode === 'selected') {
        const allowed = new Set(this.rows('SELECT application_id FROM subscriber_allowed_applications WHERE chat_id = ?', delivery.chat_id).map((row) => String(row.application_id)));
        if (ids.some((id) => !allowed.has(id))) return false;
      }
      if (ids.length && this.count(`SELECT COUNT(*) AS count FROM application_access a
        WHERE a.application_id IN (SELECT value FROM json_each(?)) AND a.enabled = 1 AND a.show_in_directory = 1
        AND (a.audience_mode = 'all' OR EXISTS (SELECT 1 FROM application_audience p WHERE p.application_id = a.application_id AND p.chat_id = ?))`, JSON.stringify(ids), delivery.chat_id) !== new Set(ids).size) return false;
      return true;
    } catch {
      return false;
    }
  }

  private deactivate(chatId: string, reason: string): void {
    const now = Date.now();
    this.sql.exec('UPDATE subscribers SET active = 0, updated_at = ? WHERE chat_id = ?', now, chatId);
    this.sql.exec("UPDATE deliveries SET status = 'skipped', error = ?, updated_at = ? WHERE chat_id = ? AND status = 'pending'", reason, now, chatId);
    this.invalidate();
  }

  private recoverInterrupted(): void {
    this.sql.exec("UPDATE deliveries SET status = 'pending', next_attempt = ?, updated_at = ?, error = 'Interrupted message edit will retry.' WHERE status = 'sending' AND telegram_message_id IS NOT NULL AND json_extract(system_payload, '$.method') = 'editMessageText' AND COALESCE(json_extract(system_payload, '$.was_digest'),0) = 0 AND stage_attempts < ?", Date.now()+1000, Date.now(), MAX_ATTEMPTS);
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
        this.processIncidentDeadlines(runtime, now);
        this.flushIncidentRefreshes(now);
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
        const currentInput = this.deliveryInput(delivery);
        if (currentInput) {
          this.applyDeliveryPreferences(delivery, currentInput, now);
          const prepared = this.rows<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', delivery.id)[0];
          if (prepared.status !== 'pending' || prepared.next_attempt > now) continue;
          delivery.system_payload = prepared.system_payload;
        }
        const queueEpoch = this.wakeEpoch;
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("UPDATE deliveries SET status = 'sending', attempts = attempts + 1, stage_attempts = stage_attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'", now, delivery.id);
          this.sql.exec('UPDATE subscribers SET next_send_at = ? WHERE chat_id = ?', now + 1_000, delivery.chat_id);
          this.sql.exec("INSERT INTO queue_state (key, value) VALUES ('next_send_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", now + Math.ceil(1_000 / Math.max(1, Math.min(20, settings.deliveryPerSecond))));
          this.invalidate();
        });
        await this.ctx.storage.sync();
        if (queueEpoch !== this.wakeEpoch || this.getSettings().paused) {this.sql.exec("UPDATE deliveries SET status='pending',next_attempt=? WHERE id=?",Date.now()+100,delivery.id);continue;}
        if (!this.acceptsDelivery(delivery)) {
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
    let batch: DeliveryRow[] = [delivery];
    let editing = false;
    try {
      let system = delivery.system_payload ? JSON.parse(delivery.system_payload) as Record<string, any> : null;
      if (system?.incident_dirty && delivery.incident_id) {
        const incident = this.automation.getStored(delivery.incident_id);
        if (incident) {
          const messageId = system.was_digest ? null : delivery.telegram_message_id;
          system = {...system, method: messageId ? 'editMessageText' : 'sendRichMessage', rich_message: formatRichNotification(incident.input, incident.source, this.getSettings().showCountryFlag, incident.notificationId, incident)};
          delete system.incident_dirty; delete system.refresh_after_send;
          if (messageId) system.message_id = messageId; else delete system.message_id;
          this.sql.exec('UPDATE deliveries SET system_payload=? WHERE id=?',JSON.stringify(system),delivery.id);
        }
      }
      const input = this.deliveryInput(delivery);
      if (input) {
        const policy = this.automation.getPolicy(input.applicationId).policy;
        const preferences = this.getSubscriberPreferences(delivery.chat_id);
        const decision = evaluateDelivery(input, policy, preferences, Date.now());
        const digestChanged = decision.mode === 'digest' && (system?.digest_version !== `${policy.version}:${preferences.version}` || !system?.digest_due || system.digest_due > Date.now());
        if (decision.mode === 'mute' || decision.mode === 'defer' || decision.reason === 'quiet_hours' || digestChanged) {
          this.applyDeliveryPreferences(delivery, input, Date.now()); return;
        }
        if (decision.mode === 'immediate' && system) system.delivery_mode = 'immediate';
      }
      const digest = system?.delivery_mode === 'digest' && Number(system.digest_due) <= Date.now();
      if (digest) {
        const candidates = this.rows<DeliveryRow>(`SELECT d.*, json_extract(n.input, '$.applicationId') AS application_id FROM deliveries d LEFT JOIN notifications n ON n.id = d.notification_id
          WHERE d.chat_id = ? AND d.status = 'pending' AND d.next_attempt <= ? AND json_extract(d.system_payload, '$.delivery_mode') = 'digest'
          AND json_extract(d.system_payload, '$.digest_due') <= ? ORDER BY d.id LIMIT 19`, delivery.chat_id, Date.now(), Date.now());
        for (const candidate of candidates) {
          if (!this.acceptsDelivery(candidate)) {this.sql.exec("UPDATE deliveries SET status='skipped', error='Recipient is no longer eligible.', updated_at=? WHERE id=?",Date.now(),candidate.id);continue;}
          const item = this.deliveryInput(candidate); if (!item) continue;
          const decision = evaluateDelivery(item, this.automation.getPolicy(item.applicationId).policy, this.getSubscriberPreferences(candidate.chat_id), Date.now());
          if (decision.mode === 'mute' || decision.mode === 'defer' || decision.reason === 'quiet_hours') {this.applyDeliveryPreferences(candidate,item,Date.now());continue;}
          batch.push(candidate);
        }
        const rich = formatRichDigest(batch.map(item => ({input: this.deliveryInput(item)!, ...(item.incident_id ? {incident: this.automation.getStored(item.incident_id) ?? undefined} : {})})), new Date(Date.now()).toISOString());
        system = {...system, method: 'sendRichMessage', rich_message: rich, was_digest: true}; delete system.message_id;
        this.ctx.storage.transactionSync(() => {
          for (const item of batch) {
            const metadata = JSON.parse(item.system_payload || '{}');
            delete metadata.message_id;
            this.sql.exec("UPDATE deliveries SET status='sending', telegram_message_id=NULL, stage_attempts=stage_attempts+?, attempts=attempts+?, system_payload=?, updated_at=? WHERE id=?", item.id === delivery.id ? 0 : 1, item.id === delivery.id ? 0 : 1, JSON.stringify({...metadata, method:'sendRichMessage', was_digest:true}), Date.now(), item.id);
          }
        });
        const digestEpoch = this.wakeEpoch;
        // Every member becomes uncertain together if the isolate disappears during the one network attempt.
        await this.ctx.storage.sync();
        const changedPreferences = (item: DeliveryRow) => {
          const input = this.deliveryInput(item)!;
          const policy = this.automation.getPolicy(input.applicationId).policy;
          const prefs = this.getSubscriberPreferences(item.chat_id);
          const decision = evaluateDelivery(input,policy,prefs,Date.now());
          return ['mute','defer'].includes(decision.mode) || decision.reason === 'quiet_hours' || (decision.mode === 'digest' && JSON.parse(item.system_payload || '{}').digest_version !== `${policy.version}:${prefs.version}`);
        };
        if (digestEpoch !== this.wakeEpoch || this.getSettings().paused || batch.some(item => !this.acceptsDelivery(item) || changedPreferences(item))) {
          for (const item of batch) {
            if (!this.acceptsDelivery(item)) this.sql.exec("UPDATE deliveries SET status='skipped', error='Digest audience changed before send.',updated_at=? WHERE id=?",Date.now(),item.id);
            else this.applyDeliveryPreferences({...item, next_attempt: Date.now()+100},this.deliveryInput(item)!,Date.now());
          }
          return;
        }
      }
      const rich = !!system?.rich_message && (system.method === 'sendRichMessage' || system.method === 'editMessageText');
      editing = system?.method === 'editMessageText';
      const isPhoto = !rich && !!delivery.image && delivery.stage === 0;
      const separateText = isPhoto && delivery.rendered.length > 1_024;
      const payload: Record<string, unknown> = {chat_id: delivery.chat_id, disable_notification: !!delivery.silent};
      if (rich) {
        if (typeof system!.rich_message !== 'object' || Array.isArray(system!.rich_message)) throw new TelegramError('The stored rich notification is invalid.', 0);
        payload.rich_message = system!.rich_message;
        if (editing) payload.message_id = system!.message_id;
      } else {
        if (system?.reply_markup) payload.reply_markup = system.reply_markup;
        if (system?.message_id) payload.message_id = system.message_id;
        if (isPhoto) { payload.photo = delivery.image; payload.caption = separateText ? `${delivery.rendered.split('\n')[0].slice(0,900)}\nDetails follow in the next message.` : delivery.rendered; }
        else { payload.text = delivery.rendered; payload.link_preview_options = {is_disabled:true}; }
      }
      const method = editing ? 'editMessageText' : rich ? 'sendRichMessage' : isPhoto ? 'sendPhoto' : 'sendMessage';
      if (editing) delete payload.disable_notification;
      const result = await telegramCall(botToken,method,payload);
      const messageId = Number(result.result?.message_id);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new TelegramError('Telegram response is uncertain (missing message identifier).',0,true);
      const now = Date.now();
      for (const item of batch) {
        const latest = this.rows<DeliveryRow>('SELECT * FROM deliveries WHERE id = ?', item.id)[0];
        const latestSystem = latest?.system_payload ? JSON.parse(latest.system_payload) : {};
        if (latestSystem.refresh_after_send && item.incident_id) {
          delete latestSystem.refresh_after_send;
          latestSystem.method = digest ? 'sendRichMessage' : 'editMessageText';
          if (digest) {delete latestSystem.message_id; delete latestSystem.was_digest; delete latestSystem.digest_due;} else latestSystem.message_id = messageId;
          this.sql.exec("UPDATE deliveries SET status='pending',stage_attempts=0,telegram_message_id=?,system_payload=?,next_attempt=?,error=NULL,updated_at=? WHERE id=?", digest ? null : messageId,JSON.stringify(latestSystem),now+1000,now,item.id);
        } else if (separateText) {
          const active = this.acceptsDelivery(item);
          this.sql.exec('UPDATE deliveries SET status=?,stage=1,stage_attempts=0,error=?,next_attempt=?,telegram_message_id=?,updated_at=? WHERE id=?',active?'pending':'skipped',active?null:'Photo was delivered; subscriber stopped before text delivery.',now+1000,messageId,now,item.id);
        } else this.sql.exec("UPDATE deliveries SET status='sent',error=NULL,telegram_message_id=?,updated_at=? WHERE id=?",messageId,now,item.id);
      }
    } catch (error) {
      const failure = error instanceof TelegramError ? error : new TelegramError('Delivery result is uncertain.',0,true);
      const now = Date.now();
      if (failure.code === 429 && failure.retryAfter) this.sql.exec("INSERT INTO queue_state (key,value) VALUES ('next_send_at',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)",now+failure.retryAfter*1000);
      for (const item of batch) {
        const active = this.acceptsDelivery(item);
        const retry = (failure.code === 429 && failure.retryAfter) || (editing && failure.uncertain);
        if (retry && item.stage_attempts+1 < MAX_ATTEMPTS && active) {
          const retryAt = now + (failure.retryAfter ? failure.retryAfter*1000 : Math.min(30000, 1000*2**item.stage_attempts));
          this.sql.exec("UPDATE deliveries SET status='pending',next_attempt=?,error=?,updated_at=? WHERE id=?",retryAt,failure.message,now,item.id);
        } else {
          const status = failure.uncertain ? 'unknown' : !active && failure.code === 429 ? 'skipped' : 'failed';
          this.sql.exec('UPDATE deliveries SET status=?,error=?,updated_at=? WHERE id=?',status,(item.stage>0?'Photo was delivered. ':'')+failure.message,now,item.id);
        }
      }
      if (failure.code === 403 && !failure.uncertain) this.deactivate(delivery.chat_id,'Bot blocked or access to this chat was revoked.');
    } finally {this.invalidate();}
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
      const queueDue = this.rows(`SELECT MIN(MAX(d.next_attempt, s.next_send_at)) AS due
                              FROM deliveries d
                                       JOIN subscribers s ON s.chat_id = d.chat_id
                              WHERE d.status = 'pending'
                                AND s.active = 1
                                AND s.banned = 0`)[0]?.due;
      const deadline = this.automation.nextDeadline();
      const deferredEdit = typeof queueDue !== 'number' && this.count("SELECT COUNT(*) AS count FROM deliveries WHERE status NOT IN ('pending','sending') AND json_extract(system_payload, '$.incident_refresh_pending') = 1") ? now+100 : Infinity;
      const next = Math.min(typeof queueDue === 'number' ? queueDue : Infinity, deadline ?? Infinity,deferredEdit);
      if (Number.isFinite(next)) {
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
                                    AND NOT EXISTS (SELECT 1 FROM notification_incidents ni JOIN incidents i ON i.id = ni.incident_id WHERE ni.notification_id = n.id AND (i.status != 'resolved' OR i.last_seen >= ?))
                                    AND NOT EXISTS (SELECT 1
                                                    FROM deliveries d
                                                    WHERE d.notification_id = n.id
                                                      AND d.status IN ('pending', 'sending'))
                                  ORDER BY n.created_at LIMIT 100
                         )`, cutoff, cutoff);
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
      this.sql.exec('DELETE FROM notification_incidents WHERE notification_id IN (SELECT ni.notification_id FROM notification_incidents ni WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.id = ni.notification_id) LIMIT 500)');
      this.sql.exec("DELETE FROM incident_events WHERE id IN (SELECT e.id FROM incident_events e JOIN incidents i ON i.id = e.incident_id WHERE i.last_seen < ? AND i.status = 'resolved' LIMIT 500)", cutoff);
      this.sql.exec("DELETE FROM incidents WHERE id IN (SELECT i.id FROM incidents i WHERE i.last_seen < ? AND i.status = 'resolved' AND NOT EXISTS (SELECT 1 FROM incident_events e WHERE e.incident_id = i.id) AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.incident_id = i.id AND d.status IN ('pending','sending')) LIMIT 100)", cutoff);
      this.sql.exec('DELETE FROM telegram_updates WHERE id IN (SELECT id FROM telegram_updates WHERE received_at < ? LIMIT 500)', now - 7 * DAY);
      this.sql.exec('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < ? LIMIT 500)', now);
      this.sql.exec("INSERT INTO queue_state (key, value) VALUES ('last_cleanup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", now);
    });
    this.lastCleanupAt = now;
    this.invalidate();
  }
}
