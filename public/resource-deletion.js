'use strict';

/** Confirm irreversible resource removal against the latest saved entity version. */
window.RelayDeletion = (() => {
  let ui;
  const model = {request: 0, target: null, stamp: null, saving: false, loading: false, conflict: false, missing: false};
  const $ = selector => ui.$(selector);
  const labels = {tenant: 'فضای اعلان', bot: 'بات', application: 'اپلیکیشن'};

  /** Ignore a completed request after the operator leaves its original dashboard scope. */
  function current(request = model.request) {
    return request === model.request && model.target && ui.state.authenticated
      && model.stamp.epoch === ui.state.epoch && model.stamp.tenantId === ui.state.tenantId
      && $('#resource-delete-dialog').open;
  }

  /** Address the entity explicitly so deletion never follows a later scope selection. */
  function endpoint(target) {
    const base = ui.tenantPath('', target.tenantId);
    if (target.kind === 'tenant') return base;
    const suffix = target.kind === 'bot' ? 'bots' : 'applications';
    return `${base}/${suffix}/${encodeURIComponent(target.entity.id)}${target.kind === 'application' ? `?botId=${encodeURIComponent(target.botId)}` : ''}`;
  }

  /** Require exact typed identity and a fresh saved version before enabling deletion. */
  function renderControls() {
    const pending = model.saving || model.loading;
    const valid = model.target && !model.conflict && !model.missing && !pending
      && $('#resource-delete-confirmation').value === model.target.entity.id;
    $('#resource-delete-submit').disabled = !valid;
    $('#resource-delete-submit').setAttribute('aria-busy', String(model.saving));
    $('#resource-delete-submit-text').textContent = model.saving ? 'در حال ثبت حذف…' : `حذف ${labels[model.target?.kind] || 'مورد'}`;
    $('#resource-delete-confirmation').disabled = pending || model.conflict || model.missing;
    $('#resource-delete-dialog').setAttribute('aria-busy', String(pending));
    for (const button of document.querySelectorAll('#resource-delete-dialog [data-close-dialog]')) button.disabled = model.saving;
    $('#resource-delete-reload').disabled = pending;
    $('#resource-delete-reload').hidden = !(model.conflict || model.missing);
    $('#resource-delete-reload').textContent = model.missing ? 'به‌روزرسانی فهرست' : 'دریافت نسخهٔ تازه';
    $('#resource-delete-status').textContent = model.loading ? 'در حال دریافت آخرین وضعیت…'
      : model.saving ? 'ثبت حذف و توقف دسترسی‌ها؛ این پنجره را نبندید.'
        : model.conflict ? 'این مورد تغییر کرده است. پیش از تأیید دوباره، نسخهٔ تازه را دریافت کنید.'
          : model.missing ? 'این مورد دیگر در فهرست موجود نیست.'
            : valid ? 'شناسه تأیید شد. با دکمهٔ حذف، عملیات نهایی می‌شود.' : 'حذف فقط پس از وارد کردن شناسه و تأیید نهایی انجام می‌شود.';
  }

  /** Explain the resource boundary without promising to recall messages already sent. */
  function renderTarget() {
    const target = model.target;
    $('#resource-delete-heading').textContent = `حذف ${labels[target.kind]}`;
    $('#resource-delete-name').textContent = target.entity.name;
    $('#resource-delete-id').textContent = target.entity.id;
    $('#resource-delete-identity').textContent = target.entity.id;
    $('#resource-delete-context').textContent = target.kind === 'tenant' ? 'همهٔ اتصال‌های داخل این فضا'
      : `فضای اعلان: ${target.tenantName}${target.kind === 'application' && target.botName ? ` · بات: ${target.botName}` : ''}`;
    const impacts = target.kind === 'tenant'
      ? [['قطع همهٔ مسیرهای ارسال', 'بات‌ها، اپلیکیشن‌ها و کلیدهای ارسال این فضا از دسترس خارج می‌شوند.'], ['پاک‌سازی داده‌های وابسته', 'مشترکان، صف‌ها، گزارش‌ها و قوانین این فضا پاک می‌شوند.']]
      : target.kind === 'bot'
        ? [['توقف اپلیکیشن‌های متصل', `دسترسی و کلیدهای ${ui.count(target.entity.applicationCount ?? 0)} اپلیکیشن متصل لغو می‌شوند.`], ['پاک‌سازی فضای بات', target.entity.id === 'default' ? 'مشترکان، صف‌ها و گزارش‌های این بات پاک می‌شوند. محدودیت‌های مشترک IP و کشور، در صورت وجود، برای بات‌های دیگر حفظ می‌شوند و از مدیریت فضا قابل برداشتن هستند.' : 'مشترکان، صف‌ها، گزارش‌ها و قوانین این بات پاک می‌شوند؛ بقیهٔ بات‌ها حفظ می‌شوند.']]
        : [['لغو کلید ارسال', 'این اپلیکیشن دیگر اعلان نمی‌پذیرد و در فهرست بات نمایش داده نمی‌شود.'], ['پاک‌سازی اعلان‌ها و قوانین', 'صف، تاریخچه و قوانین وابستهٔ این اپلیکیشن پاک می‌شوند؛ خود بات و مشترکانش حفظ می‌شوند.']];
    $('#resource-delete-effects').replaceChildren(...impacts.map(([heading, description], index) => {
      const item = ui.node('div', 'resource-delete-effect');
      item.append(ui.node('span', 'resource-delete-step', String(index + 1)));
      const copy = ui.node('div');
      copy.append(ui.node('strong', '', heading), ui.node('p', '', description));
      item.append(copy);
      return item;
    }));
    $('#resource-delete-note').textContent = target.kind === 'application'
      ? 'شناسهٔ حذف‌شده دوباره قابل استفاده نیست. پیام‌های قبلی از تلگرام پاک نمی‌شوند و ارسال در حال انجام ممکن است کامل شود.'
      : 'شناسهٔ حذف‌شده دوباره قابل استفاده نیست. حساب بات در تلگرام حذف نمی‌شود. پیام‌های قبلی باقی می‌مانند و ارسال در حال انجام ممکن است کامل شود.';
  }

  /** Refresh the version and visible name before asking for irreversible confirmation. */
  async function reload() {
    if (!model.target || model.saving) return;
    const request = ++model.request;
    model.loading = true;
    model.conflict = false;
    model.missing = false;
    $('#resource-delete-confirmation').value = '';
    ui.showError('#resource-delete-error', '');
    renderControls();
    try {
      const data = await ui.api(endpoint(model.target));
      if (!current(request)) return;
      const entity = data[model.target.kind];
      if (!entity || !Number.isSafeInteger(entity.version)) throw new Error('آخرین نسخهٔ این مورد دریافت نشد. فهرست را دوباره بارگذاری کنید.');
      model.target.entity = entity;
      renderTarget();
    } catch (error) {
      if (!current(request) || error.stale) return;
      model.missing = error.status === 404;
      model.conflict = !model.missing;
      ui.showError('#resource-delete-error', model.missing ? 'این مورد قبلاً حذف شده یا دیگر در دسترس نیست.' : error.message);
    } finally {
      if (current(request)) {
        model.loading = false;
        renderControls();
        if (!model.conflict && !model.missing) $('#resource-delete-confirmation').focus();
      }
    }
  }

  /** Open one destructive confirmation, preserving unsaved work in other dashboard panels. */
  function open(kind, entity) {
    if (ui.state.activeWrites || model.saving) return;
    if (!ui.canLeave(() => open(kind, entity))) return;
    model.target = {
      kind, entity: {...entity}, tenantId: kind === 'tenant' ? entity.id : ui.state.tenantId,
      tenantName: ui.selectedTenant()?.name || ui.state.tenantId, botId: entity.botId || ui.state.botId,
      botName: ui.state.bot?.name || ''
    };
    model.stamp = {epoch: ui.state.epoch, tenantId: ui.state.tenantId};
    model.conflict = false;
    model.missing = false;
    renderTarget();
    if (!$('#resource-delete-dialog').open) $('#resource-delete-dialog').showModal();
    void reload();
  }

  /** Reconcile visible scopes after accepted deletion or an already removed resource. */
  async function reconcile(target, cleanupPending = false) {
    $('#resource-delete-dialog').close();
    try {
      await ui.afterDelete(target);
      const focusSelector = {tenant: '#create-tenant', bot: '#create-bot', application: '#create-application'}[target.kind];
      $(focusSelector)?.focus({preventScroll: true});
      ui.toast(cleanupPending ? 'حذف ثبت شد؛ دسترسی بسته است و پاک‌سازی داده‌ها در پس‌زمینه ادامه دارد.' : `${labels[target.kind]} حذف شد.`);
    } catch (error) {
      if (!error.stale) ui.toast('حذف ثبت شد، اما فهرست تازه دریافت نشد. دکمهٔ به‌روزرسانی را بزنید.', true);
    }
  }

  /** Submit the confirmed saved version once and retain a safe retry for network failures. */
  async function submit(event) {
    event.preventDefault();
    if ($('#resource-delete-submit').disabled || !model.target || model.saving) return;
    const target = model.target, request = model.request;
    model.saving = true;
    ui.showError('#resource-delete-error', '');
    renderControls();
    let result;
    try {
      result = await ui.api(endpoint(target), {
        method: 'DELETE',
        body: JSON.stringify({expectedVersion: target.entity.version})
      });
      if (!current(request)) return;
      model.saving = false;
      await reconcile(target, Boolean(result.cleanupPending));
    } catch (error) {
      if (!current(request) || error.stale) return;
      model.conflict = error.status === 409;
      model.missing = error.status === 404;
      if (model.conflict) $('#resource-delete-confirmation').value = '';
      ui.showError('#resource-delete-error', error.message);
    } finally {
      model.saving = false;
      if ($('#resource-delete-dialog').open) renderControls();
    }
  }

  /** Keep keyboard and backdrop dismissal disabled only while the destructive request runs. */
  function canClose(dialog) {
    return dialog.id !== 'resource-delete-dialog' || !model.saving;
  }

  /** Wire the shared modal after the dashboard services and static markup are available. */
  function init(context) {
    ui = context;
    $('#resource-delete-form').addEventListener('submit', submit);
    $('#resource-delete-confirmation').addEventListener('input', renderControls);
    $('#resource-delete-reload').addEventListener('click', () => {
      if (model.missing) void reconcile(model.target); else void reload();
    });
    $('#resource-delete-dialog').addEventListener('cancel', event => {
      if (!canClose(event.target)) event.preventDefault();
    });
    $('#resource-delete-dialog').addEventListener('close', () => {
      model.request++;
      model.target = null;
      model.stamp = null;
      model.loading = false;
      model.conflict = false;
      model.missing = false;
      $('#resource-delete-confirmation').value = '';
    });
  }

  return {init, open, canClose};
})();
