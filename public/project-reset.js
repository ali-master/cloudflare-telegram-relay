'use strict';
/** Confirm global erasure explicitly and observe durable cleanup without resubmitting it. */
window.RelayReset = (() => {
  let ui, timer, busy = false, loading = false;
  const $ = selector => ui.$(selector);
  /** Lock destructive controls until the exact acknowledgement is supplied. */
  function controls() {
    $('#submit-project-reset').disabled = busy || $('#project-reset-confirmation').value !== 'RESET ALL DATA';
    $('#cancel-project-reset').disabled = busy;
    $('#project-reset-confirmation').disabled = busy;
  }
  /** Resume progress after navigation or reload; polling stops on logout or completion. */
  async function refresh() {
    if (!ui?.state.authenticated || loading) return;
    clearTimeout(timer);
    loading = true;
    try {
      const status = await ui.api('/api/admin/reset');
      $('#open-project-reset').disabled = status.running;
      $('#project-reset-status').textContent = status.running
        ? `پاک‌سازی در حال اجراست؛ ${status.pending} عملیات باقی مانده. اگر تلگرام در دسترس نباشد، تلاش خودکار ادامه پیدا می‌کند.`
        : status.completedAt ? 'پاک‌سازی کامل شد. برای شروع دوباره یک فضای جدید بسازید؛ کلید ورود حفظ شده است.' : 'عملیات سراسری و غیرقابل بازگشت است.';
      if (status.running) timer = setTimeout(refresh, 2500);
    } catch (error) {
      if (!error.stale && ui.state.authenticated) {
        $('#project-reset-status').textContent = 'وضعیت دریافت نشد؛ پاک‌سازی ثبت‌شده در سرور ادامه دارد. در حال تلاش دوباره…';
        timer = setTimeout(refresh, 5000);
      }
    } finally { loading = false; }
  }
  /** Wire a separate confirmation dialog; viewing settings never starts a reset. */
  function init(context) {
    ui = context;
    $('#open-project-reset').addEventListener('click', () => {
      $('#project-reset-confirmation').value = '';
      ui.showError('#project-reset-error', '');
      controls();
      $('#project-reset-dialog').showModal();
      $('#project-reset-confirmation').focus();
    });
    $('#cancel-project-reset').addEventListener('click', () => { if (!busy) $('#project-reset-dialog').close(); });
    $('#project-reset-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    $('#project-reset-confirmation').addEventListener('input', controls);
    $('#project-reset-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || $('#submit-project-reset').disabled) return;
      busy = true; controls();
      try {
        await ui.api('/api/admin/reset', {method:'POST', body:JSON.stringify({confirmation:'RESET ALL DATA'})});
        $('#project-reset-dialog').close();
        ui.toast('ریست ثبت شد؛ دسترسی‌ها بسته شدند و پاک‌سازی ادامه دارد.');
        await ui.reload();
        await refresh();
      } catch (error) { if (!error.stale) ui.showError('#project-reset-error', error.message); }
      finally { busy = false; controls(); }
    });
  }
  return {init, refresh};
})();
