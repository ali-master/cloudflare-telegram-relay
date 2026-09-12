import {type Context, Hono} from 'hono';
import {deleteCookie, getCookie, setCookie} from 'hono/cookie';
import {bodyLimit} from 'hono/body-limit';
import {
  AppError,
  type Application,
  type ApplicationCreate,
  type ApplicationUpdate,
  type Env,
  hubName,
  LEVELS,
  type LoginAuditOutcome,
  type NotificationInput,
  type SourceContext,
  type SubscriberUpdate,
  type Tenant,
  type TenantCreate,
  type TenantUpdate
} from './types';
import {checkAccess, createSession, equalSecret, sourceContext, verifySession} from './security';
import {idempotencyKey, notificationInput, object, pageNumber, settingsInput} from './validation';
import {alertmanagerInputs, grafanaInput} from './integrations';
import {loginAuditQuery} from './login-audit';
import {contentSecurityPolicy, dashboardAsset} from './browser-security';

export {TenantRegistry} from './tenants';
export {NotificationHub} from './hub';

type AppEnv = { Bindings: Env; Variables: { tenant: Tenant; application: Application } };
type C = Context<AppEnv>;
const app = new Hono<AppEnv>();
const registry = (c: C) => c.env.TENANTS.getByName('registry');
const hub = (c: C) => c.env.HUB.getByName(hubName(c.get('tenant')?.id ?? 'default'));

async function selectTenant(c: C) {
  const id = c.req.param('tenantId') ?? 'default';
  const tenant = await registry(c).getTenant(id);
  if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant پیدا نشد.');
  c.set('tenant', tenant);
  return tenant;
}

async function initializeHub(c: C) {
  const tenant = c.get('tenant');
  await hub(c).initializeTenant(tenant.id, tenant.name);
}

const keyOf = (c: C) => c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') || c.req.header('X-API-Key') || '';
const cookieName = (c: C) => new URL(c.req.url).protocol === 'https:' ? '__Host-relay_session' : 'relay_session';
const failure = (c: C, status: number, code: string, message: string) => c.json({
  error: {
    code,
    message
  }
}, status as 400);
const requireConfig = (c: C) => {
  if (!c.env.API_KEY) throw new AppError(503, 'AUTH_UNAVAILABLE', 'امکان ورود وجود ندارد؛ کمی بعد دوباره تلاش کنید.');
};

async function jsonBody(c: C) {
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError(415, 'JSON_REQUIRED', 'Content-Type باید application/json باشد.');
  try {
    return await c.req.json<unknown>();
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'JSON معتبر نیست.');
  }
}

function requireOrigin(c: C) {
  if (c.req.header('Origin') !== new URL(c.req.url).origin) throw new AppError(403, 'ORIGIN_REJECTED', 'مبدأ درخواست معتبر نیست.');
}

async function isAdmin(c: C) {
  return verifySession(getCookie(c, cookieName(c)), c.env.API_KEY);
}

async function auditLogin(c: C, outcome: LoginAuditOutcome): Promise<void> {
  const source = sourceContext(c.req.raw);
  try {
    await registry(c).recordLoginAttempt({
      ip: source.ip, country: source.country, outcome,
      userAgent: c.req.header('User-Agent') ?? '',
      requestId: c.req.raw.cf ? c.req.header('CF-Ray') ?? null : null,
    });
  } catch {
    // Audit availability must never change authentication or reveal request credentials.
    console.warn('Login audit write failed.');
  }
}

