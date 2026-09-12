import { AppError, type LoginAuditEntry, type LoginAuditInput, type LoginAuditPage, type LoginAuditQuery } from './types';

const MAX_ROWS = 5_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CLEANUP_BATCH = 100;
interface AuditRow extends Record<string, SqlStorageValue> {
  id: number; created_at: string; ip: string; country: string;
  user_agent: string; request_id: string | null; outcome: string;
}
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';

export function loginAuditQuery(input: Record<string, unknown>): LoginAuditQuery {
  const invalid = () => { throw new AppError(400, 'INVALID_AUDIT_QUERY', 'فیلتر یا صفحه گزارش معتبر نیست.'); };
  const integer = (value: unknown, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) return invalid();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) return invalid();
    return number;
  };
  const result: LoginAuditQuery = { limit: integer(input.limit, 25, 1, 100), offset: integer(input.offset, 0, 0, MAX_ROWS) };
  if (input.ip !== undefined && input.ip !== '') {
    if (typeof input.ip !== 'string' || input.ip.length > 64 || /[\u0000-\u0020\u007f]/.test(input.ip)) return invalid();
    result.ip = input.ip;
  }
  if (input.country !== undefined && input.country !== '') {
    if (typeof input.country !== 'string' || !/^[a-z]{2}$/i.test(input.country)) return invalid();
    result.country = input.country.toUpperCase();
  }
  if (input.outcome !== undefined && input.outcome !== '') {
    if (input.outcome !== 'invalid_key' && input.outcome !== 'rate_limited') return invalid();
    result.outcome = input.outcome;
  }
  return result;
}

/** A global, credential-free audit bounded by both row count and age. */
export class LoginAuditStore {
  private lastCleanupAt = 0;

  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS login_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
      ip TEXT NOT NULL, country TEXT NOT NULL, user_agent TEXT NOT NULL,
      request_id TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('invalid_key', 'rate_limited'))
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS login_audit_created ON login_audit(created_at, id)');
  }

  append(input: LoginAuditInput): number | null {
    if (input.outcome !== 'invalid_key' && input.outcome !== 'rate_limited') throw new Error('Invalid login audit outcome.');
    const now = Date.now();
    // Explicit columns exclude arbitrary RPC properties, request bodies, and credentials.
    const row = this.sql.exec<{ id: number }>(`INSERT INTO login_audit
      (created_at, ip, country, user_agent, request_id, outcome) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      new Date(now).toISOString(), clean(input.ip, 64) || 'unknown', /^[A-Z]{2}$/.test(input.country) ? input.country : 'XX',
      clean(input.userAgent, 512), typeof input.requestId === 'string' && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/i.test(input.requestId) ? input.requestId : null, input.outcome,
    ).one();
    // IDs increase monotonically. Deleting a prefix caps storage without scanning/counting all rows.
    this.sql.exec('DELETE FROM login_audit WHERE id <= ?', row.id - MAX_ROWS);
    if (now - this.lastCleanupAt >= 60_000) this.cleanup(now);
    return this.nextCleanupAt(now);
  }

  cleanup(now = Date.now()): void {
    this.sql.exec('DELETE FROM login_audit WHERE id IN (SELECT id FROM login_audit WHERE created_at <= ? ORDER BY created_at, id LIMIT ?)', new Date(now - RETENTION_MS).toISOString(), CLEANUP_BATCH);
    this.lastCleanupAt = now;
  }

  nextCleanupAt(now = Date.now()): number | null {
    const first = this.sql.exec<{ created_at: string }>('SELECT created_at FROM login_audit ORDER BY created_at, id LIMIT 1').toArray()[0];
    return first ? Math.max(now + 1_000, Date.parse(first.created_at) + RETENTION_MS) : null;
  }

  list(query: LoginAuditQuery = {}): LoginAuditPage {
    const options = loginAuditQuery(query as Record<string, unknown>);
    const where = ['created_at > ?'];
    const args: SqlStorageValue[] = [new Date(Date.now() - RETENTION_MS).toISOString()];
    for (const column of ['ip', 'country', 'outcome'] as const) {
      if (options[column]) { where.push(`${column} = ?`); args.push(options[column]!); }
    }
    const clause = where.join(' AND ');
    const total = this.sql.exec<{ total: number }>(`SELECT COUNT(*) AS total FROM login_audit WHERE ${clause}`, ...args).one().total;
    const rows = this.sql.exec<AuditRow>(`SELECT * FROM login_audit WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...args, options.limit!, options.offset!).toArray();
    return {
      entries: rows.map(row => ({ id: String(row.id), createdAt: row.created_at, ip: row.ip, country: row.country, userAgent: row.user_agent, requestId: row.request_id, outcome: row.outcome as LoginAuditEntry['outcome'] })),
      total, limit: options.limit!, offset: options.offset!,
    };
  }
}
