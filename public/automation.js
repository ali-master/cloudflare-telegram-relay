'use strict';

window.RelayAutomation = (() => {
  let ui;
  const levels = ['info', 'success', 'warning', 'error', 'critical'];
  const levelNames = {info: 'Info', success: 'Success', warning: 'Warning', error: 'Error', critical: 'Critical'};
  const statuses = {open: 'باز', acknowledged: 'در حال رسیدگی', snoozed: 'تعویق‌یافته', resolved: 'رفع‌شده'};
  const tones = {open: 'warning', acknowledged: 'info', snoozed: 'neutral', resolved: 'success'};
  const modes = {immediate: 'ارسال فوری', digest: 'خلاصهٔ دوره‌ای', mute: 'ارسال نمی‌شود', defer: 'پس از ساعت سکوت'};
  const model = {
    applications: null, applicationsPromise: null, applicationsRequest: 0, names: new Map(), namesPromise: null, namesLoaded: false, scope: '', policy: null, original: '',
    inherited: false, dirty: false, saving: false, conflict: false, policyRequest: 0,
    incidentsRequest: 0, incidentPage: 1, incidentStatus: '', incidentDetailRequest: 0, incident: null, incidentSaving: false,
    peopleRequest: 0, peoplePage: 1, peopleMode: '', peopleTimer: null,
    preferencesRequest: 0, preferences: null, chatId: null, preferencesOriginal: '', preferencesDirty: false, preferencesSaving: false, preferencesConflict: false,
    previewRequest: 0, pendingLeave: null
  };
  const $ = selector => ui.$(selector);
  const el = (tag, style, text) => ui.node(tag, style, text);
  const number = value => ui.count(value);
  const message = (selector, text) => ui.showError(selector, text);
  const stamp = () => ({epoch: ui.state.epoch, tenant: ui.state.tenantId});
  const current = token => ui.state.authenticated && token.epoch === ui.state.epoch && token.tenant === ui.state.tenantId;
  const path = suffix => ui.tenantPath(suffix);
  const clone = value => JSON.parse(JSON.stringify(value));
  const split = value => [...new Set(value.split(/[,،\n]/).map(item => item.trim()).filter(Boolean))];
  const date = value => value == null ? '—' : ui.dateText(typeof value === 'number' && value < 100000000000 ? value * 1000 : value);
  const run = work => Promise.resolve().then(work).catch(error => { if (!error.stale) ui.toast(error.message, true); });
  const label = (text, tone = 'neutral') => el('span', `badge ${tone}`, text);
  function button(text, action, style = 'button secondary small-button') {
    const item = el('button', style, text);
    item.type = 'button';
    item.addEventListener('click', action);
    return item;
  }
  function field(title, input) {
    const wrap = el('div', 'field');
    const caption = el('label', '', title);
    if (input.id) caption.htmlFor = input.id;
    wrap.append(caption, input);
    return wrap;
  }
  function input(id, value, type = 'text', attributes = {}) {
    const result = el('input');
    result.id = id;
    result.type = type;
    result.value = value;
    Object.assign(result, attributes);
    return result;
  }
  function select(id, options, value) {
    const result = el('select');
    result.id = id;
    for (const [key, title] of options) {
      const option = el('option', '', title);
      option.value = key;
      result.append(option);
    }
    result.value = value;
    return result;
  }
  function setOptions(selector, items, placeholder, selected) {
    const target = $(selector);
    const value = selected ?? target.value;
    const options = [];
    if (placeholder != null) {
      const option = el('option', '', placeholder);
      option.value = '';
      options.push(option);
    }
    for (const item of items) {
      const option = el('option', '', item.name);
      option.value = item.id;
      options.push(option);
    }
    target.replaceChildren(...options);
    target.value = options.some(option => option.value === value) ? value : options[0]?.value || '';
    ui.syncSelects();
  }
  function lock(container, locked) {
    for (const item of container.querySelectorAll('input,select,textarea,button')) {
      if (locked) {
        item.dataset.autoWasDisabled = item.disabled ? '1' : '0';
        item.disabled = true;
      } else if (item.dataset.autoWasDisabled != null) {
        item.disabled = item.dataset.autoWasDisabled === '1';
        delete item.dataset.autoWasDisabled;
      }
    }
    container.setAttribute('aria-busy', String(locked));
    ui.syncSelects();
  }
  async function applications() {
    if (model.applications) return model.applications;
    if (model.applicationsPromise) return model.applicationsPromise;
    const token = stamp();
    const request = ++model.applicationsRequest;
    const pending = ui.api(path('applications')).then(result => {
      if (!current(token) || request !== model.applicationsRequest) return [];
      model.applications = result.items || result.applications || [];
      return model.applications;
    });
    model.applicationsPromise = pending;
    try { return await pending; }
    finally { if (model.applicationsPromise === pending) model.applicationsPromise = null; }
  }
  function rememberNames(items) {
    for (const person of items) {
      const id = String(person.chatId);
      model.names.set(id, person.displayName || person.firstName || person.username || `مشترک ${id}`);
    }
  }
  async function initialPeopleNames() {
    rememberNames(ui.state.subscribers);
    if (model.namesLoaded) return;
    if (model.namesPromise) return model.namesPromise;
    const token = stamp();
    const pending = ui.api(path('subscribers?page=1')).then(result => {
      if (!current(token)) return;
      rememberNames(result.items);
      model.namesLoaded = true;
    }).catch(() => {
      // A display-name lookup must not prevent editing otherwise available policies.
    });
    model.namesPromise = pending;
    try { await pending; }
    finally { if (model.namesPromise === pending) model.namesPromise = null; }
  }
  function discardThen(action, subject = 'policy') {
    model.pendingLeave = () => {
      if (subject === 'preferences') model.preferencesDirty = false;
      else {
        model.dirty = false;
        if (model.original) model.policy = JSON.parse(model.original);
      }
      action();
    };
    if (!$('#auto-discard-dialog').open) $('#auto-discard-dialog').showModal();
  }
  function canLeave(action) {
    if (model.saving || model.preferencesSaving || model.incidentSaving) {
      ui.toast('تا پایان ذخیره، در همین بخش بمانید.', true);
      return false;
    }
    if (!model.dirty) return true;
    history.replaceState(null, '', `#${ui.state.tab}`);
    discardThen(action);
    return false;
  }
  function canClose(dialog) {
    if (dialog.id === 'incident-dialog') return !model.incidentSaving;
    if (dialog.id !== 'delivery-preferences-dialog') return true;
    if (model.preferencesSaving) return false;
    if (!model.preferencesDirty) return true;
    discardThen(() => dialog.close(), 'preferences');
    return false;
  }
  function clear() {
    if (!ui) return;
    for (const key of ['applicationsRequest', 'policyRequest', 'incidentsRequest', 'incidentDetailRequest', 'peopleRequest', 'preferencesRequest', 'previewRequest']) model[key]++;
    model.applications = null;
    model.applicationsPromise = null;
    model.names.clear();
    model.namesPromise = null;
    model.namesLoaded = false;
    model.scope = '';
    model.policy = model.preferences = model.incident = null;
    model.original = model.preferencesOriginal = '';
    model.dirty = model.conflict = model.preferencesDirty = model.preferencesConflict = false;
    model.incidentPage = model.peoplePage = 1;
    model.incidentStatus = '';
    model.chatId = null;
    model.pendingLeave = null;
    clearTimeout(model.peopleTimer);
    $('#automation-content').hidden = true;
    $('#automation-reset').hidden = true;
    $('#auto-preview-result').hidden = true;
    $('#delivery-preferences-form').hidden = true;
    $('#auto-people-search').value = '';
    $('#auto-preview-chat').value = '';
    for (const id of ['#incident-list', '#incident-stats', '#incident-pagination', '#incident-detail', '#auto-rules', '#auto-responders', '#auto-escalation-targets', '#auto-people-list', '#auto-people-pagination']) $(id).replaceChildren();
    for (const id of ['#automation-error', '#incidents-error', '#auto-preview-error', '#delivery-preferences-error', '#incident-action-error']) message(id, '');
    setOptions('#automation-scope', [], 'پیش‌فرض تمام اپلیکیشن‌های فضا', '');
    setOptions('#incident-app-filter', [], 'همهٔ اپلیکیشن‌ها', '');
    setOptions('#auto-preview-app', [], 'اپلیکیشنی ثبت نشده', '');
    renderStatusFilters();
  }
  async function activate(tab) {
    if (!ui.state.authenticated || !ui.state.tenantId) return;
    if (tab === 'incidents') await loadIncidents();
    if (tab === 'automation' && !model.dirty && !model.saving) await loadPolicy();
  }
  function renderStatusFilters() {
    for (const item of document.querySelectorAll('[data-incident-status]')) item.setAttribute('aria-pressed', String(item.dataset.incidentStatus === model.incidentStatus));
  }
  function renderStats(stats) {
    const values = [
      ['در انتظار رسیدگی', stats.open, `${number(stats.snoozed)} رخداد در تعویق`, 'alert', 'warning'],
      ['در حال رسیدگی', stats.acknowledged, stats.averageAckSeconds == null ? 'هنوز زمان پاسخ ثبت نشده' : `میانگین پذیرش: ${number(Math.round(stats.averageAckSeconds / 60))} دقیقه`, 'users', 'info'],
      ['رخدادهای رفع‌شده', stats.resolved, `${number(stats.escalations)} مرحلهٔ پیگیری ثبت شده`, 'check', 'success'],
      ['کل تکرارها', stats.totalOccurrences, 'همهٔ رخدادهای همین فضا', 'activity', 'neutral']
    ];
    $('#incident-stats').replaceChildren(...values.map(([title, value, note, icon, tone]) => {
      const card = el('div', 'auto-stat');
      card.dataset.tone = tone;
      const head = el('div', 'auto-stat-top');
      head.append(el('span', '', title), ui.icon(icon));
      card.append(head, el('strong', '', value == null ? '—' : number(value)), el('small', '', note));
      return card;
    }));
  }
  async function loadIncidents(showLoading = true) {
    const token = stamp();
    const request = ++model.incidentsRequest;
    message('#incidents-error', '');
    if (showLoading) ui.loading($('#incident-list'), 'در حال دریافت مسیر رخدادها');
    try {
      const query = new URLSearchParams({page: String(model.incidentPage)});
      if (model.incidentStatus) query.set('status', model.incidentStatus);
      if ($('#incident-app-filter').value) query.set('applicationId', $('#incident-app-filter').value);
      const [page, stats, apps] = await Promise.all([ui.api(path(`incidents?${query}`)), ui.api(path('incidents/overview')), applications()]);
      if (!current(token) || request !== model.incidentsRequest) return;
      setOptions('#incident-app-filter', apps, 'همهٔ اپلیکیشن‌ها');
      renderStats(stats);
      if (!page.items.length && model.incidentPage > 1 && page.total > 0) {
        model.incidentPage = Math.max(1, Math.ceil(page.total / page.pageSize));
        return loadIncidents(showLoading);
      }
      const list = $('#incident-list');
      list.replaceChildren();
      if (!page.items.length) ui.empty(list, model.incidentStatus ? 'رخدادی با این وضعیت وجود ندارد' : 'همه‌چیز آرام است', 'با ورود نخستین رخداد، تعداد تکرارها و مسیر رسیدگی را همین‌جا می‌بینید.');
      for (const item of page.items) {
        const card = el('article', 'incident-card');
        card.dataset.level = levels.includes(item.level) ? item.level : 'info';
        const content = el('div');
        const heading = el('div', 'incident-title');
        const title = el('strong', '', item.title || item.event);
        title.dir = 'auto';
        heading.append(title, label(levelNames[item.level] || item.level, item.level), label(statuses[item.status] || item.status, tones[item.status] || 'neutral'));
        const meta = el('div', 'incident-meta');
        for (const value of [item.application, item.event, item.environment || 'بدون محیط']) {
          const span = el('code', '', value); span.dir = 'auto'; meta.append(span);
        }
        meta.append(el('span', '', `آخرین رخداد: ${date(item.lastSeenAt)}`));
        if (item.assigneeChatId) meta.append(el('span', '', `مسئول: ${model.names.get(String(item.assigneeChatId)) || item.assigneeChatId}`));
        else if (item.status === 'acknowledged') meta.append(el('span', '', 'پذیرفته‌شده در داشبورد'));
        content.append(heading, meta);
        const side = el('div', 'incident-side');
        side.append(el('span', 'incident-repeats', `${number(item.occurrences)} بار رخ داده`), button('مشاهده و رسیدگی ←', () => run(() => openIncident(item.id))));
        card.append(el('span', 'incident-rail'), content, side);
        list.append(card);
      }
      ui.renderPagination($('#incident-pagination'), page, pageNumber => { model.incidentPage = pageNumber; run(loadIncidents); });
    } catch (error) {
      if (!current(token) || request !== model.incidentsRequest || error.stale) return;
      message('#incidents-error', error.message);
      if (showLoading) ui.empty($('#incident-list'), 'رخدادها دریافت نشدند', 'اتصال را بررسی کنید و دوباره تلاش کنید.', {label: 'تلاش دوباره', run: () => run(loadIncidents)});
    }
  }
  async function openIncident(id, afterAction = false) {
    if (model.incidentSaving && !afterAction) return;
    const token = stamp();
    const request = ++model.incidentDetailRequest;
    model.incident = null;
    message('#incident-action-error', '');
    ui.loading($('#incident-detail'), 'در حال دریافت جزئیات رخداد');
    if (!$('#incident-dialog').open) $('#incident-dialog').showModal();
    try {
      const result = await ui.api(path(`incidents/${encodeURIComponent(id)}`));
      if (!current(token) || request !== model.incidentDetailRequest || !$('#incident-dialog').open) return;
      model.incident = result.incident;
      renderIncidentDetail(result);
    } catch (error) {
      if (!current(token) || request !== model.incidentDetailRequest || error.stale) return;
      ui.empty($('#incident-detail'), 'جزئیات دریافت نشد', error.message, {label: 'تلاش دوباره', run: () => run(() => openIncident(id))});
    }
  }
  function renderIncidentDetail({incident, timeline}) {
    const container = $('#incident-detail');
    const heading = el('div');
    const tags = el('div', 'detail-tags');
    tags.append(label(levelNames[incident.level] || incident.level, incident.level), label(statuses[incident.status] || incident.status, tones[incident.status]));
    const title = el('h3', '', incident.title || incident.event); title.dir = 'auto';
    const subtitle = el('p', '', `${incident.application} · ${incident.event} · ${incident.environment || 'بدون محیط'}`); subtitle.dir = 'auto';
    heading.append(tags, title, subtitle);
    const metrics = el('div', 'incident-detail-metrics');
    for (const [key, value] of [['تعداد رخداد', number(incident.occurrences)], ['نخستین رخداد', date(incident.firstSeenAt)], ['آخرین رخداد', date(incident.lastSeenAt)]]) {
      const cell = el('div', 'incident-detail-metric'); cell.append(el('small', '', key), el('strong', '', value)); metrics.append(cell);
    }
    container.replaceChildren(heading, metrics);
    const details = el('div', 'incident-meta');
    details.append(el('span', '', incident.assigneeChatId ? `مسئول: ${model.names.get(String(incident.assigneeChatId)) || incident.assigneeChatId}` : incident.status === 'acknowledged' ? 'پذیرفته‌شده در داشبورد' : 'مسئول: هنوز مشخص نشده'));
    if (incident.snoozedUntil && incident.status === 'snoozed') details.append(el('span', '', `تعویق تا ${date(incident.snoozedUntil)}`));
    if (incident.nextEscalationAt && incident.status === 'open') details.append(el('span', '', `پیگیری بعدی: ${date(incident.nextEscalationAt)}`));
    container.append(details);
    if (incident.status !== 'resolved') {
      const actions = el('div', 'incident-action-bar');
      const ack = button('✓ پذیرش مسئولیت', () => run(() => incidentAction('acknowledge')), 'button primary');
      ack.disabled = incident.status === 'acknowledged';
      const snoozeTime = select('incident-snooze-minutes', [['5', '۵ دقیقه'], ['15', '۱۵ دقیقه'], ['30', '۳۰ دقیقه'], ['60', 'یک ساعت'], ['240', '۴ ساعت']], '15');
      snoozeTime.setAttribute('aria-label', 'مدت تعویق رخداد');
      actions.append(ack, snoozeTime, button('تعویق', () => run(() => incidentAction('snooze', Number(snoozeTime.value)))), button('رفع شد', () => run(() => incidentAction('resolve'))));
      if (model.incidentSaving) lock(actions, true);
      container.append(actions);
    }
    container.append(el('h3', '', 'سابقهٔ رسیدگی'));
    const journey = el('div', 'auto-timeline');
    const actionLabels = {created: 'رخداد باز شد', opened: 'رخداد باز شد', occurrence: 'تکرار تازه ثبت شد', repeated: 'تکرار تازه ثبت شد', acknowledge: 'مسئولیت پذیرفته شد', acknowledged: 'مسئولیت پذیرفته شد', snooze: 'رسیدگی به تعویق افتاد', snoozed: 'رسیدگی به تعویق افتاد', resolve: 'مشکل رفع شد', resolved: 'مشکل رفع شد', escalated: 'پیگیری به نفر بعد رسید', escalation: 'پیگیری به نفر بعد رسید', reopened: 'رخداد دوباره باز شد', resumed: 'زمان تعویق پایان یافت'};
    for (const item of timeline || []) {
      const row = el('div', 'auto-timeline-item');
      const copy = el('div');
      const actor = item.actorName === 'Dashboard' ? 'داشبورد' : item.actorName || item.actorChatId || 'سامانه';
      const detail = String(item.detail || '');
      const detailLabels = {'Incident created from notification.': 'این رخداد از یک اعلان تازه ساخته شد.', 'Action from Telegram.': 'اقدام از داخل تلگرام ثبت شد.', 'Action from dashboard.': 'اقدام از داشبورد ثبت شد.'};
      const occurrence = /^Occurrence (\d+)$/.exec(detail);
      const snoozed = /^Snoozed for (\d+) minutes\.$/.exec(detail);
      const detailText = detailLabels[detail] || (occurrence ? `تکرار شمارهٔ ${number(occurrence[1])} ثبت شد.` : snoozed ? `رسیدگی برای ${number(snoozed[1])} دقیقه به تعویق افتاد.` : detail);
      copy.append(el('strong', '', actionLabels[item.action] || item.action), el('p', '', detailText), el('small', '', `${actor} · ${date(item.createdAt)}`));
      row.append(el('span', 'auto-timeline-dot'), copy); journey.append(row);
    }
    if (!journey.childElementCount) journey.append(el('p', '', 'هنوز اقدامی ثبت نشده است.'));
    container.append(journey);
    ui.syncSelects();
  }
  async function incidentAction(action, minutes) {
    if (!model.incident || model.incidentSaving) return;
    const token = stamp();
    const id = model.incident.id;
    const expectedVersion = model.incident.version;
    model.incidentSaving = true;
    lock($('#incident-dialog'), true);
    message('#incident-action-error', '');
    try {
      await ui.api(path(`incidents/${encodeURIComponent(id)}/actions`), {method: 'POST', body: JSON.stringify({action, expectedVersion, ...(minutes ? {minutes} : {})})});
      if (!current(token)) return;
      ui.toast('وضعیت رسیدگی به‌روز شد.');
      await Promise.all([openIncident(id, true), loadIncidents(false)]);
    } catch (error) {
      if (!current(token) || error.stale) return;
      message('#incident-action-error', error.status === 409 ? 'رخداد هم‌زمان تغییر کرده است. نسخهٔ تازه را باز کنید و دوباره اقدام کنید.' : error.message);
      if (error.status === 409) {
        $('#incident-detail').append(button('بازخوانی رخداد', () => run(() => openIncident(id))));
        model.incident = null;
      }
    } finally {
      model.incidentSaving = false;
      lock($('#incident-dialog'), false);
    }
  }
  function policyPath() {
    return path(`automation${model.scope ? `?${new URLSearchParams({applicationId: model.scope})}` : ''}`);
  }
  async function loadPolicy() {
    if (model.saving) return;
    const token = stamp();
    const request = ++model.policyRequest;
    const scope = model.scope;
    model.policy = null;
    model.original = '';
    $('#automation-reset').hidden = true;
    $('#automation-content').hidden = true;
    $('#automation-loading').hidden = false;
    ui.loading($('#automation-loading'), 'در حال دریافت قوانین فعال');
    message('#automation-error', '');
    try {
      const [result, apps] = await Promise.all([ui.api(policyPath()), applications(), initialPeopleNames()]);
      if (!current(token) || request !== model.policyRequest || scope !== model.scope) return;
      setOptions('#automation-scope', apps, 'پیش‌فرض تمام اپلیکیشن‌های فضا', scope);
      setOptions('#auto-preview-app', apps, apps.length ? null : 'اپلیکیشنی ثبت نشده', scope || $('#auto-preview-app').value);
      model.policy = clone(result.policy);
      model.original = JSON.stringify(model.policy);
      model.inherited = result.inherited;
      model.conflict = model.dirty = false;
      $('#automation-loading').hidden = true;
      $('#automation-content').hidden = false;
      $('#auto-preview-result').hidden = true;
      renderPolicy();
    } catch (error) {
      if (!current(token) || request !== model.policyRequest || error.stale) return;
      message('#automation-error', error.message);
      ui.empty($('#automation-loading'), 'قوانین دریافت نشدند', 'تنظیمات شما تغییری نکرده است.', {label: 'تلاش دوباره', run: () => run(loadPolicy)});
    }
  }
  function renderPolicy() {
    const policy = model.policy;
    if (!policy) return;
    $('#auto-group-enabled').checked = policy.grouping.enabled;
    $('#auto-group-window').value = policy.grouping.windowSeconds;
    $('#auto-escalation-enabled').checked = policy.escalation.enabled;
    $('#auto-escalation-delay').value = policy.escalation.afterMinutes;
    $('#automation-inheritance').textContent = model.scope ? model.inherited ? 'ارث‌بری از فضا' : 'قوانین اختصاصی اپلیکیشن' : 'پیش‌فرض فضا';
    $('#automation-inheritance').className = `badge ${model.scope && !model.inherited ? 'info' : 'neutral'}`;
    $('#automation-scope-note').textContent = model.scope ? model.inherited ? 'با ذخیره، قوانین اختصاصی برای این اپلیکیشن ساخته می‌شوند.' : 'این اپلیکیشن مستقل از پیش‌فرض فضا تصمیم می‌گیرد.' : 'اپلیکیشن‌های بدون قانون اختصاصی، همین تنظیمات را اجرا می‌کنند.';
    $('#automation-reset').hidden = !model.scope || model.inherited;
    renderPeopleSelections();
    renderRules();
    policyDirty();
    ui.syncSelects();
  }
  function policyDirty() {
    if (!model.policy) return;
    model.dirty = JSON.stringify(model.policy) !== model.original;
    $('#auto-save-state').textContent = model.conflict ? 'نسخهٔ تازه‌ای روی سرور وجود دارد' : model.dirty ? 'تغییرات ذخیره نشده' : 'قوانین فعال';
    $('#auto-save-note').textContent = model.conflict ? 'بازخوانی کنید و تغییرات را روی نسخهٔ تازه اعمال کنید.' : model.dirty ? 'پیش‌نمایش هنوز با قوانین ذخیره‌شده اجرا می‌شود.' : `نسخهٔ ${number(model.policy.version)} · تنظیمات همین فضا`;
    $('#auto-save-bar').classList.toggle('is-dirty', model.dirty);
    $('#auto-save').disabled = !model.dirty || model.saving || model.conflict;
    $('#auto-group-window').disabled = !model.policy.grouping.enabled || model.saving;
    $('#auto-escalation-delay').disabled = !model.policy.escalation.enabled || model.saving;
    $('#auto-rules-count').textContent = `${number(model.policy.rules.length)} قانون`;
    $('#auto-add-rule').disabled = model.policy.rules.length >= 50 || model.saving;
    ui.syncSelects();
  }
  function levelChoices(selected, prefix, update) {
    const container = el('div', 'auto-choices');
    const checks = [];
    for (const level of levels) {
      const check = input(`${prefix}-${level}`, level, 'checkbox');
      check.checked = selected.includes(level);
      checks.push(check);
      check.addEventListener('change', () => update(checks.filter(item => item.checked).map(item => item.value)));
      const caption = el('label', 'auto-choice'); caption.append(check, el('span', '', levelNames[level])); container.append(caption);
    }
    return container;
  }
  function renderRules(focusId) {
    const container = $('#auto-rules');
    container.replaceChildren();
    if (!model.policy.rules.length) container.append(el('p', 'auto-empty-note', 'هنوز قانونی تعریف نشده. از یک الگو شروع کنید یا قانون خودتان را بسازید.'));
    model.policy.rules.forEach((rule, index) => {
      const card = el('section', 'auto-rule');
      card.setAttribute('aria-disabled', String(!rule.enabled));
      const prefix = `auto-rule-${index}`;
      const top = el('div', 'auto-rule-top');
      const enabled = input(`${prefix}-enabled`, '', 'checkbox'); enabled.checked = rule.enabled;
      enabled.setAttribute('aria-label', `فعال بودن قانون ${index + 1}`);
      enabled.addEventListener('change', () => { rule.enabled = enabled.checked; card.setAttribute('aria-disabled', String(!rule.enabled)); policyDirty(); });
      const name = input(`${prefix}-name`, rule.name, 'text', {maxLength: 80, required: true});
      name.addEventListener('input', () => { rule.name = name.value; policyDirty(); });
      const actions = el('div', 'auto-rule-actions');
      const up = button('↑', () => moveRule(index, -1), 'icon-button'); up.disabled = index === 0; up.setAttribute('aria-label', `جابه‌جایی قانون ${index + 1} به بالا`);
      const down = button('↓', () => moveRule(index, 1), 'icon-button'); down.disabled = index === model.policy.rules.length - 1; down.setAttribute('aria-label', `جابه‌جایی قانون ${index + 1} به پایین`);
      const remove = button('×', () => { model.policy.rules.splice(index, 1); renderRules(); policyDirty(); }, 'icon-button'); remove.setAttribute('aria-label', `حذف قانون ${index + 1}`);
      actions.append(up, down, remove);
      top.append(el('span', 'auto-rule-number', number(index + 1)), enabled, field('نام قانون', name), actions);
      card.append(top, el('label', '', 'سطح‌های منطبق · بدون انتخاب یعنی همه'), levelChoices(rule.levels, prefix, value => { rule.levels = value; policyDirty(); }));
      const filters = el('div', 'auto-inline-fields');
      const env = input(`${prefix}-environments`, rule.environments.join(', '), 'text', {maxLength: 1600, dir: 'ltr', placeholder: 'production, staging'});
      env.addEventListener('input', () => { rule.environments = split(env.value); policyDirty(); });
      const tags = input(`${prefix}-tags`, rule.tags.join(', '), 'text', {maxLength: 1000, dir: 'ltr', placeholder: 'release, backend'});
      tags.addEventListener('input', () => { rule.tags = split(tags.value); policyDirty(); });
      filters.append(field('محیط‌ها · جداشده با ویرگول', env), field('برچسب‌ها · جداشده با ویرگول', tags));
      const delivery = el('div', 'auto-inline-fields');
      const mode = select(`${prefix}-mode`, [['immediate', 'ارسال فوری'], ['digest', 'خلاصهٔ دوره‌ای'], ['mute', 'ارسال نشود']], rule.mode);
      const interval = input(`${prefix}-minutes`, rule.digestMinutes, 'number', {min: '5', max: '1440', required: true, dir: 'ltr'});
      const intervalField = field('فاصلهٔ خلاصه‌ها · دقیقه', interval); intervalField.hidden = rule.mode !== 'digest'; interval.disabled = rule.mode !== 'digest';
      mode.addEventListener('change', () => { rule.mode = mode.value; intervalField.hidden = rule.mode !== 'digest'; interval.disabled = rule.mode !== 'digest'; policyDirty(); });
      interval.addEventListener('input', () => { rule.digestMinutes = Number(interval.value); policyDirty(); });
      delivery.append(field('نتیجهٔ این قانون', mode), intervalField);
      card.append(filters, delivery); container.append(card);
    });
    ui.syncSelects();
    if (focusId) $(focusId)?.focus();
  }
  function moveRule(index, offset) {
    const target = index + offset;
    if (target < 0 || target >= model.policy.rules.length) return;
    [model.policy.rules[index], model.policy.rules[target]] = [model.policy.rules[target], model.policy.rules[index]];
    renderRules(`#auto-rule-${target}-name`); policyDirty();
  }
  function addRule(preset) {
    if (!model.policy || model.saving || model.policy.rules.length >= 50) return;
    const rule = {id: crypto.randomUUID(), name: 'قانون تازه', enabled: true, levels: [], environments: [], tags: [], mode: 'immediate', digestMinutes: 60};
    if (preset === 'critical') Object.assign(rule, {name: 'بحرانی‌ها فوری', levels: ['critical']});
    if (preset === 'staging') Object.assign(rule, {name: 'خلاصهٔ ساعتی staging', levels: ['info', 'success'], environments: ['staging'], mode: 'digest'});
    if (preset === 'maintenance') Object.assign(rule, {name: 'سکوت در زمان نگهداری', tags: ['maintenance'], mode: 'mute'});
    model.policy.rules.push(rule);
    renderRules(`#auto-rule-${model.policy.rules.length - 1}-name`); policyDirty();
  }
  async function savePolicy(event) {
    event.preventDefault();
    if (!model.policy || !model.dirty || model.saving || model.conflict) return;
    if (!$('#automation-form').reportValidity()) return;
    const token = stamp();
    const {version, ...policy} = clone(model.policy);
    model.saving = true;
    lock($('#automation-form'), true);
    $('#automation-scope').disabled = true; $('#automation-reset').disabled = true;
    message('#automation-error', '');
    try {
      const result = await ui.api(policyPath(), {method: 'PUT', body: JSON.stringify({...policy, expectedVersion: version})});
      if (!current(token)) return;
      model.policy = clone(result.policy); model.original = JSON.stringify(model.policy); model.inherited = result.inherited; model.dirty = false;
      ui.toast('قوانین ارسال ذخیره شدند.');
      $('#auto-preview-result').hidden = true;
    } catch (error) {
      if (!current(token) || error.stale) return;
      model.conflict = error.status === 409;
      message('#automation-error', model.conflict ? 'این قوانین هم‌زمان تغییر کرده‌اند. بازخوانی کنید و تغییرات را روی نسخهٔ تازه اعمال کنید.' : error.message);
    } finally {
      model.saving = false;
      lock($('#automation-form'), false); $('#automation-scope').disabled = false; $('#automation-reset').disabled = false;
      if (current(token)) renderPolicy();
      ui.syncSelects();
    }
  }
  async function resetPolicy() {
    if (!model.scope || model.inherited || model.saving) return;
    const token = stamp();
    model.saving = true;
    lock($('#automation-form'), true); $('#automation-scope').disabled = true; $('#automation-reset').disabled = true;
    message('#automation-error', '');
    try {
      const query = new URLSearchParams({applicationId: model.scope, expectedVersion: String(model.policy.version)});
      const result = await ui.api(path(`automation?${query}`), {method: 'DELETE'});
      if (!current(token)) return;
      model.policy = clone(result.policy); model.original = JSON.stringify(model.policy); model.inherited = result.inherited; model.dirty = model.conflict = false;
      ui.toast('اپلیکیشن دوباره از قوانین فضا پیروی می‌کند.');
    } catch (error) {
      if (!current(token) || error.stale) return;
      model.conflict = error.status === 409;
      message('#automation-error', model.conflict ? 'قوانین هم‌زمان تغییر کرده‌اند؛ ابتدا بازخوانی کنید.' : error.message);
    } finally {
      model.saving = false;
      lock($('#automation-form'), false); $('#automation-scope').disabled = false; $('#automation-reset').disabled = false;
      if (current(token)) renderPolicy();
      ui.syncSelects();
    }
  }
  function renderPeopleSelections() {
    for (const [selector, ids, ordered] of [['#auto-responders', model.policy.responders, false], ['#auto-escalation-targets', model.policy.escalation.targetChatIds, true]]) {
      const container = $(selector); container.replaceChildren();
      if (!ids.length) container.append(el('p', 'auto-empty-note', ordered ? 'هنوز کسی در مسیر پیگیری نیست.' : 'همهٔ مشترکان دارای دسترسی می‌توانند مسئولیت رسیدگی را بپذیرند. با انتخاب افراد، این امکان محدود می‌شود.'));
      ids.forEach((chatId, index) => {
        const row = el('div', 'auto-person');
        const name = model.names.get(String(chatId)) || `مشترک ${chatId}`;
        const copy = el('div', 'auto-person-label');
        const id = el('small', '', chatId); id.dir = 'ltr';
        copy.append(el('strong', '', name), id);
        row.append(el('span', 'app-initial', ordered ? number(index + 1) : [...name][0]), copy);
        const actions = el('div', 'auto-rule-actions');
        if (ordered) {
          for (const [offset, glyph, caption] of [[-1, '↑', 'بالاتر'], [1, '↓', 'پایین‌تر']]) {
            const move = button(glyph, () => { const next = index + offset; [ids[index], ids[next]] = [ids[next], ids[index]]; renderPeopleSelections(); policyDirty(); }, 'icon-button');
            move.disabled = index + offset < 0 || index + offset >= ids.length; move.setAttribute('aria-label', `${name} ${caption}`); actions.append(move);
          }
        }
        const remove = button('×', () => { ids.splice(index, 1); renderPeopleSelections(); policyDirty(); }, 'icon-button'); remove.setAttribute('aria-label', `حذف ${name}`); actions.append(remove);
        row.append(actions); container.append(row);
      });
    }
    $('#auto-add-responder').disabled = model.policy.responders.length >= 100;
    $('#auto-add-escalation').disabled = model.policy.escalation.targetChatIds.length >= 100;
  }
  async function openPeople(mode) {
    if (model.saving) return;
    model.peopleMode = mode; model.peoplePage = 1;
    $('#auto-people-search').value = '';
    $('#auto-people-title').textContent = mode === 'responders' ? 'انتخاب اعضای تیم پاسخ‌گو' : mode === 'escalation' ? 'افزودن مرحلهٔ پیگیری' : 'انتخاب مشترک برای پیش‌نمایش';
    if (!$('#auto-people-dialog').open) $('#auto-people-dialog').showModal();
    await loadPeople();
    $('#auto-people-search').focus();
  }
  async function loadPeople() {
    const token = stamp(); const request = ++model.peopleRequest;
    ui.loading($('#auto-people-list')); message('#auto-people-error', '');
    try {
      const result = await ui.api(path(`subscribers?${new URLSearchParams({page: String(model.peoplePage), search: $('#auto-people-search').value.trim()})}`));
      if (!current(token) || request !== model.peopleRequest || !$('#auto-people-dialog').open) return;
      const container = $('#auto-people-list'); container.replaceChildren();
      if (!result.items.length) container.append(el('p', 'auto-empty-note', 'مشترکی با این مشخصات پیدا نشد.'));
      for (const person of result.items) {
        const id = String(person.chatId); const name = person.displayName || person.firstName || person.username || `مشترک ${id}`;
        model.names.set(id, name);
        const row = el('div', 'auto-person');
        const copy = el('div', 'auto-person-label'); copy.append(el('strong', '', name), el('small', '', `${person.username ? `@${person.username} · ` : ''}${id}`));
        const selected = model.peopleMode === 'preview' ? $('#auto-preview-chat').value === id : (model.peopleMode === 'responders' ? model.policy.responders : model.policy.escalation.targetChatIds).includes(id);
        const unavailable = model.peopleMode !== 'preview' && (!person.active || person.banned);
        const pick = button(selected ? 'انتخاب شده' : unavailable ? 'غیرقابل انتخاب' : 'انتخاب', () => {
          if (model.peopleMode === 'preview') $('#auto-preview-chat').value = id;
          else {
            const ids = model.peopleMode === 'responders' ? model.policy.responders : model.policy.escalation.targetChatIds;
            if (!ids.includes(id) && ids.length < 100) ids.push(id);
            renderPeopleSelections(); policyDirty();
          }
          $('#auto-people-dialog').close();
        });
        pick.disabled = selected || unavailable;
        row.append(el('span', 'app-initial', [...name][0]), copy, pick); container.append(row);
      }
      ui.renderPagination($('#auto-people-pagination'), result, page => { model.peoplePage = page; run(loadPeople); });
    } catch (error) {
      if (!current(token) || request !== model.peopleRequest || error.stale) return;
      message('#auto-people-error', error.message);
      ui.empty($('#auto-people-list'), 'مشترکان دریافت نشدند', '', {label: 'تلاش دوباره', run: () => run(loadPeople)});
    }
  }
  async function preview(event) {
    event.preventDefault();
    const token = stamp(); const request = ++model.previewRequest;
    const button = $('#auto-preview-run');
    if (button.disabled) return;
    lock($('#automation-preview-form'), true);
    message('#auto-preview-error', ''); $('#auto-preview-result').hidden = true;
    try {
      const result = await ui.api(path('automation/preview'), {method: 'POST', body: JSON.stringify({applicationId: $('#auto-preview-app').value, ...($('#auto-preview-chat').value.trim() ? {chatId: $('#auto-preview-chat').value.trim()} : {}), level: $('#auto-preview-level').value, ...($('#auto-preview-env').value.trim() ? {environment: $('#auto-preview-env').value.trim()} : {}), tags: split($('#auto-preview-tags').value)})});
      if (!current(token) || request !== model.previewRequest) return;
      const output = $('#auto-preview-result');
      output.dataset.mode = Object.hasOwn(modes, result.mode) ? result.mode : 'defer';
      const reasons = {level_filter: 'این سطح در ترجیحات مشترک انتخاب نشده است.', environment_filter: 'این محیط در ترجیحات مشترک مجاز نیست.', critical_bypass: 'هشدار بحرانی از ساعت سکوت و خلاصه عبور می‌کند.', quiet_hours: 'اکنون ساعت سکوت مشترک است؛ پیام تا پایان این بازه منتظر می‌ماند.', subscriber_digest: 'مشترک دریافت پیام‌ها در یک خلاصهٔ دوره‌ای را انتخاب کرده است.', default: 'هیچ محدودیت یا قانون منطبق دیگری وجود ندارد؛ مسیر پیش‌فرض اجرا می‌شود.', 'Subscriber is inactive, banned, or excluded from this application.': 'این مشترک غیرفعال یا مسدود است، یا به این اپلیکیشن دسترسی ندارد.'};
      const reason = String(result.reason || '');
      const savedPolicy = model.original ? JSON.parse(model.original) : null;
      const rule = reason.startsWith('rule:') && model.scope === $('#auto-preview-app').value ? savedPolicy?.rules.find(item => item.id === reason.slice(5)) : null;
      output.replaceChildren(el('strong', '', modes[result.mode] || result.mode), el('p', '', reasons[reason] || (reason.startsWith('rule:') ? rule ? `قانون «${rule.name}» با این پیام منطبق است.` : 'یک قانون ذخیره‌شده با این پیام منطبق است.' : reason)));
      if (result.nextAt) output.append(el('small', '', `زمان برنامه‌ریزی‌شده: ${date(result.nextAt)}`));
      if (model.dirty) output.append(el('small', '', 'این نتیجه با قوانین ذخیره‌شده محاسبه شده؛ تغییرات فعلی هنوز فعال نیستند.'));
      output.hidden = false;
    } catch (error) {
      if (current(token) && request === model.previewRequest && !error.stale) message('#auto-preview-error', error.message);
    } finally { lock($('#automation-preview-form'), false); }
  }
  async function openPreferences(chatId) {
    if (model.preferencesSaving) return;
    const token = stamp(); const request = ++model.preferencesRequest;
    model.chatId = String(chatId); model.preferences = null; model.preferencesDirty = model.preferencesConflict = false;
    $('#delivery-preferences-form').hidden = true; $('#delivery-preferences-loading').hidden = false;
    $('#delivery-preferences-person').textContent = `${ui.state.subscribers.find(item => String(item.chatId) === String(chatId))?.displayName || ui.state.subscribers.find(item => String(item.chatId) === String(chatId))?.firstName || 'مشترک'} · ${chatId}`;
    message('#delivery-preferences-error', '');
    ui.loading($('#delivery-preferences-loading'), 'در حال دریافت ترجیحات مشترک');
    if (!$('#delivery-preferences-dialog').open) $('#delivery-preferences-dialog').showModal();
    try {
      const result = await ui.api(path(`subscribers/${encodeURIComponent(chatId)}/preferences`));
      if (!current(token) || request !== model.preferencesRequest || !$('#delivery-preferences-dialog').open) return;
      model.preferences = clone(result.preferences); model.preferencesOriginal = JSON.stringify(model.preferences);
      $('#delivery-preferences-loading').hidden = true; $('#delivery-preferences-form').hidden = false;
      renderPreferences();
    } catch (error) {
      if (!current(token) || request !== model.preferencesRequest || error.stale) return;
      ui.empty($('#delivery-preferences-loading'), 'ترجیحات دریافت نشدند', error.message, {label: 'تلاش دوباره', run: () => run(() => openPreferences(chatId))});
    }
  }
  function renderPreferences() {
    const prefs = model.preferences;
    const choices = levelChoices(prefs.levels, 'delivery-level', values => { prefs.levels = values; preferencesDirty(); });
    $('#delivery-levels').replaceChildren(...choices.childNodes);
    $('#delivery-environments').value = prefs.environments.join(', ');
    $('#delivery-timezone').value = prefs.timezone;
    $('#delivery-mode').value = prefs.delivery;
    $('#delivery-digest-minutes').value = prefs.digestMinutes;
    $('#delivery-quiet-enabled').checked = prefs.quietHours.enabled;
    $('#delivery-quiet-start').value = prefs.quietHours.start;
    $('#delivery-quiet-end').value = prefs.quietHours.end;
    $('#delivery-critical-bypass').checked = prefs.criticalBypass;
    preferencesDirty();
    ui.syncSelects();
  }
  function preferencesDirty() {
    const prefs = model.preferences;
    if (!prefs) return;
    model.preferencesDirty = JSON.stringify(prefs) !== model.preferencesOriginal;
    $('#delivery-levels-warning').hidden = prefs.levels.length > 0;
    $('#delivery-digest-field').hidden = prefs.delivery !== 'digest';
    $('#delivery-digest-minutes').disabled = prefs.delivery !== 'digest' || model.preferencesSaving;
    $('#delivery-quiet-start').disabled = $('#delivery-quiet-end').disabled = !prefs.quietHours.enabled || model.preferencesSaving;
    $('#delivery-preferences-save').disabled = !model.preferencesDirty || model.preferencesSaving || model.preferencesConflict;
    $('#delivery-preferences-summary').textContent = !prefs.levels.length ? 'دریافت تمام سطح‌ها متوقف است.' : `${number(prefs.levels.length)} سطح مجاز · ${prefs.environments.length ? prefs.environments.join('، ') : 'همهٔ محیط‌ها'} · ${prefs.delivery === 'digest' ? `خلاصه هر ${number(prefs.digestMinutes)} دقیقه` : 'دریافت فوری'}${prefs.quietHours.enabled ? ` · سکوت ${prefs.quietHours.start} تا ${prefs.quietHours.end}` : ''} · ${prefs.timezone}`;
    ui.syncSelects();
  }
  async function savePreferences(event) {
    event.preventDefault();
    if (!model.preferences || !model.preferencesDirty || model.preferencesSaving || model.preferencesConflict) return;
    const token = stamp(); const chatId = model.chatId;
    const {version, ...prefs} = clone(model.preferences);
    try { new Intl.DateTimeFormat('en', {timeZone: prefs.timezone}); }
    catch { message('#delivery-preferences-error', 'منطقهٔ زمانی معتبر وارد کنید؛ مانند Asia/Tehran.'); return; }
    if (prefs.quietHours.enabled && prefs.quietHours.start === prefs.quietHours.end) { message('#delivery-preferences-error', 'زمان شروع و پایان سکوت باید متفاوت باشد.'); return; }
    model.preferencesSaving = true;
    lock($('#delivery-preferences-dialog'), true); message('#delivery-preferences-error', '');
    try {
      const result = await ui.api(path(`subscribers/${encodeURIComponent(chatId)}/preferences`), {method: 'PUT', body: JSON.stringify({...prefs, expectedVersion: version})});
      if (!current(token)) return;
      model.preferences = clone(result.preferences); model.preferencesOriginal = JSON.stringify(model.preferences); model.preferencesDirty = false;
      ui.toast('ترجیحات دریافت مشترک ذخیره شدند.');
    } catch (error) {
      if (!current(token) || error.stale) return;
      model.preferencesConflict = error.status === 409;
      message('#delivery-preferences-error', model.preferencesConflict ? 'ترجیحات از جای دیگری تغییر کرده‌اند. بازخوانی کنید و دوباره ذخیره کنید.' : error.message);
    } finally {
      model.preferencesSaving = false; lock($('#delivery-preferences-dialog'), false);
      if (current(token)) renderPreferences();
    }
  }
  function init(context) {
    ui = context;
    for (const item of document.querySelectorAll('[data-incident-status]')) item.addEventListener('click', () => { model.incidentStatus = item.dataset.incidentStatus; model.incidentPage = 1; renderStatusFilters(); run(loadIncidents); });
    $('#incident-app-filter').addEventListener('change', () => { model.incidentPage = 1; run(loadIncidents); });
    $('#automation-scope').addEventListener('change', () => {
      const target = $('#automation-scope').value;
      const go = () => { model.scope = target; $('#automation-scope').value = target; run(loadPolicy); };
      if (model.dirty) { $('#automation-scope').value = model.scope; ui.syncSelects(); discardThen(go); } else go();
    });
    $('#automation-form').addEventListener('submit', event => { event.preventDefault(); run(() => savePolicy(event)); });
    $('#auto-group-enabled').addEventListener('change', () => { if (model.policy) { model.policy.grouping.enabled = $('#auto-group-enabled').checked; policyDirty(); } });
    $('#auto-group-window').addEventListener('input', () => { if (model.policy) { model.policy.grouping.windowSeconds = Number($('#auto-group-window').value); policyDirty(); } });
    $('#auto-escalation-enabled').addEventListener('change', () => { if (model.policy) { model.policy.escalation.enabled = $('#auto-escalation-enabled').checked; policyDirty(); } });
    $('#auto-escalation-delay').addEventListener('input', () => { if (model.policy) { model.policy.escalation.afterMinutes = Number($('#auto-escalation-delay').value); policyDirty(); } });
    $('#auto-add-responder').addEventListener('click', () => run(() => openPeople('responders')));
    $('#auto-add-escalation').addEventListener('click', () => run(() => openPeople('escalation')));
    $('#auto-add-rule').addEventListener('click', () => addRule());
    for (const item of document.querySelectorAll('[data-rule-preset]')) item.addEventListener('click', () => addRule(item.dataset.rulePreset));
    $('#auto-reload').addEventListener('click', () => { if (model.dirty) discardThen(() => run(loadPolicy)); else run(loadPolicy); });
    $('#automation-reset').addEventListener('click', () => { if (model.dirty) discardThen(() => run(resetPolicy)); else run(resetPolicy); });
    $('#automation-preview-form').addEventListener('submit', event => { event.preventDefault(); run(() => preview(event)); });
    $('#auto-preview-pick').addEventListener('click', () => run(() => openPeople('preview')));
    $('#auto-people-search').addEventListener('input', () => { clearTimeout(model.peopleTimer); model.peopleTimer = setTimeout(() => { model.peoplePage = 1; run(loadPeople); }, 300); });
    $('#delivery-preferences-form').addEventListener('submit', event => { event.preventDefault(); run(() => savePreferences(event)); });
    $('#delivery-preferences-reload').addEventListener('click', () => { const reload = () => run(() => openPreferences(model.chatId)); if (model.preferencesDirty) discardThen(reload, 'preferences'); else reload(); });
    const preferencesInputs = [
      ['delivery-environments', 'input', prefs => { prefs.environments = split($('#delivery-environments').value); }],
      ['delivery-timezone', 'input', prefs => { prefs.timezone = $('#delivery-timezone').value.trim(); }],
      ['delivery-mode', 'change', prefs => { prefs.delivery = $('#delivery-mode').value; }],
      ['delivery-digest-minutes', 'input', prefs => { prefs.digestMinutes = Number($('#delivery-digest-minutes').value); }],
      ['delivery-quiet-enabled', 'change', prefs => { prefs.quietHours.enabled = $('#delivery-quiet-enabled').checked; }],
      ['delivery-quiet-start', 'input', prefs => { prefs.quietHours.start = $('#delivery-quiet-start').value; }],
      ['delivery-quiet-end', 'input', prefs => { prefs.quietHours.end = $('#delivery-quiet-end').value; }],
      ['delivery-critical-bypass', 'change', prefs => { prefs.criticalBypass = $('#delivery-critical-bypass').checked; }]
    ];
    for (const [id, event, update] of preferencesInputs) $(`#${id}`).addEventListener(event, () => { if (model.preferences) { update(model.preferences); preferencesDirty(); } });
    $('#auto-discard-cancel').addEventListener('click', () => { model.pendingLeave = null; $('#auto-discard-dialog').close(); });
    $('#auto-discard-confirm').addEventListener('click', () => { const action = model.pendingLeave; model.pendingLeave = null; $('#auto-discard-dialog').close(); if (action) action(); });
    for (const id of ['incident-dialog', 'delivery-preferences-dialog']) $(`#${id}`).addEventListener('cancel', event => { if (!canClose(event.target)) event.preventDefault(); });
    $('#incident-dialog').addEventListener('close', () => { model.incidentDetailRequest++; model.incident = null; });
    $('#delivery-preferences-dialog').addEventListener('close', () => { model.preferencesRequest++; model.preferences = null; model.preferencesDirty = false; });
    $('#auto-people-dialog').addEventListener('close', () => { model.peopleRequest++; clearTimeout(model.peopleTimer); });
    window.addEventListener('beforeunload', event => { if (model.dirty || model.preferencesDirty || model.saving || model.preferencesSaving) { event.preventDefault(); event.returnValue = ''; } });
  }
  function applicationsChanged(items) {
    if (!ui) return;
    model.applications = clone(items);
  }
  return {init, clear, activate, canLeave, canClose, applicationsChanged, preferences: chatId => run(() => openPreferences(chatId)), refresh: ({manual = false} = {}) => ui.state.tab === 'incidents' ? loadIncidents(manual) : ui.state.tab === 'automation' && manual && !model.dirty ? loadPolicy() : Promise.resolve()};
})();