async function fingerprint(input: NotificationInput, suppliedTimestamp: boolean) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const data = {...input} as Partial<NotificationInput>;
  if (!suppliedTimestamp) delete data.timestamp;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(data))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function accept(c: C, input: NotificationInput, source: SourceContext, key?: string, suppliedTimestamp = true) {
  // Adapter payloads must satisfy the final length limit after the key binds the application name.
  const {applicationId, ...fields} = input;
  input = {...notificationInput(fields, source), applicationId};
  const scopedKey = key ? `${input.applicationId ?? 'legacy'}:${key}` : undefined;
  return hub(c).enqueue(input, source, scopedKey, await fingerprint(input, suppliedTimestamp));
}

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000');
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/telegram/')) c.header('Cache-Control', 'no-store');
  await next();
  if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', contentSecurityPolicy());
});
app.use('*', bodyLimit({
  maxSize: 64 * 1024,
  onError: c => failure(c, 413, 'BODY_TOO_LARGE', 'حداکثر اندازه درخواست ۶۴ کیلوبایت است.')
}));
app.get('/health', c => c.json({status: 'ok', service: 'telegram-relay'}));
app.post('/api/admin/login', async c => {
  requireConfig(c);
  requireOrigin(c);
  if (!await hub(c).rateLimit(`login:${sourceContext(c.req.raw).ip}`, 10, 60)) {
    await auditLogin(c, 'rate_limited');
    c.header('Retry-After', '60');
    return failure(c, 429, 'RATE_LIMITED', 'تلاش‌های ورود زیاد است؛ یک دقیقه صبر کنید.');
  }
  const data = object(await jsonBody(c));
  if (typeof data.apiKey !== 'string' || !await equalSecret(data.apiKey, c.env.API_KEY)) {
    await auditLogin(c, 'invalid_key');
    return failure(c, 401, 'INVALID_KEY', 'اطلاعات ورود معتبر نیست.');
  }
  setCookie(c, cookieName(c), await createSession(c.env.API_KEY), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: 8 * 3600
  });
  return c.json({authenticated: true});
});
app.get('/api/admin/session', async c => {
  requireConfig(c);
  return c.json({authenticated: await isAdmin(c)});
});
app.use('/api/admin/*', async (c, next) => {
  requireConfig(c);
  if (!await isAdmin(c)) return failure(c, 401, 'UNAUTHORIZED', 'برای ادامه وارد پنل شوید.');
  if (!['GET', 'HEAD'].includes(c.req.method)) requireOrigin(c);
  await next();
});
app.get('/api/admin/login-audit', async c => c.json(await registry(c).listLoginAudit(loginAuditQuery(c.req.query()))));
app.post('/api/admin/logout', c => {
  deleteCookie(c, cookieName(c), {
    path: '/',
    secure: new URL(c.req.url).protocol === 'https:',
    httpOnly: true,
    sameSite: 'Strict'
  });
  return c.json({authenticated: false});
});
// Management endpoints return public tenant metadata only. Runtime credentials stay in RPC.
app.get('/api/admin/tenants', async c => c.json({tenants: await registry(c).listTenants()}));
app.post('/api/admin/tenants', async c => {
  const result = await registry(c).createTenant(object(await jsonBody(c)) as unknown as TenantCreate);
  return c.json({tenant: result.tenant}, 201);
});
app.get('/api/admin/tenants/:tenantId', async c => c.json({tenant: await selectTenant(c)}));
app.patch('/api/admin/tenants/:tenantId', async c => c.json({tenant: await registry(c).updateTenant(c.req.param('tenantId'), object(await jsonBody(c)) as TenantUpdate)}));
app.put('/api/admin/tenants/:tenantId/bot', async c => {
  const data = object(await jsonBody(c));
  if (typeof data.botToken !== 'string' || data.botToken.length > 256) throw new AppError(400, 'INVALID_BOT_TOKEN', 'BOT_TOKEN معتبر را وارد کنید.');
  if (data.expectedVersion !== undefined && (!Number.isSafeInteger(data.expectedVersion) || Number(data.expectedVersion) < 1)) throw new AppError(400, 'INVALID_TENANT', 'نسخه Tenant معتبر نیست.');
  return c.json({tenant: await registry(c).configureBot(c.req.param('tenantId'), data.botToken, data.expectedVersion as number | undefined)});
});
const adminData = new Hono<AppEnv>();
adminData.use('*', async (c, next) => {
  await selectTenant(c);
  await initializeHub(c);
  await next();
});
adminData.get('/applications', async c => c.json({applications: await registry(c).listApplications(c.get('tenant').id)}));
adminData.post('/applications', async c => c.json(await registry(c).createApplication(c.get('tenant').id, object(await jsonBody(c)) as unknown as ApplicationCreate), 201));
adminData.patch('/applications/:applicationId', async c => c.json({application: await registry(c).updateApplication(c.get('tenant').id, c.req.param('applicationId'), object(await jsonBody(c)) as ApplicationUpdate)}));
adminData.post('/applications/:applicationId/rotate-key', async c => {
  const data = object(await jsonBody(c));
  if (data.expectedVersion !== undefined && (!Number.isSafeInteger(data.expectedVersion) || Number(data.expectedVersion) < 1)) throw new AppError(400, 'INVALID_APPLICATION', 'نسخه اپلیکیشن معتبر نیست.');
  return c.json(await registry(c).rotateApplicationKey(c.get('tenant').id, c.req.param('applicationId'), data.expectedVersion as number | undefined));
});
adminData.post('/subscribers/ban', async c => {
  const data = object(await jsonBody(c));
  if (!Array.isArray(data.chatIds) || data.chatIds.length < 1 || data.chatIds.length > 100 || data.chatIds.some(id => typeof id !== 'string' || !/^-?[0-9]{1,20}$/.test(id)) || typeof data.banned !== 'boolean' || (data.reason !== undefined && (typeof data.reason !== 'string' || data.reason.length > 200))) throw new AppError(400, 'INVALID_BAN', 'بین ۱ تا ۱۰۰ کاربر و دلیل حداکثر ۲۰۰ کاراکتری وارد کنید.');
  return c.json(await hub(c).setSubscriberBan([...new Set(data.chatIds)] as string[], data.banned, data.reason as string | undefined));
});
adminData.get('/context', c => c.json(sourceContext(c.req.raw, 'admin')));
adminData.get('/overview', async c => c.json(await hub(c).getOverview()));
adminData.get('/settings', async c => c.json(await hub(c).getSettings()));
adminData.put('/settings', async c => c.json(await hub(c).updateSettings(settingsInput(await jsonBody(c), await hub(c).getSettings()))));
adminData.get('/subscribers', async c => c.json(await hub(c).listSubscribers(pageNumber(c.req.query('page')), c.req.query('search'))));
adminData.get('/subscribers/:chatId', async c => {
  const subscriber = await hub(c).getSubscriber(c.req.param('chatId'));
  return subscriber ? c.json({subscriber}) : failure(c, 404, 'SUBSCRIBER_NOT_FOUND', 'کاربر پیدا نشد.');
});
adminData.patch('/subscribers/:chatId', async c => c.json({
  subscriber: await hub(c).updateSubscriber(c.req.param('chatId'), object(await jsonBody(c)) as unknown as SubscriberUpdate)
}));
adminData.get('/notifications', async c => {
  const level = c.req.query('level') || undefined, search = c.req.query('search') || undefined;
  if (level && !LEVELS.includes(level as never)) throw new AppError(400, 'INVALID_LEVEL', 'سطح هشدار معتبر نیست.');
  if (search && search.length > 100) throw new AppError(400, 'INVALID_SEARCH', 'جستجو حداکثر ۱۰۰ کاراکتر است.');
  return c.json(await hub(c).listNotifications(pageNumber(c.req.query('page')), level, search, c.req.query('applicationId') || undefined));
});
adminData.get('/notifications/:id', async c => {
  const result = await hub(c).getNotification(c.req.param('id'));
  return result ? c.json(result) : failure(c, 404, 'NOT_FOUND', 'اعلان پیدا نشد.');
});
adminData.post('/notifications', async c => {
  if (!await hub(c).rateLimit('admin:send', 30, 60)) return failure(c, 429, 'RATE_LIMITED', 'تعداد درخواست زیاد است.');
  const raw = object(await jsonBody(c)), source = sourceContext(c.req.raw, 'admin');
  if (typeof raw.applicationId !== 'string') throw new AppError(400, 'APPLICATION_REQUIRED', 'اپلیکیشن فرستنده را انتخاب کنید.');
  const application = await registry(c).getApplication(c.get('tenant').id, raw.applicationId);
  if (!application || !application.enabled) throw new AppError(400, 'APPLICATION_DISABLED', 'اپلیکیشن فرستنده موجود یا فعال نیست.');
  const {applicationId: selectedApplicationId, ...fields} = raw;
  const input = {
    ...notificationInput({...fields, application: application.name}, source),
    applicationId: application.id
  };
  return c.json(await accept(c, input, source, idempotencyKey(c.req.header('Idempotency-Key')), raw.timestamp !== undefined), 202);
});
adminData.get('/status', async c => c.json(await registry(c).getBotStatus(c.get('tenant').id)));
adminData.get('/usage', async c => c.json({usage: await hub(c).getUsage(), limits: c.get('tenant').limits}));
adminData.post('/webhook', async c => {
  if (!await hub(c).rateLimit('admin:webhook', 5, 60)) return failure(c, 429, 'RATE_LIMITED', 'تعداد درخواست زیاد است.');
  const origin = new URL(c.req.url).origin;
  if (!origin.startsWith('https://')) throw new AppError(400, 'HTTPS_REQUIRED', 'وب‌هوک تلگرام به آدرس عمومی HTTPS نیاز دارد.');
  const id = c.get('tenant').id;
  const path = c.req.param('tenantId') ? `/telegram/${id}/webhook` : '/telegram/webhook';
  return c.json(await registry(c).registerWebhook(id, `${origin}${path}`));
});
app.route('/api/admin/tenants/:tenantId', adminData);
app.route('/api/admin', adminData);

