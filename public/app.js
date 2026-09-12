'use strict';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));
const state = { applications: [], subscribers: [], selectedSubscribers: new Set(), editApplicationId: null, editApplicationVersion: null, editApplicationTenantId: null, tenants: [], tenantId: null, epoch: 0, activeWrites: 0, usage: null, editTenantId: null, editTenantVersion: null, authenticated: false, tab: 'overview', settings: null, settingsDirty: false, overview: null, status: null, notificationPage: 1, subscriberPage: 1, refreshPending: false, notificationRequest: 0, subscriberRequest: 0, detailRequest: 0, composeKey: null, composeBody: null };
const LOGIN_FAILURE_MESSAGE = 'ورود ناموفق بود. لطفاً دوباره تلاش کنید.';
const titles = { overview: 'نمای کلی', notifications: 'تاریخچهٔ اعلان‌ها', subscribers: 'مشترکان بات', settings: 'تنظیمات و امنیت', api: 'راهنمای اتصال', tenants: 'مدیریت فضاها', applications: 'اپلیکیشن‌ها', 'login-audit': 'گزارش ورود به داشبورد' };
const labels = { info: 'اطلاع‌رسانی', success: 'موفق', warning: 'هشدار', error: 'خطا', critical: 'بحرانی', queued: 'در صف', sending: 'در حال ارسال', completed: 'تکمیل شده', partial: 'تکمیل ناقص', failed: 'ناموفق', empty: 'بدون مشترک', pending: 'در انتظار', sent: 'تحویل موفق', unknown: 'نامشخص', skipped: 'ردشده / لغوشده', active: 'فعال', inactive: 'غیرفعال', banned: 'مسدود' };
const faNumber = new Intl.NumberFormat('fa-IR');
const faPercent = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' });
const chartDateFormatter = new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric', timeZone: 'UTC' });
let searchTimer;
let auditSearchTimer;
let auditPage = 1;
let auditRequest = 0;
let applicationsLoaded = false;

