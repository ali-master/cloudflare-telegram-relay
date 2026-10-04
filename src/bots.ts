import type {Page, TelegramBot} from './types';

export interface StoredBot extends Omit<TelegramBot, 'configured'> {
  tenantId: string;
  botToken: string | null;
  webhookSecret: string | null;
}

/** Bots are unbounded in storage; only recently used credentials occupy memory. */
export class BotStore {
  private readonly cache = new Map<string, StoredBot>();

  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS tenant_bots (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, telegram_id TEXT UNIQUE,
      name TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (tenant_id, id)
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS tenant_bots_page ON tenant_bots(tenant_id, created_at, id)');
  }

  private remember(bot: StoredBot): StoredBot {
    const key = `${bot.tenantId}:${bot.id}`;
    this.cache.delete(key);
    this.cache.set(key, bot);
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
    return bot;
  }

  get(tenantId: string, id: string): StoredBot | null {
    const cached = this.cache.get(`${tenantId}:${id}`);
    if (cached) return this.remember(cached);
    const row = this.sql.exec<{body: string}>('SELECT body FROM tenant_bots WHERE tenant_id = ? AND id = ?', tenantId, id).toArray()[0];
    return row ? this.remember(JSON.parse(row.body) as StoredBot) : null;
  }

  public(bot: StoredBot): TelegramBot {
    const {tenantId, botToken, webhookSecret, ...result} = bot;
    return {...result, configured: !!botToken};
  }

  identityOwner(telegramId: string): {tenant_id: string; id: string} | null {
    return this.sql.exec<{tenant_id: string; id: string}>('SELECT tenant_id, id FROM tenant_bots WHERE telegram_id = ?', telegramId).toArray()[0] ?? null;
  }

  put(bot: StoredBot): void {
    this.sql.exec(`INSERT INTO tenant_bots(tenant_id,id,telegram_id,name,created_at,body) VALUES(?,?,?,?,?,?)
      ON CONFLICT(tenant_id,id) DO UPDATE SET telegram_id=excluded.telegram_id,name=excluded.name,body=excluded.body`,
    bot.tenantId, bot.id, bot.telegramId, bot.name, bot.createdAt, JSON.stringify(bot));
    this.remember(bot);
  }

  migrate(bot: StoredBot): void {
    this.sql.exec('INSERT OR IGNORE INTO tenant_bots(tenant_id,id,telegram_id,name,created_at,body) VALUES(?,?,?,?,?,?)',
      bot.tenantId, bot.id, bot.telegramId, bot.name, bot.createdAt, JSON.stringify(bot));
    this.get(bot.tenantId, bot.id);
  }

  list(tenantId: string, page = 1, search = ''): Page<TelegramBot> {
    if (!Number.isSafeInteger(page) || page < 1 || typeof search !== 'string' || search.length > 80) throw new Error('INVALID_BOT: Invalid bot list query.');
    const pageSize = 20;
    const where = 'tenant_id = ?' + (search ? ' AND (instr(lower(name),lower(?)) > 0 OR instr(lower(id),lower(?)) > 0)' : '');
    const bindings = search ? [tenantId, search, search] : [tenantId];
    const total = this.sql.exec<{total: number}>(`SELECT COUNT(*) AS total FROM tenant_bots WHERE ${where}`, ...bindings).one().total;
    const items = this.sql.exec<{body: string}>(`SELECT body FROM tenant_bots WHERE ${where} ORDER BY CASE WHEN id = 'default' THEN 0 ELSE 1 END, created_at, id LIMIT ? OFFSET ?`, ...bindings, pageSize, (page - 1) * pageSize).toArray().map(row => this.public(JSON.parse(row.body) as StoredBot));
    return {items, total, page, pageSize};
  }

  ids(tenantId: string, after = ''): string[] {
    return this.sql.exec<{id: string}>('SELECT id FROM tenant_bots WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT 100', tenantId, after).toArray().map(row => row.id);
  }
}