const ingest = new Hono<AppEnv>();
ingest.use('*', async (c, next) => {
  requireConfig(c);
  const tenant = await selectTenant(c);
  if (!tenant.enabled) throw new AppError(403, 'TENANT_DISABLED', 'این Tenant غیرفعال است.');
  const key = keyOf(c);
  const application = await registry(c).verifyApplicationKey(tenant.id, key);
  if (!application) return failure(c, 401, 'UNAUTHORIZED', 'API Key اپلیکیشن معتبر نیست.');
  c.set('application', application);
  await initializeHub(c);
  const source = sourceContext(c.req.raw);
  checkAccess(await hub(c).getSettings(), source);
  if (!await hub(c).rateLimit('ingest:tenant', tenant.limits.requestsPerMinute, 60)) {
    c.header('Retry-After', '60');
    return failure(c, 429, 'RATE_LIMITED', 'سقف درخواست این Tenant در دقیقه پر شده است.');
  }
  await next();
});
ingest.post('/notifications', async c => {
  const raw = object(await jsonBody(c)), source = sourceContext(c.req.raw);
  const application = c.get('application');
  const result = await accept(c, {
    ...notificationInput({...raw, application: application.name}, source),
    applicationId: application.id
  }, source, idempotencyKey(c.req.header('Idempotency-Key')), raw.timestamp !== undefined);
  return c.json(result, result.duplicate ? 200 : 202);
});
ingest.get('/notifications/:id', async c => {
  const result = await hub(c).getNotification(c.req.param('id'));
  return result && result.notification.applicationId === c.get('application').id ? c.json({notification: result.notification}) : failure(c, 404, 'NOT_FOUND', 'اعلان پیدا نشد.');
});
ingest.post('/integrations/alertmanager', async c => {
  const raw = object(await jsonBody(c)), source = sourceContext(c.req.raw, 'alertmanager');
  const inputs = alertmanagerInputs(raw, source), key = idempotencyKey(c.req.header('Idempotency-Key'));
  const results = [];
  for (const [i, input] of inputs.entries()) {
    const alert = object((raw.alerts as unknown[])[i]);
    const suppliedTimestamp = !!(alert.status === 'resolved' && alert.endsAt ? alert.endsAt : alert.startsAt);
    const application = c.get('application');
    results.push(await accept(c, {
      ...input,
      application: application.name,
      applicationId: application.id
    }, source, key ? `${key}:${i}` : undefined, suppliedTimestamp));
  }
  return c.json({notifications: results}, 202);
});
ingest.post('/integrations/grafana', async c => {
  const source = sourceContext(c.req.raw, 'grafana');
  const application = c.get('application');
  return c.json(await accept(c, {
    ...grafanaInput(await jsonBody(c), source),
    application: application.name,
    applicationId: application.id
  }, source, idempotencyKey(c.req.header('Idempotency-Key')), false), 202);
});
app.route('/api/v1/tenants/:tenantId', ingest);
app.route('/api/v1', ingest);