function syncSelects() { window.RelaySelect?.syncAll(); }

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function icon(name) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.classList.add('icon');
  element.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  element.append(use);
  return element;
}
function count(value) { return faNumber.format(Number(value) || 0); }
function text(id, value) { $(id).textContent = value; }
function showError(selector, message) { const target = $(selector); target.textContent = message || ''; target.hidden = !message; }
function busy(button, value) { button.disabled = value; button.setAttribute('aria-busy', String(value)); }
function lockFields(form, locked) { $$('input, textarea, select', form).forEach(field => { field.disabled = locked; }); syncSelects(); }
function toast(message, error = false) {
  const item = node('div', `toast${error ? ' error' : ''}`);
  item.append(icon(error ? 'alert' : 'check'), node('span', '', message));
  $('#toasts').replaceChildren(item);
  window.setTimeout(() => item.remove(), 6500);
}
function badge(value) {
  const known = Object.hasOwn(labels, value);
  return node('span', `badge ${known ? value : 'neutral'}`, known ? labels[value] : 'نامشخص');
}
function validDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function dateText(value) { const date = validDate(value); return date ? `${dateFormatter.format(date)}، ${timeFormatter.format(date)}` : '—'; }
function timeCell(value) {
  const td = node('td', 'time-cell'); const date = validDate(value);
  if (!date) { td.textContent = '—'; return td; }
  td.append(node('span', '', dateFormatter.format(date)), node('small', '', timeFormatter.format(date)));
  td.title = `${date.toISOString()} · زمان محلی مرورگر`;
  return td;
}
function flag(code) {
  return /^[A-Z]{2}$/.test(code || '') && !['XX', 'T1'].includes(code) ? String.fromCodePoint(...[...code].map(character => 127397 + character.charCodeAt(0))) : '◌';
}
function safeExternalLink(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const link = node('a', '', label);
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  } catch { return null; }
}
function staleResponse() { const error = new Error('پاسخ مربوط به فضای قبلی است.'); error.stale = true; return error; }
function selectedTenant() { return state.tenants.find(tenant => tenant.id === state.tenantId) || null; }
function tenantPath(suffix, tenantId = state.tenantId) {
  if (!tenantId) throw new Error('ابتدا یک فضای اعلان انتخاب کنید.');
  return `/api/admin/tenants/${encodeURIComponent(tenantId)}${suffix ? `/${suffix}` : ''}`;
}
function updateTenant(tenant) {
  const index = state.tenants.findIndex(item => item.id === tenant.id);
  if (index < 0) state.tenants.push(tenant); else state.tenants[index] = tenant;
  renderTenantSelector(); renderTenants();
}
function renderTenantSelector() {
  $('#tenant-selector').replaceChildren(...state.tenants.map(tenant => {
    const option = node('option', '', `${tenant.name}${tenant.enabled ? '' : ' — غیرفعال'}`); option.value = tenant.id; return option;
  }));
  $('#tenant-selector').value = state.tenantId || '';
  $('#tenant-selector').disabled = state.activeWrites > 0 || !state.tenants.length;
  const tenant = selectedTenant(); const enabled = $('#tenant-enabled-badge');
  enabled.className = `badge ${tenant?.enabled ? 'success' : 'warning'}`;
  enabled.textContent = tenant ? tenant.enabled ? 'فعال' : 'غیرفعال' : '—';
  text('#workspace-name', tenant?.name || 'انتخاب فضای اعلان');
  if (state.status) renderStatus(state.status);
  syncSelects();
  updateApiExample();
}
function clearTenantData() {
  state.settings = null; state.settingsDirty = false; state.overview = null; state.status = null; state.usage = null;
  state.applications = []; state.subscribers = []; state.selectedSubscribers.clear();
  applicationsLoaded = false;
  $('#application-filter').replaceChildren(node('option', '', 'همهٔ اپلیکیشن‌ها')); $('#application-filter option').value = '';
  $('#compose-app').replaceChildren(node('option', '', 'در حال دریافت اپلیکیشن‌ها')); $('#compose-app option').value = '';
  $('#applications-table').replaceChildren(); $('#application-form').reset(); $('#ban-reason').value = ''; updateSubscriberSelection();
  state.notificationPage = 1; state.subscriberPage = 1; state.notificationRequest++; state.subscriberRequest++; state.detailRequest++;
  state.composeKey = null; state.composeBody = null; state.refreshPending = false;
  clearTimeout(searchTimer);
  for (const form of ['#settings-form', '#compose-form', '#bot-token-form']) $(form).reset();
  $('#tenant-send-key').value = ''; $('#tenant-key-owner').textContent = '';
  $$('dialog[open]').forEach(dialog => dialog.close());
  $('#notification-search').value = ''; $('#level-filter').value = '';
  for (const id of ['#notifications-table', '#subscribers-table', '#notification-detail', '#request-context', '#bot-configuration', '#tenant-usage', '#country-chips', '#notifications-pagination', '#subscribers-pagination']) $(id).replaceChildren();
  for (const id of ['#metric-today', '#metric-sent', '#metric-active', '#metric-pending', '#health-failed', '#health-unknown', '#health-skipped', '#health-percentage']) text(id, '—');
  text('#metric-subscribers-foot', 'در حال دریافت اطلاعات این فضا'); text('#subscribers-count', 'در حال دریافت اطلاعات این فضا');
  text('#connection-title', 'در حال بررسی اتصال بات این فضا…'); text('#connection-detail', 'تنظیمات و مشترکان هر فضای اعلان مستقل هستند.');
  $('#connection-banner').classList.remove('warning');
  text('#webhook-description', 'در حال دریافت وضعیت وب‌هوک این فضا…'); text('#bot-checked-at', '');
  text('#bot-token-feedback', 'توکن فعلی هیچ‌گاه نمایش داده نمی‌شود.');
  $('#subscriber-bot-link').hidden = true; $('#subscriber-bot-link').removeAttribute('href');
  $('#register-webhook').disabled = true; $('#health-arc').setAttribute('stroke-dasharray', '0 428');
  for (const id of ['#global-error', '#bot-token-error', '#telegram-status-error', '#compose-error']) showError(id, '');
  loading($('#delivery-chart')); loading($('#recent-notifications'));
  syncSelects();
}
async function switchTenant(id) {
  if (state.activeWrites) { $('#tenant-selector').value = state.tenantId; syncSelects(); toast('تا پایان ذخیره یا ارسال، تغییر فضا امکان‌پذیر نیست.', true); return; }
  if (!state.tenants.some(tenant => tenant.id === id)) throw new Error('فضای انتخاب‌شده وجود ندارد.');
  state.epoch++; state.tenantId = id; clearTenantData(); renderTenantSelector();
  await refresh({ initial: true });
}
async function loadTenants() {
  const result = await api('/api/admin/tenants');
  if (!state.authenticated) return;
  state.tenants = result.tenants; renderTenantSelector(); renderTenants();
  if (!state.tenantId || !state.tenants.some(tenant => tenant.id === state.tenantId)) {
    const fallback = state.tenants.find(tenant => tenant.isDefault) || state.tenants[0];
    if (fallback) await switchTenant(fallback.id);
  }
}
function renderTenants() {
  text('#tenants-count', `${count(state.tenants.length)} فضای مستقل · مدیریت مرکزی`);
  if (!state.tenants.length) { empty($('#tenants-table'), 'فضایی وجود ندارد', 'یک فضای اعلان بسازید و بات آن را متصل کنید.', { label: 'ساخت فضا', run: () => openTenantEditor() }); return; }
  const { element, tbody } = table(['فضا / شناسه', 'وضعیت', 'بات', 'سهمیهٔ روزانه', '']);
  for (const tenant of state.tenants) {
    const row = node('tr'); const cell = node('td'); const content = node('div', 'app-cell'); const details = node('div');
    details.append(node('strong', '', tenant.name), node('small', '', tenant.id + (tenant.isDefault ? ' · پیش‌فرض' : '')));
    content.append(node('span', 'app-initial', [...tenant.name][0] || 'T'), details); cell.append(content);
    const status = node('td'); status.append(badge(tenant.enabled ? 'active' : 'inactive'));
    const bot = node('td', '', tenant.botUsername ? `@${tenant.botUsername}` : tenant.botConfigured ? 'توکن تعریف شده' : 'متصل نشده'); bot.dir = 'auto';
    const actions = node('td'); const buttons = node('div', 'tenant-row-actions');
    const select = node('button', 'button secondary small-button', tenant.id === state.tenantId ? 'انتخاب‌شده' : 'انتخاب'); select.type = 'button'; select.disabled = tenant.id === state.tenantId || state.activeWrites > 0; select.addEventListener('click', () => handleLoad(() => switchTenant(tenant.id)));
    const edit = node('button', 'icon-button'); edit.type = 'button'; edit.setAttribute('aria-label', `تنظیمات فضای ${tenant.name}`); edit.append(icon('settings')); edit.addEventListener('click', () => openTenantEditor(tenant.id));
    const guide = node('button', 'icon-button'); guide.type = 'button'; guide.setAttribute('aria-label', `راهنمای API فضای ${tenant.name}`); guide.title = 'راهنمای API'; guide.append(icon('code'));
    guide.addEventListener('click', () => handleLoad(async () => { if (state.tenantId !== tenant.id) await switchTenant(tenant.id); if (state.tenantId === tenant.id) changeTab('api'); }));
    buttons.append(select, guide, edit); actions.append(buttons); row.append(cell, status, bot, node('td', '', count(tenant.limits.notificationsPerDay)), actions); tbody.append(row);
  }
  $('#tenants-table').replaceChildren(element);
}
function renderUsage(data) {
  state.usage = data;
  const definitions = [ ['اعلان امروز · UTC', data.usage.notificationsToday, data.limits.notificationsPerDay], ['مشترکان فعال', data.usage.activeSubscribers, data.limits.maxSubscribers], ['تحویل در انتظار', data.usage.pendingDeliveries, data.limits.maxPendingDeliveries], ['سقف درخواست در دقیقه', null, data.limits.requestsPerMinute] ];
  $('#tenant-usage').replaceChildren(...definitions.map(([label, used, limit]) => {
    const item = node('div', 'usage-item'); const value = node('strong', '', used === null ? count(limit) : `${count(used)} / ${count(limit)}`); value.dir = 'ltr';
    item.append(node('span', '', label), value); return item;
  }));
}
function openTenantEditor(id = null) {
  if (state.activeWrites) { toast('یک عملیات در حال ذخیره است. کمی صبر کنید.', true); return; }
  const tenant = id ? state.tenants.find(item => item.id === id) : null;
  state.editTenantId = tenant?.id || null; state.editTenantVersion = tenant?.version;
  $('#tenant-form').reset(); showError('#tenant-form-error', '');
  text('#tenant-dialog-heading', tenant ? 'تنظیمات فضای اعلان' : 'ساخت فضای اعلان');
  $('#tenant-name').value = tenant?.name || ''; $('#tenant-id').value = tenant?.id || ''; $('#tenant-id').readOnly = Boolean(tenant);
  $('#tenant-enabled').checked = tenant ? tenant.enabled : true; $('#tenant-enabled-row').hidden = !tenant;
  for (const [key, id] of Object.entries({ requestsPerMinute: '#limit-requests', notificationsPerDay: '#limit-notifications', maxSubscribers: '#limit-subscribers', maxPendingDeliveries: '#limit-pending' })) {
    $(id).value = tenant?.limits[key] ?? ({ requestsPerMinute: 120, notificationsPerDay: 10000, maxSubscribers: 10000, maxPendingDeliveries: 100000 })[key];
  }
  $('#tenant-dialog').showModal();
}
function updateApplication(application) {
  const index = state.applications.findIndex(item => item.id === application.id);
  if (index < 0) state.applications.push(application); else state.applications[index] = application;
  renderApplications();
}
async function loadApplications() {
  const result = await api('/api/admin/applications');
  if (!state.authenticated) return;
  state.applications = result.applications; applicationsLoaded = true; renderApplications();
}
function renderApplications() {
  text('#applications-count', `${count(state.applications.length)} اپلیکیشن در فضای ${selectedTenant()?.name || 'انتخاب‌شده'}`);
  const composerValue = $('#compose-app').value, filterValue = $('#application-filter').value;
  const active = state.applications.filter(application => application.enabled);
  const placeholder = node('option', '', active.length ? 'اپلیکیشن را انتخاب کنید' : 'ابتدا یک اپلیکیشن فعال بسازید'); placeholder.value = '';
  $('#compose-app').replaceChildren(placeholder, ...active.map(application => { const option = node('option', '', application.name); option.value = application.id; return option; }));
  if (active.some(application => application.id === composerValue)) $('#compose-app').value = composerValue;
  else if (active.length === 1) $('#compose-app').value = active[0].id;
  const all = node('option', '', 'همهٔ اپلیکیشن‌ها'); all.value = '';
  $('#application-filter').replaceChildren(all, ...state.applications.map(application => { const option = node('option', '', application.name); option.value = application.id; return option; }));
  if (state.applications.some(application => application.id === filterValue)) $('#application-filter').value = filterValue;
  syncSelects();
  updateApiExample();
  if (!state.applications.length) { empty($('#applications-table'), 'اولین سرویس را متصل کنید', 'یک اپلیکیشن بسازید تا کلید ارسال مستقل آن را دریافت کنید.', { label: 'ساخت اپلیکیشن', run: () => openApplicationEditor() }); return; }
  const { element, tbody } = table(['اپلیکیشن / شناسه', 'وضعیت', 'کلید ارسال', 'زمان ساخت', '']);
  for (const application of state.applications) {
    const row = node('tr'); const cell = node('td'); const wrap = node('div', 'app-cell'); const detail = node('div');
    detail.append(node('strong', '', application.name), node('small', '', application.id + (application.isLegacy ? ' · سازگار با تنظیمات قبلی' : '')));
    wrap.append(node('span', 'app-initial', [...application.name][0] || 'A'), detail); cell.append(wrap);
    const status = node('td'); status.append(badge(application.enabled ? 'active' : 'inactive'));
    const key = node('td'); key.append(node('span', `badge ${application.keyConfigured ? 'success' : 'warning'}`, application.keyConfigured ? 'تعریف شده' : 'تعریف نشده'));
    const actions = node('td'); const edit = node('button', 'button secondary small-button', 'مدیریت و کلید'); edit.type = 'button'; edit.addEventListener('click', () => openApplicationEditor(application.id)); actions.append(edit);
    row.append(cell, status, key, timeCell(application.createdAt), actions); tbody.append(row);
  }
  $('#applications-table').replaceChildren(element);
}
function openApplicationEditor(id = null) {
  if (!state.tenantId || state.activeWrites) { toast('ابتدا یک فضا انتخاب کنید و منتظر پایان عملیات بمانید.', true); return; }
  const application = id ? state.applications.find(item => item.id === id) : null;
  state.editApplicationId = application?.id || null; state.editApplicationVersion = application?.version; state.editApplicationTenantId = state.tenantId;
  $('#application-form').reset(); showError('#application-form-error', '');
  text('#application-dialog-heading', application ? 'مدیریت اپلیکیشن' : 'ساخت اپلیکیشن');
  text('#application-tenant-name', `فضای اعلان: ${selectedTenant()?.name || state.tenantId}`);
  $('#application-id').value = application?.id || ''; $('#application-id').readOnly = Boolean(application); $('#application-name').value = application?.name || '';
  $('#application-enabled').checked = application ? application.enabled : true; $('#application-enabled-row').hidden = !application; $('#application-key-actions').hidden = !application;
  $('#application-dialog').showModal();
}
function revealApplicationKey(application, apiKey) {
  text('#tenant-key-owner', `اپلیکیشن: ${application.name} · فضای ${selectedTenant()?.name || state.tenantId}`);
  $('#tenant-send-key').value = apiKey; $('#tenant-key-dialog').showModal();
}
function updateSubscriberSelection() {
  const idsOnPage = new Set(state.subscribers.map(subscriber => String(subscriber.chatId)));
  for (const id of state.selectedSubscribers) if (!idsOnPage.has(id)) state.selectedSubscribers.delete(id);
  text('#selected-subscribers-count', `${count(state.selectedSubscribers.size)} انتخاب‌شده`);
  $('#ban-selected').disabled = !state.selectedSubscribers.size || state.activeWrites > 0;
  $('#unban-selected').disabled = !state.selectedSubscribers.size || state.activeWrites > 0;
  const selectAll = $('#select-all-subscribers'); selectAll.checked = state.subscribers.length > 0 && state.selectedSubscribers.size === state.subscribers.length;
  selectAll.indeterminate = state.selectedSubscribers.size > 0 && state.selectedSubscribers.size < state.subscribers.length;
}
async function setSubscriberBan(chatIds, banned) {
  const tenantId = state.tenantId;
  const reason = $('#ban-reason').value.trim();
  if (!chatIds.length) return;
  chatIds = chatIds.filter(id => {
    const subscriber = state.subscribers.find(item => String(item.chatId) === String(id));
    return subscriber && Boolean(subscriber.banned) !== banned;
  });
  if (!chatIds.length) { toast('مشترکان انتخاب‌شده از قبل در این وضعیت هستند.'); return; }
  if (chatIds.length > 100) { toast('در هر عملیات حداکثر ۱۰۰ مشترک را انتخاب کنید.', true); return; }
  $('#ban-selected').disabled = true; $('#unban-selected').disabled = true;
  try {
    const result = await api(tenantPath('subscribers/ban', tenantId), { method: 'POST', body: JSON.stringify({ chatIds, banned, ...(banned && reason ? { reason } : {}) }) });
    state.selectedSubscribers.clear(); $('#ban-reason').value = '';
    toast(banned ? `${count(result.updated)} مشترک مسدود شد.` : `مسدودیت ${count(result.updated)} مشترک رفع شد؛ برای عضویت دوباره باید /start بفرستند.`);
    await loadSubscribers(false); await refresh({ manual: true });
  } catch (error) { if (!error.stale) toast(error.message, true); }
  finally { updateSubscriberSelection(); }
}

