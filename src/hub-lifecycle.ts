import {AppError} from './types';

const BATCH_SIZE = 500;
const BOT_TABLES = [
  'deliveries', 'notification_incidents', 'incident_events', 'subscriber_applications',
  'subscriber_allowed_applications', 'application_audience', 'subscriber_preferences',
  'notifications', 'incidents', 'subscribers', 'application_access', 'automation_policies',
  'telegram_updates', 'rate_limits', 'daily_usage', 'queue_state', 'settings',
] as const;

/** Retain deletion fences while erasing bounded pages of this bot's private data. */
export class HubLifecycle {
  private readonly sql: SqlStorage;
  private readonly applications = new Set<string>();
  deleted = false;
  
  /** Restore fences before the hub can initialize settings, accept work or restore alarms. */
  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS hub_tombstones (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind,id))');
    for (const row of this.sql.exec<{ kind: string; id: string }>('SELECT kind,id FROM hub_tombstones')) {
      if (row.kind === 'bot') this.deleted = true;
      else if (row.kind === 'application') this.applications.add(row.id);
    }
  }
  
  /** Reject stale RPC requests after a bot has been permanently removed. */
  assertActive(): void {
    if (this.deleted) throw new AppError(404, 'RESOURCE_DELETED', 'RESOURCE_DELETED: This bot has been deleted.');
  }
  
  /** Exclude a deleted application even if an older policy snapshot arrives later. */
  applicationDeleted(id: string): boolean {
    return this.applications.has(id);
  }
  
  /** Commit the stop marker before any asynchronous cleanup or storage operation. */
  retire(): void {
    this.sql.exec("INSERT OR IGNORE INTO hub_tombstones(kind,id) VALUES('bot','')");
    this.deleted = true;
  }
  
  /** Revoke one application's queued work before erasing its historical records. */
  retireApplication(id: string): boolean {
    if (this.applications.has(id)) return false;
    this.sql.exec("INSERT OR IGNORE INTO hub_tombstones(kind,id) VALUES('application',?)", id);
    this.applications.add(id);
    return true;
  }
  
  /** Delete a bounded page without cascading an unbounded recipient fan-out. */
  private erase(table: string, where = '1', bindings: SqlStorageValue[] = []): void {
    this.sql.exec(`DELETE
                   FROM ${table}
                   WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${BATCH_SIZE})`, ...bindings);
  }
  
  /** Report whether another durable cleanup pass is necessary. */
  private hasRows(table: string, where = '1', bindings: SqlStorageValue[] = []): boolean {
    return this.sql.exec(`SELECT 1
                          FROM ${table}
                          WHERE ${where} LIMIT 1`, ...bindings).toArray().length > 0;
  }
  
  /** Purge bot-owned records while preserving the identity and permanent stop marker. */
  purgeBot(): boolean {
    this.storage.transactionSync(() => {
      for (const table of BOT_TABLES) {
        if (table === 'notifications') this.erase(table, 'NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.notification_id=notifications.id)');
        else if (table === 'subscribers') this.erase(table, 'NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.chat_id=subscribers.chat_id) AND NOT EXISTS (SELECT 1 FROM subscriber_applications a WHERE a.chat_id=subscribers.chat_id) AND NOT EXISTS (SELECT 1 FROM subscriber_allowed_applications a WHERE a.chat_id=subscribers.chat_id)');
        else this.erase(table);
      }
    });
    return !BOT_TABLES.some(table => this.hasRows(table));
  }
  
  /** Remove one application's history and permissions without resetting bot-wide usage or other apps. */
  purgeApplication(id: string): boolean {
    const notifications = "SELECT id FROM notifications WHERE json_extract(input,'$.applicationId')=?";
    const incidents = 'SELECT id FROM incidents WHERE application_id=?';
    // Older escalation deliveries store ownership only in their JSON payload.
    // Keep the incident until every delivery page is gone so that ownership
    // remains available on the next cleanup pass, including after eviction.
    const deliveries = `notification_id IN (${notifications}) OR incident_id IN (${incidents}) OR json_extract(system_payload,'$.escalationIncident') IN (${incidents})`;
    this.storage.transactionSync(() => {
      this.erase('deliveries', deliveries, [id, id, id]);
      this.erase('notification_incidents', `notification_id IN (${notifications}) OR incident_id IN (${incidents})`, [id, id]);
      this.erase('incident_events', `incident_id IN (${incidents})`, [id]);
      for (const table of ['subscriber_applications', 'subscriber_allowed_applications', 'application_audience', 'application_access']) this.erase(table, 'application_id=?', [id]);
      this.erase('automation_policies', 'scope=?', [id]);
      this.erase('notifications', "json_extract(input,'$.applicationId')=? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.notification_id=notifications.id) AND NOT EXISTS (SELECT 1 FROM notification_incidents ni WHERE ni.notification_id=notifications.id)", [id]);
      this.erase('incidents', "application_id=? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.incident_id=incidents.id OR json_extract(d.system_payload,'$.escalationIncident')=incidents.id) AND NOT EXISTS (SELECT 1 FROM incident_events e WHERE e.incident_id=incidents.id) AND NOT EXISTS (SELECT 1 FROM notification_incidents ni WHERE ni.incident_id=incidents.id)", [id]);
    });
    return !this.hasRows('notifications', "json_extract(input,'$.applicationId')=?", [id])
      && !this.hasRows('incidents', 'application_id=?', [id])
      && !['subscriber_applications', 'subscriber_allowed_applications', 'application_audience', 'application_access'].some(table => this.hasRows(table, 'application_id=?', [id]))
      && !this.hasRows('automation_policies', 'scope=?', [id]);
  }
}
