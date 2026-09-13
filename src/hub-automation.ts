import {AppError, LEVELS, type NotificationInput, type Page, type SourceContext} from './types';
import {DEFAULT_AUTOMATION_POLICY, DEFAULT_SUBSCRIBER_PREFERENCES, automationPolicyInput, subscriberPreferencesInput, evaluateDelivery, incidentFingerprint, type AutomationPolicy, type SubscriberPreferences, type Incident, type IncidentEvent} from './automation';

type Row = Record<string, SqlStorageValue>;
export type IncidentStored = Incident & {input: NotificationInput; source: SourceContext; windowEnd: number};
const iso = (now: number) => new Date(now).toISOString();

/** All records belong to the owning tenant Durable Object; never accepts a tenant identifier. */
export class HubAutomation {
  private readonly readCache = new Map<string, {until: number; value: unknown}>();
  private cached<T>(key: string, read: () => T): T {
    const existing = this.readCache.get(key);
    if (existing && existing.until > Date.now()) return structuredClone(existing.value) as T;
    const value = read();
    if (this.readCache.size >= 128) this.readCache.delete(this.readCache.keys().next().value!);
    this.readCache.set(key, {until: Date.now()+30000, value: structuredClone(value)});
    return value;
  }
  private invalidate(): void {this.readCache.clear(); this.notify();}
  constructor(private sql: SqlStorage, private notify: () => void) {
    sql.exec(`CREATE TABLE IF NOT EXISTS automation_policies
              (
                  scope
                  TEXT
                  PRIMARY
                  KEY,
                  body
                  TEXT
              );
    CREATE TABLE IF NOT EXISTS subscriber_preferences
    (
        chat_id
        TEXT
        PRIMARY
        KEY,
        body
        TEXT
        NOT
        NULL
    );
    CREATE TABLE IF NOT EXISTS incidents
    (
        id
        TEXT
        PRIMARY
        KEY,
        application_id
        TEXT,
        fingerprint
        TEXT
        NOT
        NULL,
        status
        TEXT
        NOT
        NULL,
        first_seen
        INTEGER
        NOT
        NULL,
        last_seen
        INTEGER
        NOT
        NULL,
        window_end
        INTEGER
        NOT
        NULL,
        deadline
        INTEGER,
        body
        TEXT
        NOT
        NULL
    );
    CREATE INDEX IF NOT EXISTS incidents_fingerprint ON incidents(application_id, fingerprint, last_seen DESC);
    CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status, last_seen DESC);
    CREATE INDEX IF NOT EXISTS incidents_deadlines ON incidents(deadline);
    CREATE TABLE IF NOT EXISTS incident_events
    (
        id
        TEXT
        PRIMARY
        KEY,
        incident_id
        TEXT
        NOT
        NULL,
        action
        TEXT
        NOT
        NULL,
        created_at
        INTEGER
        NOT
        NULL,
        body
        TEXT
        NOT
        NULL
    );
    CREATE INDEX IF NOT EXISTS incident_events_timeline ON incident_events(incident_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS notification_incidents
    (
        notification_id
        TEXT
        PRIMARY
        KEY,
        incident_id
        TEXT
        NOT
        NULL
    );
    CREATE INDEX IF NOT EXISTS notification_incidents_parent ON notification_incidents(incident_id);`);
    if (!this.rows('PRAGMA table_info(notification_incidents)').some(row => row.name === 'grouped')) sql.exec('ALTER TABLE notification_incidents ADD COLUMN grouped INTEGER NOT NULL DEFAULT 0');
  }
  private rows(query: string, ...bindings: SqlStorageValue[]): Row[] { return this.sql.exec(query, ...bindings).toArray(); }
  getPolicy(applicationId?: string): {policy: AutomationPolicy; inherited: boolean} {
    return this.cached(`policy:${applicationId ?? ''}`, () => this.readPolicy(applicationId));
  }
  private readPolicy(applicationId?: string): {policy: AutomationPolicy; inherited: boolean} {
    const row = applicationId ? this.rows('SELECT body FROM automation_policies WHERE scope = ?', applicationId)[0] : undefined;
    const tenant = this.rows("SELECT body FROM automation_policies WHERE scope = ''")[0];
    const policy = JSON.parse(String(row?.body ?? tenant?.body ?? JSON.stringify(DEFAULT_AUTOMATION_POLICY))) as AutomationPolicy;
    // One monotonic revision prevents a stale editor from resurrecting an override after reset.
    policy.version = Number(this.rows("SELECT value FROM queue_state WHERE key = 'automation_version'")[0]?.value ?? 0);
    return {policy, inherited: !!applicationId && !row?.body};
  }
  updatePolicy(applicationId: string | null, raw: unknown) {
    const policy = automationPolicyInput(raw, this.getPolicy(applicationId ?? undefined).policy);
    this.sql.exec('INSERT INTO automation_policies (scope, body) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET body = excluded.body', applicationId ?? '', JSON.stringify(policy));
    this.sql.exec("INSERT INTO queue_state (key, value) VALUES ('automation_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", policy.version);
    this.invalidate();
    return this.getPolicy(applicationId ?? undefined);
  }
  resetPolicy(applicationId: string, expectedVersion: number) {
    const current = this.getPolicy(applicationId).policy;
    if (!Number.isSafeInteger(expectedVersion) || current.version !== expectedVersion) throw new AppError(409, 'STALE_AUTOMATION', 'STALE_AUTOMATION: Reload automation settings before saving.');
    this.sql.exec('DELETE FROM automation_policies WHERE scope = ?', applicationId);
    this.sql.exec("INSERT INTO queue_state (key, value) VALUES ('automation_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", current.version + 1);
    this.invalidate();
    return this.getPolicy(applicationId);
  }
  getPreferences(chatId: string): SubscriberPreferences {
    return this.cached(`prefs:${chatId}`, () => this.readPreferences(chatId));
  }
  private readPreferences(chatId: string): SubscriberPreferences {
    if (!this.rows('SELECT 1 FROM subscribers WHERE chat_id = ?', chatId).length) throw new AppError(404, 'SUBSCRIBER_NOT_FOUND', 'SUBSCRIBER_NOT_FOUND: Subscriber does not exist.');
    return JSON.parse(String(this.rows('SELECT body FROM subscriber_preferences WHERE chat_id = ?', chatId)[0]?.body ?? JSON.stringify(DEFAULT_SUBSCRIBER_PREFERENCES))) as SubscriberPreferences;
  }
  updatePreferences(chatId: string, raw: unknown): SubscriberPreferences {
    const next = subscriberPreferencesInput(raw, this.getPreferences(chatId));
    this.sql.exec('INSERT INTO subscriber_preferences (chat_id, body) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET body = excluded.body', chatId, JSON.stringify(next));
    this.invalidate();
    return next;
  }
  decision(input: NotificationInput, chatId: string, now: number) { return evaluateDelivery(input, this.getPolicy(input.applicationId).policy, this.getPreferences(chatId), now); }
  getStored(id: string): IncidentStored | null { const row = this.rows('SELECT body FROM incidents WHERE id = ?', id)[0]; return row ? JSON.parse(String(row.body)) as IncidentStored : null; }
  publicIncident(incident: IncidentStored): Incident { const {input: _input, source: _source, windowEnd: _windowEnd, ...visible} = incident; return visible; }
  getIncident(id: string) {
    const stored = this.getStored(id);
    return stored ? {incident: this.publicIncident(stored), timeline: this.rows('SELECT body FROM incident_events WHERE incident_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', id).map(r => JSON.parse(String(r.body)) as IncidentEvent).reverse()} : null;
  }
  listIncidents(page: number, status?: string, applicationId?: string): Page<Incident> {
    page = Math.max(1, Math.min(100000, Math.floor(page || 1)));
    if (status && !['open','acknowledged','snoozed','resolved'].includes(status)) throw new AppError(400, 'INVALID_INCIDENT', 'INVALID_INCIDENT: Invalid incident status.');
    const clauses: string[] = []; const bindings: SqlStorageValue[] = [];
    if (status) {clauses.push('status = ?'); bindings.push(status);}
    if (applicationId) {clauses.push('application_id = ?'); bindings.push(applicationId);}
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return {items: this.rows(`SELECT body FROM incidents${where} ORDER BY last_seen DESC, id DESC LIMIT 20 OFFSET ?`, ...bindings, (page-1)*20).map(r => this.publicIncident(JSON.parse(String(r.body)))), total: Number(this.rows(`SELECT COUNT(*) AS count FROM incidents${where}`, ...bindings)[0].count), page, pageSize: 20};
  }
  overview() {
    const rows = this.rows("SELECT status, COUNT(*) AS count FROM incidents GROUP BY status");
    const counts = Object.fromEntries(rows.map(r => [String(r.status), Number(r.count)]));
    const row = this.rows(`SELECT SUM(json_extract(body, '$.occurrences')) AS occurrences, SUM(json_extract(body, '$.escalationCount')) AS escalations,
      AVG(CASE WHEN json_extract(body, '$.acknowledgedAt') IS NOT NULL THEN (julianday(json_extract(body, '$.acknowledgedAt')) - julianday(json_extract(body, '$.firstSeenAt'))) * 86400 END) AS ack FROM incidents`)[0];
    return {open: counts.open ?? 0, acknowledged: counts.acknowledged ?? 0, snoozed: counts.snoozed ?? 0, resolved: counts.resolved ?? 0, totalOccurrences: Number(row.occurrences ?? 0), escalations: Number(row.escalations ?? 0), averageAckSeconds: typeof row.ack === 'number' ? Math.max(0, Math.round(row.ack)) : null};
  }
  save(incident: IncidentStored) {
    const deadline = incident.status === 'snoozed' ? Date.parse(incident.snoozedUntil!) : incident.status === 'open' && incident.nextEscalationAt ? Date.parse(incident.nextEscalationAt) : null;
    this.sql.exec(`INSERT INTO incidents (id, application_id, fingerprint, status, first_seen, last_seen, window_end, deadline, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, last_seen=excluded.last_seen, window_end=excluded.window_end, deadline=excluded.deadline, body=excluded.body`, incident.id, incident.applicationId, incident.fingerprint, incident.status, Date.parse(incident.firstSeenAt), Date.parse(incident.lastSeenAt), incident.windowEnd, deadline, JSON.stringify(incident));
    this.notify();
  }
  event(incidentId: string, action: string, detail: string, now: number, actorChatId: string | null = null) {
    const actor = actorChatId ? this.rows('SELECT COALESCE(display_name, first_name) AS name FROM subscribers WHERE chat_id = ?', actorChatId)[0] : null;
    const event: IncidentEvent = {id: crypto.randomUUID(), action, detail, actorChatId, actorName: actorChatId ? String(actor?.name ?? actorChatId) : ['acknowledge','snooze','resolve'].includes(action) ? 'Dashboard' : null, createdAt: iso(now)};
    this.sql.exec('INSERT INTO incident_events (id, incident_id, action, created_at, body) VALUES (?, ?, ?, ?, ?)', event.id, incidentId, action, now, JSON.stringify(event));
    this.sql.exec('DELETE FROM incident_events WHERE incident_id = ? AND id NOT IN (SELECT id FROM incident_events WHERE incident_id = ? ORDER BY created_at DESC, id DESC LIMIT 100)', incidentId, incidentId);
  }
  findOpen(input: NotificationInput, now: number): IncidentStored | null {
    const policy = this.getPolicy(input.applicationId).policy;
    if (!policy.grouping.enabled && !policy.escalation.enabled && !policy.responders.length) return null;
    const fingerprint = incidentFingerprint(input);
    const row = (policy.grouping.enabled || input.incidentStatus === 'resolved') ? this.rows(`SELECT body FROM incidents WHERE application_id IS ? AND fingerprint = ? AND status != 'resolved' ${input.incidentStatus === 'resolved' ? '' : 'AND window_end > ?'} ORDER BY first_seen DESC LIMIT 1`, input.applicationId ?? null, fingerprint, ...(input.incidentStatus === 'resolved' ? [] : [now]))[0] : undefined;
    return row ? JSON.parse(String(row.body)) as IncidentStored : null;
  }
  accept(input: NotificationInput, source: SourceContext, notificationId: string, now: number): {incident: IncidentStored; repeated: boolean} | null {
    const policy = this.getPolicy(input.applicationId).policy;
    if (!policy.grouping.enabled && !policy.escalation.enabled && !policy.responders.length) return null;
    const fingerprint = incidentFingerprint(input);
    const previous = this.findOpen(input, now);
    const row = previous ? {body: JSON.stringify(previous)} : undefined;
    let incident: IncidentStored;
    if (row) {
      incident = JSON.parse(String(row.body));
      incident.occurrences++; incident.lastSeenAt = iso(now); incident.version++; incident.input = input; incident.source = source; incident.level = input.level; incident.title = input.title || input.event; incident.notificationId = notificationId;
      if (incident.status === 'open' && policy.escalation.enabled && input.level === 'critical' && !incident.nextEscalationAt && incident.escalationCount < policy.escalation.targetChatIds.length) incident.nextEscalationAt = iso(now + policy.escalation.afterMinutes*60000);
      if (input.incidentStatus === 'resolved') {incident.status = 'resolved'; incident.resolvedAt = iso(now); incident.nextEscalationAt = null; incident.snoozedUntil = null;}
      this.event(incident.id, input.incidentStatus === 'resolved' ? 'resolved' : 'repeated', `Occurrence ${incident.occurrences}`, now);
    } else {
      incident = {id: crypto.randomUUID(), applicationId: input.applicationId ?? null, application: input.application, title: input.title || input.event, event: input.event, level: input.level, environment: input.environment ?? null, fingerprint, status: input.incidentStatus === 'resolved' ? 'resolved' : 'open', occurrences: 1, firstSeenAt: iso(now), lastSeenAt: iso(now), acknowledgedAt: null, resolvedAt: input.incidentStatus === 'resolved' ? iso(now) : null, assigneeChatId: null, snoozedUntil: null, nextEscalationAt: policy.escalation.enabled && input.level === 'critical' && input.incidentStatus !== 'resolved' ? iso(now + policy.escalation.afterMinutes*60000) : null, escalationCount: 0, version: 1, notificationId, input, source, windowEnd: now + policy.grouping.windowSeconds*1000};
      this.event(incident.id, input.incidentStatus === 'resolved' ? 'resolved' : 'opened', 'Incident created from notification.', now);
    }
    if (input.incidentStatus === 'resolved') {
      const siblings = "SELECT id FROM incidents WHERE application_id IS ? AND fingerprint = ? AND status != 'resolved' AND id != ?";
      // Recovery closes earlier fixed windows too. Mark payloads dirty and let bounded alarm batches render them.
      this.sql.exec(`UPDATE deliveries SET status = status,
        stage_attempts = CASE WHEN status = 'sending' THEN stage_attempts ELSE 0 END,
        next_attempt = ?, updated_at = ?, system_payload = json_set(COALESCE(system_payload, '{}'), '$.incident_dirty', 1, '$.incident_refresh_pending', CASE WHEN status NOT IN ('pending','sending') THEN 1 ELSE 0 END, '$.refresh_after_send', CASE WHEN status = 'sending' THEN 1 ELSE 0 END)
        WHERE incident_id IN (${siblings}) AND NOT (status = 'unknown' AND telegram_message_id IS NULL)`, now, now, input.applicationId ?? null, fingerprint, incident.id);
      const eventId = crypto.randomUUID();
      this.sql.exec(`INSERT INTO incident_events (id, incident_id, action, created_at, body)
        SELECT ? || id, id, 'resolved', ?, json_object('id', ? || id, 'action','resolved','actorChatId',NULL,'actorName',NULL,'createdAt',?,'detail','Resolved by the same recovery event across grouping windows.') FROM incidents WHERE id IN (${siblings})`, eventId,now,eventId,iso(now),input.applicationId ?? null,fingerprint,incident.id);
      this.sql.exec(`UPDATE incidents SET status='resolved', deadline=NULL, last_seen=?, body=json_set(body,
        '$.status','resolved','$.resolvedAt',?,'$.lastSeenAt',?,'$.nextEscalationAt',NULL,'$.snoozedUntil',NULL,'$.version',json_extract(body,'$.version')+1,
        '$.input',json(?),'$.source',json(?),'$.level',?,'$.title',?) WHERE id IN (${siblings})`,now,iso(now),iso(now),JSON.stringify(input),JSON.stringify(source),input.level,input.title || input.event,input.applicationId ?? null,fingerprint,incident.id);
    }
    this.save(incident);
    this.sql.exec('INSERT INTO notification_incidents (notification_id, incident_id, grouped) VALUES (?, ?, ?)', notificationId, incident.id, row ? 1 : 0);
    return {incident, repeated: !!row};
  }
  act(id: string, raw: unknown, now: number, actorChatId?: string): IncidentStored {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'INVALID_INCIDENT', 'INVALID_INCIDENT: Invalid action.');
    const value = raw as {action?: unknown; expectedVersion?: unknown; minutes?: unknown};
    if (Object.keys(value).some(k => !['action','expectedVersion','minutes'].includes(k)) || !['acknowledge','snooze','resolve'].includes(String(value.action)) || !Number.isSafeInteger(value.expectedVersion) || (value.minutes !== undefined && (!Number.isSafeInteger(value.minutes) || Number(value.minutes) < 1 || Number(value.minutes) > 1440))) throw new AppError(400, 'INVALID_INCIDENT', 'INVALID_INCIDENT: Invalid action.');
    const incident = this.getStored(id);
    if (!incident) throw new AppError(404, 'INCIDENT_NOT_FOUND', 'INCIDENT_NOT_FOUND: Incident does not exist.');
    if (incident.version !== value.expectedVersion) throw new AppError(409, 'STALE_INCIDENT', 'STALE_INCIDENT: Reload this incident before acting.');
    if (incident.status === 'resolved') throw new AppError(409, 'INCIDENT_RESOLVED', 'INCIDENT_RESOLVED: This incident is already resolved.');
    if (value.action === 'acknowledge') { incident.status = 'acknowledged'; incident.acknowledgedAt ??= iso(now); incident.assigneeChatId = actorChatId ?? null; incident.snoozedUntil = null; }
    if (value.action === 'resolve') { incident.status = 'resolved'; incident.resolvedAt = iso(now); incident.snoozedUntil = null; }
    if (value.action === 'snooze') { incident.status = 'snoozed'; incident.snoozedUntil = iso(now + Number(value.minutes ?? 15)*60000); }
    incident.nextEscalationAt = null; incident.version++;
    this.event(id, String(value.action), value.action === 'snooze' ? `Snoozed for ${value.minutes ?? 15} minutes.` : actorChatId ? 'Action from Telegram.' : 'Action from dashboard.', now, actorChatId ?? null);
    this.save(incident); return incident;
  }
  due(now: number): IncidentStored[] { return this.rows('SELECT body FROM incidents WHERE deadline <= ? ORDER BY deadline LIMIT 20', now).map(r => JSON.parse(String(r.body))); }
  nextDeadline(): number | null {const next = this.rows('SELECT MIN(deadline) AS next FROM incidents')[0]?.next; return typeof next === 'number' ? next : null;}
}