async function api(path, options = {}) {
  const scoped = /^\/api\/admin\/(overview|settings|status|context|subscribers|notifications|webhook|usage|applications)(?=\/|\?|$)/.test(path);
  if (scoped) path = path.replace('/api/admin/', `${tenantPath('')}/`);
  const epoch = state.epoch;
  const guarded = path.startsWith('/api/admin/') && !['/api/admin/login', '/api/admin/logout', '/api/admin/session'].includes(path);
  const write = options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && !['/api/admin/login', '/api/admin/logout'].includes(path);
  if (write) { state.activeWrites++; $('#tenant-selector').disabled = true; }
  try {
    let response;
    try { response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }); }
    catch { if (guarded && epoch !== state.epoch) throw staleResponse(); throw new Error('ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.'); }
    let data;
    try { data = await response.json(); } catch { if (guarded && epoch !== state.epoch) throw staleResponse(); throw new Error('پاسخ سرور معتبر نیست. تنظیمات Worker را بررسی کنید.'); }
    if (guarded && epoch !== state.epoch) throw staleResponse();
    if (!response.ok) {
      if (response.status === 401 && state.authenticated) { showAuth(); showError('#login-error', 'برای ادامه، دوباره وارد شوید.'); }
      const error = new Error(data.error?.message || `درخواست ناموفق بود (${response.status}).`); error.code = data.error?.code; error.status = response.status; throw error;
    }
    return data;
  } finally { if (write) { state.activeWrites = Math.max(0, state.activeWrites - 1); $('#tenant-selector').disabled = state.activeWrites > 0 || !state.tenants.length; } }
}

