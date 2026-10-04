'use strict';

window.RelayBots = (() => {
  let ui;
  const model = {page: 1, pickerPage: 1, request: 0, pickerRequest: 0, timer: null, pickerTimer: null, edit: null, original: '', saving: false, conflict: false, disable: null, pendingLeave: null};
  const $ = selector => ui.$(selector);
  const el = (tag, style, value) => ui.node(tag, style, value);
  const path = suffix => ui.tenantPath(`bots${suffix ? `/${suffix}` : ''}`);
  const token = () => ({epoch: ui.state.epoch, tenant: ui.state.tenantId});
  const current = stamp => ui.state.authenticated && stamp.epoch === ui.state.epoch && stamp.tenant === ui.state.tenantId;
  const run = work => Promise.resolve().then(work).catch(error => { if (!error.stale) ui.toast(error.message, true); });
  function button(text, action, style = 'button secondary small-button') {
    const target = el('button', style, text);
    target.type = 'button';
    target.addEventListener('click', action);
    return target;
  }
  function draft() {
    return JSON.stringify({name: $('#bot-editor-name').value, id: $('#bot-editor-id').value, token: $('#bot-editor-token').value, enabled: $('#bot-editor-enabled').checked});
  }
  function dirty() { return $('#bot-editor-dialog').open && draft() !== model.original; }
  function discardThen(action, reset = () => {}) {
    model.pendingLeave = () => { reset(); action(); };
    if (!$('#scope-discard-dialog').open) $('#scope-discard-dialog').showModal();
    return false;
  }
  function canLeave(action) {
    if (model.saving || ui.state.activeWrites) { ui.toast('منتظر پایان ذخیره بمانید.', true); return false; }
    if (dirty()) return discardThen(action, () => { model.original = draft(); $('#bot-editor-dialog').close(); });
    if (ui.state.settingsDirty) return discardThen(action, () => { ui.state.settingsDirty = false; if (ui.state.settings) ui.renderSettings(ui.state.settings); });
    return true;
  }
  function canClose(dialog) {
    if (dialog.id === 'bot-editor-dialog') {
      if (model.saving) return false;
      if (dirty()) return discardThen(() => dialog.close(), () => { model.original = draft(); });
    }
    if (dialog.id === 'bot-disable-dialog' && model.saving) return false;
    return true;
  }
  function renderScope() {
    const bot = ui.state.bot;
    $('#bot-scope-name').textContent = bot?.name || 'انتخاب بات';
    $('#bot-scope-button').disabled = !ui.state.tenantId || ui.state.activeWrites > 0;
    $('#bot-scope-button').title = bot ? `${bot.name} · ${bot.enabled ? 'فعال' : 'غیرفعال'}` : 'انتخاب بات';
    $('#bot-scope-dot').dataset.enabled = String(Boolean(bot?.enabled));
    const warning = $('#bot-scope-warning');
    warning.hidden = !bot || bot.enabled || ['login-audit', 'tenants'].includes(ui.state.tab);
    warning.replaceChildren();
    if (bot && !bot.enabled) {
      warning.append(ui.icon('alert'), el('span', '', `بات «${bot.name}» غیرفعال است. ارسال همهٔ اپلیکیشن‌های آن متوقف است؛ درخواست جدید با خطای BOT_DISABLED رد می‌شود.`), button('مدیریت بات', () => ui.changeTab('bots'), 'text-button'));
    }
  }
  async function selectBot(bot) {
    $('#bot-picker-dialog').close();
    await ui.switchBot(bot);
  }
  async function load({picker = false} = {}) {
    if (!ui.state.authenticated || !ui.state.tenantId) return;
    const stamp = token(), counter = picker ? ++model.pickerRequest : ++model.request;
    const prefix = picker ? 'bot-picker' : 'bots';
    const page = picker ? model.pickerPage : model.page;
    const search = $(`#${prefix}-search`).value.trim();
    ui.showError(`#${prefix}-error`, '');
    ui.loading($(`#${prefix}-list`));
    $(`#${prefix}-pagination`).replaceChildren();
    try {
      const query = new URLSearchParams({page: String(page)});
      if (search) query.set('search', search);
      const data = await ui.api(`${path('')}?${query}`);
      if (!current(stamp) || counter !== (picker ? model.pickerRequest : model.request)) return;
      const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
      if (page > lastPage) { if (picker) model.pickerPage = lastPage; else model.page = lastPage; return await load({picker}); }
      if (!picker) $('#bots-count').textContent = `${ui.count(data.total)} بات${search ? ' مطابق جست‌وجو' : ' در این فضا'} · ${ui.selectedTenant()?.name || ''}`;
      const list = $(`#${prefix}-list`);
      list.replaceChildren();
      if (!data.items.length) {
        ui.empty(list, search ? 'باتی پیدا نشد' : 'مسیر بعدی را بسازید', search ? 'نام یا شناسهٔ دیگری را جست‌وجو کنید.' : 'یک بات تلگرام اضافه کنید و اپلیکیشن‌ها را به آن متصل کنید.', !search && !picker ? {label: 'افزودن بات', run: () => openEditor()} : null);
      } else for (const bot of data.items) list.append(picker ? pickerItem(bot) : card(bot));
      ui.renderPagination($(`#${prefix}-pagination`), data, next => { if (picker) model.pickerPage = next; else model.page = next; run(() => load({picker})); });
    } catch (error) {
      if (!current(stamp) || error.stale || counter !== (picker ? model.pickerRequest : model.request)) return;
      $(`#${prefix}-list`).replaceChildren();
      ui.showError(`#${prefix}-error`, error.message);
    }
  }
  function identity(bot) {
    const identity = el('div', 'bot-identity');
    const avatar = el('span', 'bot-avatar'); avatar.append(ui.icon('relay'));
    const copy = el('div', 'bot-identity-copy');
    copy.append(el('strong', '', bot.name));
    const subtitle = el('small', '', bot.username ? `@${bot.username}` : bot.id); subtitle.dir = 'ltr';
    copy.append(subtitle); identity.append(avatar, copy); return identity;
  }
  function pickerItem(bot) {
    const item = button('', () => run(() => selectBot(bot)), 'bot-picker-item');
    const selected = bot.id === ui.state.botId;
    item.setAttribute('aria-label', `انتخاب ${bot.name}${bot.enabled ? '' : '، غیرفعال'}`);
    item.setAttribute('aria-pressed', String(selected));
    item.append(identity(bot), el('span', `badge ${bot.enabled ? 'success' : 'warning'}`, bot.enabled ? 'فعال' : 'غیرفعال'));
    if (selected) item.append(ui.icon('check'));
    return item;
  }
  function card(bot) {
    const item = el('article', 'bot-card');
    item.dataset.enabled = String(bot.enabled);
    const head = el('div', 'bot-card-head');
    head.append(identity(bot), el('span', `badge ${bot.enabled ? bot.configured ? 'success' : 'neutral' : 'warning'}`, bot.enabled ? bot.configured ? 'فعال' : 'منتظر اتصال' : 'غیرفعال'));
    const meta = el('div', 'bot-card-meta');
    const code = el('code', '', bot.id); code.dir = 'ltr';
    meta.append(code, el('span', '', `${ui.count(bot.applicationCount ?? 0)} اپلیکیشن`));
    const body = el('p', 'bot-card-description', !bot.enabled ? 'ارسال همهٔ اپلیکیشن‌های این بات متوقف است.' : bot.configured ? 'مخاطبان و قوانین ارسال این بات مستقل هستند.' : 'توکن بات را ثبت کنید تا اتصال تکمیل شود.');
    const actions = el('div', 'bot-card-actions');
    actions.append(button(bot.id === ui.state.botId ? 'بات انتخاب‌شده' : 'باز کردن فضای بات', () => run(() => selectBot(bot)), bot.id === ui.state.botId ? 'button secondary small-button bot-selected' : 'button secondary small-button'));
    const edit = button('مدیریت', () => openEditor(bot), 'text-button');
    const toggle = button(bot.enabled ? 'غیرفعال‌کردن' : 'فعال‌کردن', () => bot.enabled ? confirmDisable(bot) : run(() => setEnabled(bot, true)), `text-button bot-toggle${bot.enabled ? '' : ' enable'}`);
    toggle.disabled = ui.state.activeWrites > 0;
    actions.append(edit, toggle);
    item.append(head, meta, body, actions);
    return item;
  }
  async function openPicker() {
    if (!ui.state.tenantId) return;
    model.pickerPage = 1; $('#bot-picker-search').value = '';
    $('#bot-picker-dialog').showModal();
    await load({picker: true});
    if ($('#bot-picker-dialog').open) $('#bot-picker-search').focus();
  }
  function openEditor(bot = null) {
    if (ui.state.activeWrites || !ui.state.tenantId) return;
    model.edit = bot ? {...bot} : null; model.conflict = false;
    $('#bot-editor-form').reset();
    $('#bot-editor-heading').textContent = bot ? 'مدیریت بات' : 'افزودن بات تلگرام';
    $('#bot-editor-context').textContent = `فضای اعلان: ${ui.selectedTenant()?.name || ui.state.tenantId}`;
    $('#bot-editor-name').value = bot?.name || '';
    $('#bot-editor-id').value = bot?.id || '';
    $('#bot-editor-id').readOnly = Boolean(bot);
    $('#bot-editor-id').required = !bot;
    $('#bot-editor-token').required = !bot;
    $('#bot-editor-token-note').textContent = bot ? 'برای حفظ توکن فعلی خالی بگذارید. توکن جدید باید متعلق به همین بات تلگرام باشد.' : 'توکن بررسی می‌شود و پس از ذخیره نمایش داده نخواهد شد.';
    $('#bot-editor-enabled-row').hidden = !bot;
    $('#bot-editor-enabled').checked = bot ? bot.enabled : true;
    $('#bot-editor-warning').hidden = !bot || bot.enabled;
    $('#save-bot').textContent = bot ? 'ذخیرهٔ تغییرات' : 'بررسی و افزودن بات';
    $('#save-bot').disabled = false;
    $('#bot-editor-reload').hidden = true;
    ui.showError('#bot-editor-error', '');
    model.original = draft();
    if (!$('#bot-editor-dialog').open) $('#bot-editor-dialog').showModal();
  }
  function lock(locked) {
    model.saving = locked;
    for (const control of document.querySelectorAll('#bot-editor-form input, #bot-editor-dialog button, #bot-disable-dialog button')) control.disabled = locked;
    if (!locked && model.conflict) $('#save-bot').disabled = true;
  }
  async function afterChange(bot) {
    if (ui.state.botId === bot.id) { ui.state.bot = bot; renderScope(); ui.updateApiExample(); if (ui.state.status) ui.renderStatus(ui.state.status); }
    if (ui.state.tab === 'bots') await load();
  }
  async function save(event) {
    event.preventDefault();
    if (model.saving || model.conflict) return;
    const stamp = token(), originalBot = model.edit;
    const secret = $('#bot-editor-token').value.trim();
    const data = {name: $('#bot-editor-name').value.trim(), ...(originalBot ? {enabled: $('#bot-editor-enabled').checked, expectedVersion: originalBot.version} : {id: $('#bot-editor-id').value.trim()})};
    if (secret) data.botToken = secret;
    $('#bot-editor-token').value = '';
    lock(true); ui.showError('#bot-editor-error', '');
    try {
      const result = await ui.api(path(originalBot ? encodeURIComponent(originalBot.id) : ''), {method: originalBot ? 'PATCH' : 'POST', body: JSON.stringify(data)});
      if (!current(stamp)) return;
      model.original = draft(); $('#bot-editor-dialog').close();
      await afterChange(result.bot);
      ui.renderApplications();
      if (!originalBot) { lock(false); await ui.switchBot(result.bot); ui.changeTab('settings'); }
      ui.toast(originalBot ? 'تنظیمات بات ذخیره شد.' : 'بات اضافه شد. اکنون وب‌هوک این بات را ثبت کنید.');
    } catch (error) {
      if (!current(stamp) || error.stale) return;
      model.conflict = error.code === 'STALE_BOT' || error.code === 'VERSION_CONFLICT';
      $('#bot-editor-reload').hidden = !model.conflict;
      ui.showError('#bot-editor-error', model.conflict ? 'این بات هم‌زمان تغییر کرده است. نسخهٔ تازه را دریافت کنید و تغییرات را دوباره اعمال کنید.' : error.message);
    } finally { lock(false); }
  }
  function confirmDisable(bot) {
    model.disable = bot;
    $('#bot-disable-confirm').disabled = false;
    $('#bot-disable-detail').textContent = `بات «${bot.name}» و ارسال ${ui.count(bot.applicationCount ?? 0)} اپلیکیشن متصل به آن غیرفعال می‌شود.`;
    ui.showError('#bot-disable-error', '');
    $('#bot-disable-dialog').showModal();
  }
  async function setEnabled(bot, enabled) {
    const stamp = token(); lock(true);
    ui.showError('#bot-disable-error', '');
    try {
      const {bot: updated} = await ui.api(path(encodeURIComponent(bot.id)), {method: 'PATCH', body: JSON.stringify({enabled, expectedVersion: bot.version})});
      if (!current(stamp)) return;
      $('#bot-disable-dialog').close(); model.disable = null;
      await afterChange(updated);
      ui.renderApplications();
      ui.toast(enabled ? 'بات فعال شد.' : 'بات غیرفعال شد؛ ارسال اپلیکیشن‌های آن متوقف است.');
    } catch (error) {
      if (!current(stamp) || error.stale) return;
      if (!enabled) ui.showError('#bot-disable-error', error.message); else ui.toast(error.message, true);
      if (error.code === 'STALE_BOT') { model.disable = null; $('#bot-disable-confirm').disabled = true; await load(); }
    } finally { lock(false); $('#bot-disable-confirm').disabled = !model.disable; }
  }
  function clear() {
    model.request++; model.pickerRequest++; model.page = 1; model.pickerPage = 1;
    clearTimeout(model.timer); clearTimeout(model.pickerTimer);
    model.edit = null; model.original = ''; model.conflict = false; model.disable = null; model.pendingLeave = null;
    for (const id of ['bots-list', 'bots-pagination', 'bot-picker-list', 'bot-picker-pagination']) $(`#${id}`).replaceChildren();
    $('#bots-search').value = ''; $('#bot-picker-search').value = ''; $('#bot-editor-token').value = '';
    renderScope();
  }
  function init(context) {
    ui = context;
    $('#bot-scope-button').addEventListener('click', () => run(openPicker));
    $('#create-bot').addEventListener('click', () => openEditor());
    $('#reload-bots').addEventListener('click', () => run(() => load()));
    $('#bot-picker-manage').addEventListener('click', () => { $('#bot-picker-dialog').close(); ui.changeTab('bots'); });
    $('#bots-search').addEventListener('input', () => { clearTimeout(model.timer); model.timer = setTimeout(() => { model.page = 1; run(() => load()); }, 300); });
    $('#bot-picker-search').addEventListener('input', () => { clearTimeout(model.pickerTimer); model.pickerTimer = setTimeout(() => { model.pickerPage = 1; run(() => load({picker: true})); }, 300); });
    $('#bot-editor-form').addEventListener('submit', save);
    $('#bot-editor-enabled').addEventListener('change', () => { $('#bot-editor-warning').hidden = $('#bot-editor-enabled').checked; });
    $('#bot-editor-reload').addEventListener('click', () => {
      if (!model.edit) return;
      const id = model.edit.id;
      discardThen(() => run(async () => { const {bot} = await ui.api(path(encodeURIComponent(id))); openEditor(bot); }));
    });
    $('#bot-disable-confirm').addEventListener('click', () => { if (model.disable) run(() => setEnabled(model.disable, false)); });
    $('#bot-disable-cancel').addEventListener('click', () => { if (!model.saving) $('#bot-disable-dialog').close(); });
    $('#scope-discard-cancel').addEventListener('click', () => { model.pendingLeave = null; $('#scope-discard-dialog').close(); });
    $('#scope-discard-confirm').addEventListener('click', () => { const action = model.pendingLeave; model.pendingLeave = null; $('#scope-discard-dialog').close(); if (action) action(); });
    for (const id of ['bot-editor-dialog', 'bot-disable-dialog']) $(`#${id}`).addEventListener('cancel', event => { if (!canClose(event.target)) event.preventDefault(); });
    $('#bot-editor-dialog').addEventListener('close', () => { $('#bot-editor-token').value = ''; model.edit = null; model.original = ''; });
    $('#bot-picker-dialog').addEventListener('close', () => { model.pickerRequest++; clearTimeout(model.pickerTimer); });
    window.addEventListener('beforeunload', event => { if (dirty() || model.saving || ui.state.settingsDirty) { event.preventDefault(); event.returnValue = ''; } });
  }
  return {init, load, clear, renderScope, canLeave, canClose, openEditor, afterChange};
})();