async function telegramWebhook(c: C) {
  const tenant = await selectTenant(c);
  const runtime = await registry(c).getRuntime(tenant.id);
  if (!runtime?.webhookSecret) throw new AppError(503, 'NOT_CONFIGURED', 'وب‌هوک این Tenant تنظیم نشده است.');
  if (!await equalSecret(c.req.header('X-Telegram-Bot-Api-Secret-Token') || '', runtime.webhookSecret)) return failure(c, 401, 'UNAUTHORIZED', 'وب‌هوک معتبر نیست.');
  await initializeHub(c);
  await hub(c).handleUpdate(await jsonBody(c));
  return c.json({ok: true});
}

app.post('/telegram/:tenantId/webhook', telegramWebhook);
app.post('/telegram/webhook', telegramWebhook);
app.all('/api/*', c => failure(c, 404, 'NOT_FOUND', 'مسیر پیدا نشد.'));
app.get('/', c => dashboardAsset(c.req.raw, c.env.ASSETS));
app.get('/index.html', c => dashboardAsset(c.req.raw, c.env.ASSETS));
app.get('*', c => c.env.ASSETS.fetch(c.req.raw));
app.notFound(c => failure(c, 404, 'NOT_FOUND', 'مسیر پیدا نشد.'));
app.onError((error, c) => {
  if (error instanceof AppError) return failure(c, error.status, error.code, error.message);
  const rpcErrors: Record<string, [number, string]> = {
    IDEMPOTENCY_CONFLICT: [409, 'این کلید قبلاً برای اعلان متفاوت استفاده شده است.'],
    TENANT_NOT_FOUND: [404, 'Tenant پیدا نشد.'],
    TENANT_EXISTS: [409, 'این شناسه Tenant قبلاً ثبت شده است.'],
    TENANT_LIMIT: [409, 'حداکثر تعداد Tenant ثبت شده است.'],
    TENANT_DISABLED: [403, 'این Tenant غیرفعال است.'],
    STALE_TENANT: [409, 'تنظیمات Tenant تغییر کرده است؛ صفحه را تازه کنید.'],
    INVALID_TENANT: [400, 'شناسه، نام یا محدودیت‌های Tenant معتبر نیست.'],
    BOT_ALREADY_ASSIGNED: [409, 'این بات متعلق به Tenant دیگری است.'],
    BOT_CHANGE_REQUIRES_NEW_TENANT: [409, 'برای بات متفاوت یک Tenant جدید بسازید؛ کاربران هر بات مستقل هستند.'],
    INVALID_BOT_TOKEN: [400, 'تلگرام BOT_TOKEN را تأیید نکرد؛ توکن معتبر بات را وارد کنید.'],
    TELEGRAM_UNAVAILABLE: [502, 'ارتباط با تلگرام برقرار نشد؛ دوباره تلاش کنید.'],
    TELEGRAM_TIMEOUT: [504, 'تلگرام در مهلت مقرر پاسخ نداد؛ کمی بعد دوباره تلاش کنید.'],
    TELEGRAM_NETWORK_ERROR: [502, 'اتصال سرویس به تلگرام برقرار نشد؛ دسترسی شبکهٔ محیط اجرای Worker را بررسی کنید.'],
    TELEGRAM_INVALID_RESPONSE: [502, 'پاسخ دریافتی از تلگرام معتبر نبود؛ کمی بعد دوباره تلاش کنید.'],
    TELEGRAM_UPSTREAM_ERROR: [502, 'تلگرام موقتاً در دسترس نیست؛ کمی بعد دوباره تلاش کنید.'],
    TELEGRAM_RATE_LIMITED: [429, 'تلگرام تعداد درخواست‌ها را محدود کرده است؛ کمی صبر کنید و دوباره تلاش کنید.'],
    BOT_NOT_CONFIGURED: [503, 'ابتدا BOT_TOKEN را در تنظیمات این Tenant ذخیره کنید.'],
    APPLICATION_NOT_FOUND: [404, 'اپلیکیشن پیدا نشد.'],
    APPLICATION_EXISTS: [409, 'این شناسه اپلیکیشن قبلاً ثبت شده است.'],
    APPLICATION_LIMIT: [409, 'هر Tenant حداکثر ۱۰۰ اپلیکیشن دارد.'],
    INVALID_APPLICATION: [400, 'اطلاعات اپلیکیشن یا مخاطبان انتخاب‌شده معتبر نیست.'],
    STALE_APPLICATION: [409, 'اپلیکیشن تغییر کرده است؛ صفحه را تازه کنید.'],
    SUBSCRIBER_NOT_FOUND: [404, 'کاربر پیدا نشد.'],
    INVALID_SUBSCRIBER: [400, 'اطلاعات کاربر یا اپلیکیشن‌های انتخاب‌شده معتبر نیست.'],
    STALE_SUBSCRIBER: [409, 'اطلاعات کاربر تغییر کرده است؛ نسخهٔ جدید را بارگیری کنید.'],
    INVALID_BAN: [400, 'درخواست مسدودسازی معتبر نیست.'],
    DAILY_LIMIT: [429, 'سهمیه اعلان روزانه این Tenant پر شده است.'],
    SUBSCRIBER_LIMIT: [429, 'ظرفیت اعضای این Tenant پر شده است.'],
    QUEUE_LIMIT: [429, 'ظرفیت صف ارسال این Tenant پر شده است.'],
  };
  const code = error.message.split(':', 1)[0];
  if (rpcErrors[code]) return failure(c, rpcErrors[code][0], code, rpcErrors[code][1]);
  return failure(c, 500, 'INTERNAL_ERROR', 'پردازش درخواست ناموفق بود؛ وضعیت سرویس را بررسی کنید.');
});
export default app;