function loading(container, message = 'در حال دریافت اطلاعات') {
  const content = node('div', 'loading-state'); content.append(node('span', 'spinner'), node('span', '', message));
  container.replaceChildren(content);
}
function empty(container, title, description, action) {
  const content = node('div', 'empty-state');
  const illustration = node('span', 'empty-icon'); illustration.append(icon('relay'));
  content.append(illustration, node('strong', '', title), node('p', '', description));
  if (action) { const button = node('button', 'button secondary', action.label); button.type = 'button'; button.addEventListener('click', action.run); content.append(button); }
  container.replaceChildren(content);
}
function table(headers) {
  const element = node('table'); const thead = node('thead'); const row = node('tr');
  for (const header of headers) { const th = node('th', '', header); th.scope = 'col'; row.append(th); }
  thead.append(row); const tbody = node('tbody'); element.append(thead, tbody);
  return { element, tbody };
}
function appCell(record) {
  const td = node('td'); const wrap = node('div', 'app-cell');
  const initial = node('span', 'app-initial', [...record.application][0]?.toUpperCase() || 'R');
  const content = node('div'); const name = node('strong', '', record.application); name.dir = 'auto'; name.title = record.application;
  content.append(name, node('small', '', record.environment || 'محیط مشخص نشده'));
  wrap.append(initial, content); td.append(wrap); return td;
}
function renderNotifications(container, records, isRecent = false) {
  if (!records.length) {
    empty(container, isRecent ? 'اولین رویداد، آغاز یک مسیر.' : 'اعلانی پیدا نشد', isRecent ? 'پس از ثبت اولین اعلان، وضعیت تحویل آن به مشترکان اینجا نمایش داده می‌شود.' : 'هنوز اعلانی ثبت نشده یا موردی با این فیلترها وجود ندارد.', { label: isRecent ? 'ارسال اولین اعلان' : 'ارسال اعلان جدید', run: openComposer });
    return;
  }
  const { element, tbody } = table(['اپلیکیشن', 'رویداد / سطح', 'وضعیت', 'تحویل', 'زمان ثبت', '']);
  for (const record of records) {
    const row = node('tr'); row.append(appCell(record));
    const event = node('td'); const name = node('div', 'event-name', record.event); name.title = record.event;
    event.append(name, badge(record.level)); row.append(event);
    const status = node('td'); status.append(badge(record.status)); row.append(status);
    const delivery = node('td'); const fraction = node('span', 'delivery-count');
    fraction.append(node('strong', '', count(record.sent)), node('span', '', ` / ${count(record.total)}`)); delivery.append(fraction);
    delivery.title = `${count(record.sent)} تحویل موفق از ${count(record.total)} مشترک؛ ${count(record.unknown)} نامشخص`;
    row.append(delivery, timeCell(record.createdAt));
    const actions = node('td'); const button = node('button', 'icon-button table-detail'); button.type = 'button';
    button.setAttribute('aria-label', `جزئیات اعلان ${record.application}: ${record.event}`); button.append(icon('chevron')); button.addEventListener('click', () => openDetail(record.id)); actions.append(button); row.append(actions); tbody.append(row);
  }
  container.replaceChildren(element);
}
function renderPagination(container, page, handler) {
  container.replaceChildren();
  if (!page.total) { container.hidden = true; return; }
  container.hidden = false;
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const controls = node('div', 'pagination-controls');
  const previous = node('button', 'button secondary', 'قبلی'); previous.type = 'button'; previous.disabled = page.page <= 1; previous.addEventListener('click', () => handler(page.page - 1));
  const next = node('button', 'button secondary', 'بعدی'); next.type = 'button'; next.disabled = page.page >= pages; next.addEventListener('click', () => handler(page.page + 1));
  controls.append(previous, node('span', '', `${count(page.page)} از ${count(pages)}`), next);
  container.append(node('span', '', `${count(page.total)} مورد ثبت‌شده`), controls);
}
function svgNode(tag, attributes = {}, content) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (content !== undefined) element.textContent = String(content);
  return element;
}
function renderChart(daily) {
  const container = $('#delivery-chart');
  const values = daily || []; const maxValue = Math.max(1, ...values.map(day => Math.max(day.sent, day.failed)));
  const maximum = maxValue > 10 ? Math.ceil(maxValue / 10) * 10 : maxValue;
  const width = 630, height = 240, left = 43, right = 14, top = 18, bottom = 35;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'تعداد تحویل موفق و ناموفق اعلان‌ها به تفکیک روز UTC' });
  const title = svgNode('title', {}, 'گزارش روزانهٔ تحویل؛ روزها بر مبنای UTC هستند'); svg.append(title);
  for (let index = 0; index <= 4; index++) {
    const y = top + plotHeight * index / 4;
    svg.append(svgNode('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'chart-grid' }));
    svg.append(svgNode('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'chart-axis' }, count(Math.round(maximum * (4 - index) / 4))));
  }
  const step = plotWidth / Math.max(values.length, 1), barWidth = Math.min(15, step * .23);
  values.forEach((day, index) => {
    const center = left + step * (index + .5);
    for (const [key, offset] of [['sent', -barWidth - 2], ['failed', 2]]) {
      const barHeight = Math.max(0, Number(day[key]) || 0) / maximum * plotHeight;
      if (barHeight > 0) {
        const bar = svgNode('rect', { x: center + offset, y: top + plotHeight - barHeight, width: barWidth, height: barHeight, rx: 3, class: `chart-bar-${key}` });
        bar.append(svgNode('title', {}, `${day.date}: ${labels[key]} ${count(day[key])}`)); svg.append(bar);
      }
    }
    const date = validDate(`${day.date}T12:00:00Z`);
    svg.append(svgNode('text', { x: center, y: height - 10, 'text-anchor': 'middle', class: 'chart-axis' }, date ? chartDateFormatter.format(date) : day.date));
  });
  container.replaceChildren(svg);
  if (!values.some(day => day.sent || day.failed)) { const note = node('div', 'chart-empty-note'); note.append(icon('activity'), node('span', '', 'هنوز تحویلی ثبت نشده است')); container.append(note); }
  text('#chart-range', `${count(values.length)} روز · UTC`);
}
function renderOverview(data) {
  state.overview = data;
  text('#metric-today', count(data.notifications.today)); text('#metric-sent', count(data.deliveries.sent)); text('#metric-active', count(data.subscribers.active)); text('#metric-pending', count(data.deliveries.pending));
  text('#metric-subscribers-foot', `از ${count(data.subscribers.total)} مشترک ثبت‌شده`);
  text('#health-failed', count(data.deliveries.failed)); text('#health-unknown', count(data.deliveries.unknown)); text('#health-skipped', count(data.deliveries.skipped));
  const definite = data.deliveries.sent + data.deliveries.failed;
  const percentage = definite ? data.deliveries.sent / definite * 100 : null;
  text('#health-percentage', percentage === null ? '—' : `${faPercent.format(percentage)}٪`);
  $('#health-arc').setAttribute('stroke-dasharray', `${percentage === null ? 0 : percentage / 100 * 427.26} 427.26`);
  $('#health-ring').setAttribute('aria-label', percentage === null ? 'هنوز نتیجهٔ قطعی تحویل ثبت نشده است' : `${faPercent.format(percentage)} درصد موفقیت از تحویل‌های قطعی؛ نتایج نامشخص در این نرخ محاسبه نمی‌شوند`);
  renderChart(data.daily); renderNotifications($('#recent-notifications'), data.recent.slice(0, 5), true);
}
function renderStatus(data) {
  state.status = data;
  const connected = Boolean(data.bot);
  const webhookReady = Boolean(data.webhook?.url && data.webhook.url === `${location.origin}/telegram/${encodeURIComponent(state.tenantId)}/webhook`);
  const paused = Boolean(state.settings?.paused);
  const ready = connected && webhookReady && !data.telegramError && !paused && Boolean(selectedTenant()?.enabled);
  $('#connection-banner').classList.toggle('warning', !ready);
  if (!selectedTenant()?.enabled) { text('#connection-title', 'این فضای اعلان غیرفعال است'); text('#connection-detail', 'دریافت و ارسال اعلان‌های این فضا متوقف است. برای فعال‌سازی به مدیریت فضاها بروید.'); }
  else if (paused) { text('#connection-title', 'ارسال اعلان‌ها موقتاً متوقف است'); text('#connection-detail', 'برای ادامهٔ تحویل اعلان‌های صف‌شده، ارسال را از تنظیمات فعال کنید.'); }
  else if (ready) { text('#connection-title', `${data.bot.username ? `@${data.bot.username}` : data.bot.first_name} آمادهٔ دریافت رویدادهاست`); text('#connection-detail', 'اتصال بات و وب‌هوک برقرار است. اعلان‌های جدید برای مشترکان فعال در صف قرار می‌گیرند.'); }
  else if (!data.configured.bot) { text('#connection-title', 'بات شما منتظر اتصال است'); text('#connection-detail', 'توکن بات این فضا را در تنظیمات ذخیره کنید، سپس وب‌هوک را ثبت کنید.'); }
  else if (!connected || data.telegramError) { text('#connection-title', 'اتصال به تلگرام نیاز به بررسی دارد'); text('#connection-detail', data.telegramError || 'پاسخ معتبر از تلگرام دریافت نشد. جزئیات را در تنظیمات ببینید.'); }
  else { text('#connection-title', 'اتصال بات برقرار است؛ وب‌هوک را تکمیل کنید'); text('#connection-detail', 'برای ثبت خودکار عضویت کاربران، وب‌هوک این Worker را در تنظیمات ثبت کنید.'); }
  text('#bot-checked-at', data.checkedAt ? `آخرین بررسی تلگرام: ${dateText(data.checkedAt)} · کش حداکثر ۶۰ ثانیه` : 'زمان بررسی اتصال در دسترس نیست.');
  const statusBadge = $('#bot-status-badge'); statusBadge.className = `badge ${ready ? 'success' : 'warning'}`; statusBadge.textContent = ready ? 'متصل' : 'نیازمند بررسی';
  const configurations = [ ['توکن بات', data.configured.bot], ['Secret وب‌هوک', data.configured.webhookSecret], ['کلید ارسال اپلیکیشن', data.configured.apiKey] ];
  $('#bot-configuration').replaceChildren(...configurations.map(([name, configured]) => { const item = node('div', 'configuration-item'); item.append(node('strong', '', name), node('span', `badge ${configured ? 'success' : 'warning'}`, configured ? 'تعریف شده' : 'تعریف نشده')); return item; }));
  showError('#telegram-status-error', data.telegramError || data.webhook?.last_error_message || '');
  const webhook = data.webhook;
  if (data.telegramError || (!webhook && data.configured.bot)) text('#webhook-description', 'وضعیت وب‌هوک قابل بررسی نیست؛ ابتدا ارتباط با تلگرام را برقرار کنید.');
  else if (!data.configured.bot) text('#webhook-description', 'پس از تعریف توکن بات و برقراری اتصال، وضعیت وب‌هوک نمایش داده می‌شود.');
  else text('#webhook-description', webhook?.url ? `آدرس ثبت‌شده: ${webhook.url} · ${count(webhook.pending_update_count)} به‌روزرسانی در انتظار` : 'وب‌هوکی ثبت نشده است. آن را برای ثبت عضویت کاربران به این Worker متصل کنید.');
  $('#register-webhook').disabled = !data.configured.bot || !data.configured.webhookSecret;
  const botLink = $('#subscriber-bot-link');
  if (data.bot?.username && /^[a-zA-Z0-9_]+$/.test(data.bot.username)) { botLink.href = `https://t.me/${data.bot.username}`; botLink.hidden = false; } else { botLink.hidden = true; botLink.removeAttribute('href'); }
}
function renderCountries() {
  const countries = $('#countries').value.toUpperCase().split(/[\s,،;]+/).filter(Boolean);
  $('#country-chips').replaceChildren(...[...new Set(countries)].map(code => node('span', `country-chip${/^[A-Z]{2}$/.test(code) ? '' : ' invalid'}`, `${flag(code)} ${code}`)));
}
function renderSettings(settings) {
  state.settings = settings; state.settingsDirty = false;
  const mapping = { projectName: '#project-name', retentionDays: '#retention-days', deliveryPerSecond: '#delivery-rate', welcomeMessage: '#welcome-message', ipMode: '#ip-mode', countryMode: '#country-mode' };
  for (const [key, selector] of Object.entries(mapping)) $(selector).value = settings[key];
  $('#paused').checked = settings.paused; $('#show-country-flag').checked = settings.showCountryFlag;
  $('#ip-rules').value = settings.ipRules.join('\n'); $('#countries').value = settings.countries.join(', ');
  text('#settings-save-status', 'تنظیمات ذخیره‌شده نمایش داده می‌شوند.');
  renderCountries();
  if (state.status) renderStatus(state.status);
  syncSelects();
}
async function loadNotifications(showLoading = true) {
  const request = ++state.notificationRequest;
  if (showLoading) loading($('#notifications-table'));
  const query = new URLSearchParams({ page: String(state.notificationPage), level: $('#level-filter').value, search: $('#notification-search').value.trim(), applicationId: $('#application-filter').value });
  let result;
  try { result = await api(`/api/admin/notifications?${query}`); }
  catch (error) {
    if (showLoading && state.authenticated && request === state.notificationRequest) empty($('#notifications-table'), 'اعلان‌ها دریافت نشدند', error.message, { label: 'تلاش دوباره', run: () => handleLoad(() => loadNotifications()) });
    throw error;
  }
  if (!state.authenticated || request !== state.notificationRequest) return;
  renderNotifications($('#notifications-table'), result.items);
  renderPagination($('#notifications-pagination'), result, page => { state.notificationPage = page; handleLoad(() => loadNotifications()); });
}
async function loadSubscribers(showLoading = true) {
  const request = ++state.subscriberRequest;
  if (showLoading) loading($('#subscribers-table'));
  let result;
  try { result = await api(`/api/admin/subscribers?page=${state.subscriberPage}`); }
  catch (error) {
    if (showLoading && state.authenticated && request === state.subscriberRequest) empty($('#subscribers-table'), 'مشترکان دریافت نشدند', error.message, { label: 'تلاش دوباره', run: () => handleLoad(() => loadSubscribers()) });
    throw error;
  }
  if (!state.authenticated || request !== state.subscriberRequest) return;
  state.subscribers = result.items; updateSubscriberSelection();
  text('#subscribers-count', `${count(result.total)} مشترک ثبت‌شده · وضعیت فعلی عضویت`);
  if (!result.items.length) { empty($('#subscribers-table'), 'هنوز مشترکی ندارید', 'لینک بات را با تیم به اشتراک بگذارید. هر کاربر با ارسال /start، عضو دریافت اعلان‌ها می‌شود.'); }
  else {
    const { element, tbody } = table(['انتخاب', 'مشترک', 'شناسهٔ چت', 'وضعیت', 'زمان عضویت', 'آخرین تغییر', 'عملیات']);
    for (const subscriber of result.items) {
      const row = node('tr'); const td = node('td'); const wrap = node('div', 'app-cell'); const detail = node('div');
      const name = node('strong', '', subscriber.firstName || 'کاربر تلگرام'); name.dir = 'auto';
      const username = node('small', '', subscriber.username ? `@${subscriber.username}` : 'بدون نام کاربری'); username.dir = 'auto';
      const preferences = node('small', '', subscriber.applicationMode === 'selected' ? `${count((subscriber.applicationIds || []).length)} اپلیکیشن انتخاب‌شده` : 'همهٔ اپلیکیشن‌ها');
      if (subscriber.applicationMode === 'selected') preferences.title = (subscriber.applicationIds || []).map(id => state.applications.find(application => application.id === id)?.name || id).join('، ');
      detail.append(name, username, preferences); wrap.append(node('span', 'app-initial', [...(subscriber.firstName || 'T')][0]), detail); td.append(wrap);
      const id = node('td', '', subscriber.chatId); id.dir = 'ltr';
      const status = node('td'); status.append(badge(subscriber.banned ? 'banned' : subscriber.active ? 'active' : 'inactive'));
      if (subscriber.banReason) { const reason = node('small', 'ban-reason', subscriber.banReason); status.append(reason); }
      const selection = node('td'); const checkbox = node('input', 'subscriber-selection'); checkbox.type = 'checkbox'; checkbox.value = String(subscriber.chatId); checkbox.checked = state.selectedSubscribers.has(checkbox.value); checkbox.setAttribute('aria-label', `انتخاب ${subscriber.firstName || subscriber.chatId}`); checkbox.addEventListener('change', () => { if (checkbox.checked) state.selectedSubscribers.add(checkbox.value); else state.selectedSubscribers.delete(checkbox.value); updateSubscriberSelection(); }); selection.append(checkbox);
      const actions = node('td'); const toggle = node('button', 'button secondary small-button', subscriber.banned ? 'رفع مسدودیت' : 'مسدود کردن'); toggle.type = 'button'; toggle.addEventListener('click', () => setSubscriberBan([String(subscriber.chatId)], !subscriber.banned)); actions.append(toggle);
      row.append(selection, td, id, status, timeCell(subscriber.joinedAt), timeCell(subscriber.updatedAt), actions); tbody.append(row);
    }
    $('#subscribers-table').replaceChildren(element);
  }
  renderPagination($('#subscribers-pagination'), result, page => { state.subscriberPage = page; handleLoad(() => loadSubscribers()); });
}
async function handleLoad(work) {
  const epoch = state.epoch;
  try { await work(); if (state.authenticated && epoch === state.epoch) showError('#global-error', ''); }
  catch (error) { if (!error.stale && state.authenticated && epoch === state.epoch) showError('#global-error', error.message); }
}
async function refresh({ initial = false, manual = false } = {}) {
  if (state.authenticated && state.tab === 'login-audit') { await handleLoad(() => loadLoginAudit(manual)); return; }
  if (!state.authenticated || !state.tenantId || state.refreshPending) return;
  const epoch = state.epoch;
  state.refreshPending = true; $('#refresh').classList.add('spinning'); $('#refresh').disabled = true;
  try {
    const tasks = [];
    if (!initial) tasks.push(api(tenantPath('')).then(result => {
      if (state.authenticated && selectedTenant()?.version !== result.tenant.version) updateTenant(result.tenant);
    }));
    if (initial || manual || state.tab === 'overview') tasks.push(api('/api/admin/overview').then(result => { if (state.authenticated) renderOverview(result); }).catch(error => {
      if (!error.stale && state.authenticated && epoch === state.epoch && !state.overview) {
        empty($('#delivery-chart'), 'گزارش دریافت نشد', 'برای دریافت دوباره از دکمهٔ به‌روزرسانی استفاده کنید.');
        empty($('#recent-notifications'), 'اعلان‌ها دریافت نشدند', error.message, { label: 'تلاش دوباره', run: () => refresh({ manual: true }) });
      }
      throw error;
    }));
    if (initial || (manual && (!state.settingsDirty || state.tab !== 'settings'))) tasks.push(api('/api/admin/settings').then(result => { if (state.authenticated && !state.settingsDirty) renderSettings(result); }));
    if (initial || (manual && ['applications', 'api'].includes(state.tab))) tasks.push(loadApplications());
    if (initial || manual) tasks.push(api('/api/admin/status').then(result => { if (state.authenticated) renderStatus(result); }));
    if (initial || manual || state.tab === 'overview') tasks.push(api('/api/admin/usage').then(result => { if (state.authenticated) renderUsage(result); }));
    if (manual && state.tab === 'tenants') tasks.push(loadTenants());
    if (state.tab === 'notifications') tasks.push(loadNotifications(initial || manual));
    if (state.tab === 'subscribers') tasks.push(loadSubscribers(initial || manual));
    if (initial) tasks.push(api('/api/admin/context').then(context => {
      if (!state.authenticated) return;
      const ip = node('span', '', 'IP درخواست فعلی: '); const code = node('code', '', context.ip || 'نامشخص'); code.dir = 'ltr'; ip.append(code);
      $('#request-context').replaceChildren(ip, node('span', '', `کشور: ${flag(context.country)} ${context.country || 'نامشخص'}`), node('span', '', `منبع: ${context.source || 'نامشخص'}`));
    }));
    const results = await Promise.allSettled(tasks);
    if (!state.authenticated || epoch !== state.epoch) return;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) { showError('#global-error', failure.reason.message); text('#last-refresh', 'به‌روزرسانی کامل نشد'); }
    else { showError('#global-error', ''); text('#last-refresh', `به‌روز شده در ${timeFormatter.format(new Date())}`); if (manual) toast('اطلاعات به‌روز شد.'); }
  } finally { if (epoch === state.epoch) { state.refreshPending = false; $('#refresh').classList.remove('spinning'); $('#refresh').disabled = false; } }
}
function auditClient(userAgent) {
  const browsers = [[/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Chrome\//, 'Chrome'], [/Firefox\//, 'Firefox'], [/Safari\//, 'Safari'], [/curl\//i, 'curl'], [/wget\//i, 'wget'], [/python/i, 'Python']];
  const systems = [[/Android/i, 'Android'], [/iPhone|iPad/i, 'iOS'], [/Windows/i, 'Windows'], [/Macintosh/i, 'macOS'], [/Linux/i, 'Linux']];
  return [browsers.find(([pattern]) => pattern.test(userAgent))?.[1], systems.find(([pattern]) => pattern.test(userAgent))?.[1]].filter(Boolean).join(' · ') || 'مشخصات درخواست';
}

async function loadLoginAudit(reset = false) {
  if (!state.authenticated) return;
  if (reset) auditPage = 1;
  const request = ++auditRequest;
  const params = new URLSearchParams({ limit: '25', offset: String((auditPage - 1) * 25) });
  const ip = $('#login-audit-search').value.trim();
  const outcome = $('#login-audit-outcome').value;
  if (ip) params.set('ip', ip);
  if (outcome) params.set('outcome', outcome);
  busy($('#reload-login-audit'), true); showError('#login-audit-error', '');
  loading($('#login-audit-table'));
  try {
    const result = await api(`/api/admin/login-audit?${params}`);
    if (!state.authenticated || request !== auditRequest) return;
    const lastPage = Math.max(1, Math.ceil(result.total / result.limit));
    if (auditPage > lastPage) { auditPage = lastPage; return await loadLoginAudit(); }
    text('#login-audit-count', `${count(result.total)} تلاش ثبت‌شده${ip || outcome ? ' با این فیلتر' : ''}`);
    text('#login-audit-retention', '۳۰ روز اخیر · حداکثر ۵٬۰۰۰ تلاش');
    if (!result.entries.length) empty($('#login-audit-table'), 'تلاشی پیدا نشد', ip || outcome ? 'فیلترها را تغییر دهید و دوباره بررسی کنید.' : 'هنوز تلاش ناموفقی برای ورود ثبت نشده است.');
    else {
      const { element, tbody } = table(['زمان تلاش', 'آدرس IP', 'کشور', 'مرورگر و مشخصات', 'نتیجه']);
      const formatter = new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const regions = new Intl.DisplayNames(['fa'], { type: 'region' });
      for (const entry of result.entries) {
        const row = node('tr');
        const when = node('td', 'audit-time'); const date = validDate(entry.createdAt);
        when.textContent = date ? formatter.format(date) : '—'; if (date) when.title = date.toISOString();
        const address = node('td'); const code = node('code', 'audit-ip', entry.ip || 'نامشخص'); code.dir = 'ltr'; address.append(code);
        const country = node('td', 'audit-country');
        const knownCountry = /^[A-Z]{2}$/.test(entry.country) && !['XX', 'T1'].includes(entry.country);
        country.append(node('span', 'audit-country-flag', flag(entry.country)), node('span', '', knownCountry ? regions.of(entry.country) : 'نامشخص'));
        const client = node('td', 'audit-client'); const details = node('details');
        details.append(node('summary', '', auditClient(entry.userAgent || '')));
        const agent = node('p', 'audit-agent', entry.userAgent || 'مشخصات مرورگر ارسال نشده است.'); agent.dir = 'ltr'; details.append(agent);
        if (entry.requestId) { const trace = node('p', 'audit-agent', `Request ID: ${entry.requestId}`); trace.dir = 'ltr'; details.append(trace); }
        client.append(details);
        const status = node('td'); status.append(node('span', `badge ${entry.outcome === 'rate_limited' ? 'warning' : 'error'}`, entry.outcome === 'rate_limited' ? 'محدودیت تلاش' : 'اطلاعات ورود نادرست'));
        if (entry.outcome === 'rate_limited') status.append(node('small', 'audit-outcome-note', 'اعتبار کلید بررسی نشد'));
        row.append(when, address, country, client, status); tbody.append(row);
      }
      $('#login-audit-table').replaceChildren(element);
    }
    renderPagination($('#login-audit-pagination'), { total: result.total, pageSize: result.limit, page: auditPage }, page => { auditPage = page; handleLoad(() => loadLoginAudit()); });
    text('#last-refresh', `به‌روز شده در ${timeFormatter.format(new Date())}`);
  } catch (error) {
    if (error.stale || !state.authenticated || request !== auditRequest) return;
    text('#login-audit-count', 'گزارش دریافت نشد'); $('#login-audit-table').replaceChildren(); $('#login-audit-pagination').replaceChildren();
    showError('#login-audit-error', error.message); throw error;
  } finally { if (request === auditRequest) busy($('#reload-login-audit'), false); }
}

function changeTab(tab, focus = false) {
  if (!Object.hasOwn(titles, tab)) tab = 'overview';
  state.tab = tab;
  $$('.nav-item[role=tab]').forEach(button => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  $$('.panel').forEach(panel => { panel.hidden = panel.id !== `panel-${tab}`; });
  text('#breadcrumb-current', titles[tab]);
  $('.topbar').classList.toggle('audit-context', tab === 'login-audit');
  $('.tenant-switcher').hidden = tab === 'login-audit';
  history.replaceState(null, '', `#${tab}`);
  if (focus) $(`#tab-${tab}`).focus();
  if (state.authenticated && tab === 'login-audit') { handleLoad(() => loadLoginAudit()); return; }
  if (!state.authenticated || !state.tenantId) return;
  if (tab === 'tenants') renderTenants();
  if (tab === 'applications') renderApplications();
  if (tab === 'api') updateApiExample();
  if (tab === 'notifications') handleLoad(() => loadNotifications());
  if (tab === 'subscribers') handleLoad(() => loadSubscribers());
  if (tab === 'settings' && !state.settings) handleLoad(async () => renderSettings(await api('/api/admin/settings')));
}
function showAuth() {
  auditRequest++; auditPage = 1; clearTimeout(auditSearchTimer);
  $('#login-audit-table').replaceChildren(); $('#login-audit-pagination').replaceChildren();
  $('#login-audit-search').value = ''; $('#login-audit-outcome').value = '';
  text('#login-audit-count', ''); showError('#login-audit-error', '');
  state.epoch++; state.tenantId = null; state.tenants = []; clearTenantData(); renderTenantSelector();
  state.authenticated = false; state.settings = null; state.settingsDirty = false; state.overview = null; state.status = null;
  state.notificationRequest++; state.subscriberRequest++; state.detailRequest++;
  state.composeKey = null; state.composeBody = null;
  $('#app').hidden = true; $('#auth-screen').hidden = false;
  $('#login-form').reset(); $('#settings-form').reset(); $('#compose-form').reset();
  $$('dialog[open]').forEach(dialog => dialog.close());
  for (const id of ['#recent-notifications', '#notifications-table', '#subscribers-table', '#notification-detail', '#request-context', '#bot-configuration']) $(id).replaceChildren();
  for (const id of ['#metric-today', '#metric-sent', '#metric-active', '#metric-pending', '#health-failed', '#health-unknown', '#health-skipped', '#health-percentage']) text(id, '—');
  $('#health-arc').setAttribute('stroke-dasharray', '0 428');
  loading($('#delivery-chart')); loading($('#recent-notifications'));
  showError('#global-error', '');
  $('#login-button').disabled = false; $('#login-button span').textContent = 'ورود به داشبورد';
  syncSelects();
}
async function showApp() {
  state.authenticated = true;
  $('#auth-screen').hidden = true; $('#app').hidden = false;
  $('#api-key').value = ''; showError('#login-error', '');
  changeTab(location.hash.slice(1) || 'overview');
  try { await loadTenants(); }
  catch (error) {
    if (state.authenticated && !error.stale) {
      changeTab('tenants'); showError('#global-error', error.message);
      empty($('#tenants-table'), 'فضاها دریافت نشدند', error.message, { label: 'تلاش دوباره', run: () => handleLoad(loadTenants) });
    }
  }
}
function openComposer() {
  if (!state.tenantId) { toast('ابتدا یک فضای اعلان انتخاب کنید.', true); return; }
  showError('#compose-error', '');
  $('#compose-dialog').showModal();
}
async function openDetail(id) {
  const request = ++state.detailRequest;
  const dialog = $('#detail-dialog');
  loading($('#notification-detail')); if (!dialog.open) dialog.showModal();
  try {
    const data = await api(`/api/admin/notifications/${encodeURIComponent(id)}`);
    if (request !== state.detailRequest || !state.authenticated) return;
    const record = data.notification; const container = $('#notification-detail'); container.replaceChildren();
    const tags = node('div', 'detail-tags'); tags.append(badge(record.level), badge(record.status));
    for (const tag of record.tags || []) tags.append(node('span', 'period-badge', tag));
    container.append(tags);
    const grid = node('dl', 'detail-grid');
    const pairs = [['اپلیکیشن', record.application], ['نوع رویداد', record.event], ['زمان رویداد', dateText(record.timestamp)], ['زمان ثبت', dateText(record.createdAt)], ['محیط', record.environment || 'مشخص نشده'], ['مبدأ درخواست', `${flag(record.source?.country)} ${record.source?.country || 'نامشخص'} · ${record.source?.ip || 'نامشخص'}`]];
    for (const [label, value] of pairs) { const field = node('div'); const dd = node('dd', '', value); dd.dir = 'auto'; field.append(node('dt', '', label), dd); grid.append(field); }
    container.append(grid);
    if (record.title) container.append(node('h3', 'detail-section-title', record.title));
    container.append(node('div', 'detail-text', record.text));
    const links = node('div', 'detail-links');
    for (const [url, label] of [[record.image, 'باز کردن تصویر ↗'], [record.url, 'مشاهدهٔ لینک جزئیات ↗']]) { const link = safeExternalLink(url, label); if (link) links.append(link); }
    if (links.childElementCount) container.append(links);
    if (record.metadata && Object.keys(record.metadata).length) { const metadata = node('pre', 'detail-metadata', JSON.stringify(record.metadata, null, 2)); metadata.dir = 'ltr'; container.append(node('h3', 'detail-section-title', 'اطلاعات تکمیلی'), metadata); }
    const stats = node('div', 'detail-stats');
    for (const [label, value] of [['کل مشترکان', record.total], ['تحویل موفق', record.sent], ['ناموفق', record.failed], ['در انتظار', record.pending], ['نامشخص', record.unknown], ['ردشده', record.skipped]]) stats.append(node('span', '', `${label}: ${count(value)}`));
    container.append(node('h3', 'detail-section-title', 'نتیجهٔ ارسال به مشترکان'), stats);
    if (record.unknown) { const notice = node('div', 'notice compact'); notice.append(icon('alert'), node('span', '', 'نتیجهٔ نامشخص ممکن است به معنی تحویل پیام بدون دریافت پاسخ باشد. برای جلوگیری از پیام تکراری، تکرار خودکار انجام نمی‌شود.')); container.append(notice); }
    if (!data.deliveries.length) { const noDeliveries = node('div'); empty(noDeliveries, 'رکورد تحویلی وجود ندارد', record.status === 'empty' ? 'هنگام ثبت این اعلان، مشترک فعالی وجود نداشت.' : 'با شروع پردازش، جزئیات تحویل در این بخش ثبت می‌شوند.'); container.append(noDeliveries); }
    else {
      const wrap = node('div', 'table-container'); const { element, tbody } = table(['شناسهٔ چت', 'وضعیت', 'تلاش‌ها', 'جزئیات']);
      for (const delivery of data.deliveries) {
        const row = node('tr'); const status = node('td'); status.append(badge(delivery.status));
        const chat = node('td', '', delivery.chatId); chat.dir = 'ltr';
        const detail = [delivery.partial ? 'بخشی از پیام ارسال شده است.' : '', delivery.error || ''].filter(Boolean).join(' ');
        row.append(chat, status, node('td', '', count(delivery.attempts)), node('td', 'detail-error', detail || '—')); tbody.append(row);
      }
      wrap.append(element); container.append(wrap);
      if (data.deliveryTotal > data.deliveries.length) container.append(node('p', 'detail-note', `نمایش ${count(data.deliveries.length)} مورد از ${count(data.deliveryTotal)} تحویل. شمارنده‌های بالا همهٔ تحویل‌ها را پوشش می‌دهند.`));
    }
    container.append(node('p', 'detail-note', `شناسهٔ اعلان: ${record.id}`));
  } catch (error) { if (request === state.detailRequest && state.authenticated) empty($('#notification-detail'), 'جزئیات دریافت نشد', error.message, { label: 'تلاش دوباره', run: () => openDetail(id) }); }
}

$('#tenant-selector').addEventListener('change', event => handleLoad(() => switchTenant(event.target.value)));
$('#create-tenant').addEventListener('click', () => openTenantEditor());
$('#reload-tenants').addEventListener('click', () => handleLoad(loadTenants));
$('#tenant-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget); const tenantId = state.editTenantId;
  const limits = Object.fromEntries(['requestsPerMinute', 'notificationsPerDay', 'maxSubscribers', 'maxPendingDeliveries'].map(key => [key, Number(form.get(key))]));
  const input = { name: String(form.get('name')).trim(), limits, ...(tenantId ? { enabled: form.has('enabled'), expectedVersion: state.editTenantVersion } : { id: String(form.get('id')).trim() }) };
  const button = $('#save-tenant'); busy(button, true); lockFields(event.currentTarget, true); showError('#tenant-form-error', '');
  try {
    const result = await api(tenantId ? tenantPath('', tenantId) : '/api/admin/tenants', { method: tenantId ? 'PATCH' : 'POST', body: JSON.stringify(input) });
    updateTenant(result.tenant); $('#tenant-dialog').close();
    if (!tenantId) { await switchTenant(result.tenant.id); changeTab('settings'); toast('فضا ساخته شد؛ توکن بات را ذخیره کنید، سپس اپلیکیشن بسازید.'); }
    else { if (tenantId === state.tenantId) await refresh({ manual: true }); toast('تنظیمات فضا ذخیره شد.'); }
  } catch (error) { if (!error.stale) showError('#tenant-form-error', error.message); }
  finally { busy(button, false); lockFields($('#tenant-form'), false); }
});
$('#bot-token-form').addEventListener('submit', async event => {
  event.preventDefault(); const tenant = selectedTenant(); if (!tenant) return;
  const botToken = $('#bot-token').value.trim(); $('#bot-token').value = '';
  const button = $('#save-bot-token'); busy(button, true); lockFields(event.currentTarget, true); showError('#bot-token-error', '');
  text('#bot-token-feedback', 'در حال بررسی هویت بات با تلگرام و ذخیرهٔ امن توکن…');
  try {
    const result = await api(tenantPath('bot', tenant.id), { method: 'PUT', body: JSON.stringify({ botToken, expectedVersion: tenant.version }) });
    updateTenant(result.tenant); text('#bot-token-feedback', 'توکن بررسی و ذخیره شد. اکنون وب‌هوک این فضا را ثبت کنید.');
    await refresh({ manual: true }); toast('توکن بات ذخیره شد.');
  } catch (error) { if (!error.stale) { showError('#bot-token-error', error.message); text('#bot-token-feedback', 'توکن جدید ذخیره نشد. برای تلاش دوباره، آن را مجدداً وارد کنید.'); } }
  finally { busy(button, false); lockFields($('#bot-token-form'), false); $('#bot-token').value = ''; }
});
$('#settings-open-applications').addEventListener('click', () => changeTab('applications'));
$('#create-application').addEventListener('click', () => openApplicationEditor());
$('#reload-applications').addEventListener('click', () => handleLoad(loadApplications));
$('#application-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.currentTarget); const appId = state.editApplicationId; const tenantId = state.editApplicationTenantId;
  const input = { name: String(form.get('name')).trim(), ...(appId ? { enabled: form.has('enabled'), expectedVersion: state.editApplicationVersion } : { id: String(form.get('id')).trim() }) };
  const button = $('#save-application'); busy(button, true); lockFields(event.currentTarget, true); $('#rotate-application-key').disabled = true; showError('#application-form-error', '');
  try {
    const result = await api(tenantPath(`applications${appId ? `/${encodeURIComponent(appId)}` : ''}`, tenantId), { method: appId ? 'PATCH' : 'POST', body: JSON.stringify(input) });
    updateApplication(result.application); $('#application-dialog').close();
    if (result.apiKey) revealApplicationKey(result.application, result.apiKey);
    toast(appId ? 'اپلیکیشن به‌روز شد.' : 'اپلیکیشن ساخته شد؛ کلید ارسال فقط همین‌بار نمایش داده می‌شود.');
    await handleLoad(async () => renderStatus(await api('/api/admin/status')));
  } catch (error) { if (!error.stale) showError('#application-form-error', error.message); }
  finally { busy(button, false); lockFields($('#application-form'), false); $('#rotate-application-key').disabled = false; }
});
$('#rotate-application-key').addEventListener('click', async () => {
  const tenantId = state.editApplicationTenantId, appId = state.editApplicationId, version = state.editApplicationVersion;
  if (!appId) return;
  const button = $('#rotate-application-key'); busy(button, true); $('#save-application').disabled = true; lockFields($('#application-form'), true); showError('#application-form-error', '');
  try {
    const result = await api(tenantPath(`applications/${encodeURIComponent(appId)}/rotate-key`, tenantId), { method: 'POST', body: JSON.stringify({ expectedVersion: version }) });
    updateApplication(result.application); $('#application-dialog').close(); revealApplicationKey(result.application, result.apiKey); toast('کلید قبلی باطل و کلید جدید ساخته شد.');
    await handleLoad(async () => renderStatus(await api('/api/admin/status')));
  } catch (error) { if (!error.stale) showError('#application-form-error', error.message); }
  finally { busy(button, false); $('#save-application').disabled = false; lockFields($('#application-form'), false); }
});
$('#tenant-key-dialog').addEventListener('close', () => { $('#tenant-send-key').value = ''; text('#tenant-key-owner', ''); });
$('#copy-tenant-key').addEventListener('click', async () => { const key = $('#tenant-send-key').value; if (!key) return; try { await navigator.clipboard.writeText(key); toast('کلید اپلیکیشن کپی شد. آن را در محل امن سرویس ذخیره کنید.'); } catch { toast('کپی خودکار در دسترس نیست؛ کلید را انتخاب و کپی کنید.', true); } });
$('#application-filter').addEventListener('change', () => { state.notificationPage = 1; handleLoad(() => loadNotifications()); });
$('#select-all-subscribers').addEventListener('change', event => {
  state.selectedSubscribers.clear();
  if (event.target.checked) state.subscribers.slice(0, 100).forEach(subscriber => state.selectedSubscribers.add(String(subscriber.chatId)));
  $$('.subscriber-selection').forEach(input => { input.checked = state.selectedSubscribers.has(input.value); }); updateSubscriberSelection();
});
$('#ban-selected').addEventListener('click', () => setSubscriberBan([...state.selectedSubscribers], true));
$('#unban-selected').addEventListener('click', () => setSubscriberBan([...state.selectedSubscribers], false));

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#login-button'); busy(button, true); showError('#login-error', '');
  const apiKey = $('#api-key').value; $('#api-key').value = '';
  try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ apiKey }) }); await showApp(); }
  catch { showError('#login-error', LOGIN_FAILURE_MESSAGE); }
  finally { busy(button, false); $('#login-button span').textContent = 'ورود به داشبورد'; }
});
$('#logout').addEventListener('click', async () => {
  const button = $('#logout'); busy(button, true);
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); showAuth(); toast('با موفقیت خارج شدید.'); }
  catch (error) { if (!error.stale) toast(error.message, true); }
  finally { busy(button, false); }
});
$$('[data-tab]').forEach(button => button.addEventListener('click', () => changeTab(button.dataset.tab)));
$('.nav-tabs').addEventListener('keydown', event => {
  const tabs = $$('[data-tab]'); const index = tabs.indexOf(document.activeElement); if (index < 0) return;
  let target;
  if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') target = (index + 1) % tabs.length;
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') target = (index - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') target = 0; if (event.key === 'End') target = tabs.length - 1;
  if (target !== undefined) { event.preventDefault(); changeTab(tabs[target].dataset.tab, true); }
});
$$('[data-open-settings]').forEach(button => button.addEventListener('click', () => changeTab('settings')));
$$('[data-go-history]').forEach(button => button.addEventListener('click', () => changeTab('notifications')));
$$('[data-compose]').forEach(button => button.addEventListener('click', openComposer));
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); }));
$('#refresh').addEventListener('click', () => state.tab === 'login-audit' ? handleLoad(() => loadLoginAudit(true)) : state.tenantId ? refresh({ manual: true }) : handleLoad(loadTenants));
$('#reload-login-audit').addEventListener('click', () => handleLoad(() => loadLoginAudit(true)));
$('#login-audit-outcome').addEventListener('change', () => handleLoad(() => loadLoginAudit(true)));
$('#login-audit-search').addEventListener('input', () => { clearTimeout(auditSearchTimer); auditSearchTimer = setTimeout(() => { if (state.authenticated) handleLoad(() => loadLoginAudit(true)); }, 350); });
$('#notification-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.notificationPage = 1; handleLoad(() => loadNotifications()); }, 350); });
$('#level-filter').addEventListener('change', () => { state.notificationPage = 1; handleLoad(() => loadNotifications()); });
$('#countries').addEventListener('input', renderCountries);
$('#settings-form').addEventListener('input', () => { state.settingsDirty = true; text('#settings-save-status', 'تغییرات ذخیره‌نشده دارید.'); });
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.settings) { toast('ابتدا تنظیمات را از سرور دریافت کنید.', true); return; }
  const form = new FormData(event.currentTarget);
  const countries = [...new Set(String(form.get('countries')).toUpperCase().split(/[\s,،;]+/).filter(Boolean))];
  if (countries.some(code => !/^[A-Z]{2}$/.test(code))) { toast('کد هر کشور باید دو حرف انگلیسی باشد؛ مانند IR.', true); $('#countries').focus(); return; }
  const settings = { projectName: String(form.get('projectName')).trim(), retentionDays: Number(form.get('retentionDays')), deliveryPerSecond: Number(form.get('deliveryPerSecond')), welcomeMessage: String(form.get('welcomeMessage')), paused: form.has('paused'), ipMode: form.get('ipMode'), ipRules: String(form.get('ipRules')).split(/\r?\n/).map(value => value.trim()).filter(Boolean), countryMode: form.get('countryMode'), countries, showCountryFlag: form.has('showCountryFlag') };
  const buttons = [$('#save-settings'), ...$$('button[type=submit]', $('#settings-form'))]; buttons.forEach(button => busy(button, true));
  lockFields(event.currentTarget, true);
  try { const saved = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings) }); renderSettings(saved); toast('تنظیمات ذخیره و اعمال شد.'); text('#settings-save-status', `ذخیره شد در ${timeFormatter.format(new Date())}`); }
  catch (error) { if (!error.stale) { toast(error.message, true); text('#settings-save-status', 'ذخیره انجام نشد؛ تغییرات شما در فرم باقی مانده‌اند.'); } }
  finally { buttons.forEach(button => busy(button, false)); lockFields($('#settings-form'), false); }
});
$('#register-webhook').addEventListener('click', async () => {
  const button = $('#register-webhook'); busy(button, true);
  try { await api('/api/admin/webhook', { method: 'POST', body: '{}' }); renderStatus(await api('/api/admin/status')); toast('وب‌هوک بات ثبت شد.'); }
  catch (error) { if (!error.stale) toast(error.message, true); }
  finally { busy(button, false); }
});
$('#compose-form').addEventListener('input', () => { state.composeKey = null; state.composeBody = null; });
$('#compose-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.currentTarget); const button = $('#compose-submit');
  const input = { applicationId: String(form.get('applicationId') || ''), event: String(form.get('event')).trim(), level: form.get('level'), text: String(form.get('text')), silent: form.has('silent') };
  for (const key of ['environment', 'title', 'image', 'url']) { const value = String(form.get(key) || '').trim(); if (value) input[key] = value; }
  for (const key of ['image', 'url']) { if (input[key] && !safeExternalLink(input[key], '')) { showError('#compose-error', 'آدرس تصویر و لینک جزئیات باید یک آدرس معتبر HTTPS باشد.'); return; } }
  if (!state.composeKey) { state.composeKey = crypto.randomUUID(); state.composeBody = JSON.stringify({ ...input, timestamp: new Date().toISOString() }); }
  busy(button, true); showError('#compose-error', '');
  lockFields(event.currentTarget, true);
  try {
    const result = await api('/api/admin/notifications', { method: 'POST', headers: { 'Idempotency-Key': state.composeKey }, body: state.composeBody });
    $('#compose-dialog').close(); $('#compose-form').reset(); state.composeKey = null; state.composeBody = null;
    toast(result.notification.status === 'empty' ? 'اعلان ثبت شد؛ مشترک فعالی برای ارسال وجود ندارد.' : result.duplicate ? 'این اعلان قبلاً ثبت شده است؛ ارسال تکراری ایجاد نشد.' : 'اعلان در صف ارسال به مشترکان ثبت شد.');
    await refresh({ manual: false });
  } catch (error) { if (!error.stale) showError('#compose-error', error.message); }
  finally { busy(button, false); lockFields($('#compose-form'), false); }
});
let curlExample = '';
let statusExample = '';
function updateApiExample() {
  const tenant = selectedTenant();
  text('#api-tenant-name', tenant?.name || 'یک فضا انتخاب کنید');
  text('#api-tenant-id', tenant?.id || '—');
  const status = $('#api-tenant-status');
  status.className = `badge ${tenant ? tenant.enabled ? 'success' : 'warning' : 'neutral'}`;
  status.textContent = tenant ? tenant.enabled ? 'فعال' : 'غیرفعال' : '—';
  text('#api-tenant-description', tenant ? tenant.botUsername ? `اعلان‌های این فضا به بات @${tenant.botUsername} و مخاطبان واجد شرایط آن می‌رسند.` : tenant.botConfigured ? 'توکن بات این فضا ذخیره شده است؛ وضعیت اتصال و وب‌هوک را در تنظیمات بررسی کنید.' : 'ابتدا بات این فضا را از بخش تنظیمات متصل کنید.' : 'هر فضا بات، اپلیکیشن‌ها و مخاطبان خودش را دارد.');
  const active = state.applications.filter(application => application.enabled && application.keyConfigured);
  text('#api-application-context', !tenant ? 'برای دریافت راهنمای اختصاصی، یک Tenant انتخاب کنید.' : !tenant.enabled ? 'این Tenant غیرفعال است و درخواست ارسال آن پذیرفته نمی‌شود. از مدیریت فضاها آن را فعال کنید.' : !applicationsLoaded ? 'در حال دریافت اپلیکیشن‌های همین فضا…' : active.length ? `${count(active.length)} اپلیکیشن فعال با کلید ارسال در این فضا دارید. کلید اپلیکیشن فرستنده را در نمونه جایگزین کنید.` : 'این فضا هنوز اپلیکیشن فعال با کلید ارسال ندارد. از «اپلیکیشن‌ها و کلیدها» یک اپلیکیشن بسازید یا کلید آن را دریافت کنید.');
  $('#api-tenant-limits').replaceChildren(...(tenant ? [
    ['درخواست در دقیقه', tenant.limits.requestsPerMinute],
    ['اعلان در روز · UTC', tenant.limits.notificationsPerDay],
    ['مشترک فعال', tenant.limits.maxSubscribers],
    ['تحویل در انتظار', tenant.limits.maxPendingDeliveries],
  ].map(([label, value]) => node('span', 'badge neutral', `${label}: ${count(value)}`)) : []));
  $('#copy-example').disabled = !tenant;
  $('#copy-status-example').disabled = !tenant;
  if (!tenant) {
    curlExample = ''; statusExample = '';
    for (const id of ['#api-endpoint', '#api-status-endpoint']) text(id, '—');
    for (const id of ['#api-example', '#api-status-example']) text(id, 'ابتدا یک فضای اعلان انتخاب کنید.');
    return;
  }
  const endpoint = `${location.origin}/api/v1/tenants/${encodeURIComponent(tenant.id)}/notifications`;
  text('#api-endpoint', endpoint);
  text('#api-status-endpoint', `${endpoint}/{notificationId}`);
  curlExample = [
    "export APPLICATION_API_KEY='YOUR_APPLICATION_API_KEY'",
    "export EVENT_ID='deployment-123-completed'",
    '',
    `curl --fail-with-body '${endpoint}' \\`,
    '  --header "X-API-Key: $APPLICATION_API_KEY" \\',
    "  --header 'Content-Type: application/json' \\",
    '  --header "Idempotency-Key: $EVENT_ID" \\',
    `  --data '${JSON.stringify({
      event: 'deployment.completed',
      level: 'success',
      title: 'استقرار نسخهٔ جدید',
      text: 'نسخهٔ جدید با موفقیت در محیط اصلی مستقر شد.',
      environment: 'production',
      url: 'https://ci.example.com/pipelines/123',
      metadata: { version: '2.4.0', commit: 'a1b2c3d', duration: '42s' },
      tags: ['release', 'backend'],
    }, null, 2)}'`,
  ].join('\n');
  statusExample = [
    "export APPLICATION_API_KEY='YOUR_APPLICATION_API_KEY'",
    "export NOTIFICATION_ID='YOUR_NOTIFICATION_ID'",
    '',
    `curl --fail-with-body "${endpoint}/$NOTIFICATION_ID" \\`,
    '  --header "X-API-Key: $APPLICATION_API_KEY"',
  ].join('\n');
  text('#api-example', curlExample);
  text('#api-status-example', statusExample);
}
updateApiExample();
for (const [selector, getExample] of [['#copy-example', () => curlExample], ['#copy-status-example', () => statusExample]]) {
  $(selector).addEventListener('click', async () => {
    const example = getExample();
    if (!example) return;
    try { await navigator.clipboard.writeText(example); toast('نمونهٔ درخواست کپی شد.'); }
    catch { toast('کپی خودکار در دسترس نیست. متن نمونه را انتخاب و کپی کنید.', true); }
  });
}
$$('[data-api-tab]').forEach(button => button.addEventListener('click', () => changeTab(button.dataset.apiTab)));
window.addEventListener('hashchange', () => { if (state.authenticated) changeTab(location.hash.slice(1)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.authenticated) refresh(); });
window.setInterval(() => { if (!document.hidden && state.authenticated && ['overview', 'notifications', 'subscribers'].includes(state.tab)) refresh(); }, 30000);
(async () => {
  try { const session = await api('/api/admin/session'); if (session.authenticated) await showApp(); else showAuth(); }
  catch (error) { showAuth(); if (error.status !== 401) showError('#login-error', LOGIN_FAILURE_MESSAGE); }
})();
