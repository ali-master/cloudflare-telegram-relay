'use strict';

window.RelayBotCommands = (() => {
  let ui;
  let scope = '';
  let pending = false;
  let confirmed = null;
  const scopeKey = () => `${ui.state.epoch}:${ui.state.tenantId}:${ui.state.botId}:${ui.state.bot?.version || ''}`;
  const defaults = 'هنگام ذخیرهٔ توکن و ثبت وب‌هوک، فرمان‌ها خودکار ثبت می‌شوند. برای بات‌های قبلی از دکمهٔ روبه‌رو استفاده کنید.';

  function render() {
    if (!ui) return;
    const nextScope = scopeKey();
    if (scope !== nextScope) { scope = nextScope; confirmed = null; }
    const configured = Boolean(ui.state.bot?.configured ?? ui.state.status?.configured?.bot);
    const button = ui.$('#register-bot-commands');
    ui.busy(button, pending);
    button.disabled = pending || !ui.state.authenticated || !configured || ui.state.activeWrites > 0;
    button.querySelector('span').textContent = pending ? 'در حال ثبت فرمان‌ها…' : 'ثبت فرمان‌ها در تلگرام';
    const badge = ui.$('#bot-commands-badge');
    badge.className = `badge ${confirmed === null ? 'neutral' : 'success'}`;
    badge.textContent = confirmed === null ? '۷ فرمان' : `${ui.count(confirmed)} فرمان ثبت شد`;
    ui.$('#bot-commands-feedback').textContent = pending
      ? 'در حال به‌روزرسانی پیشنهادهای تلگرام برای همین بات…'
      : !configured ? 'ابتدا توکن این بات را ذخیره کنید تا فرمان‌ها در تلگرام ثبت شوند.'
      : confirmed === null ? defaults : `تلگرام ثبت ${ui.count(confirmed)} فرمان برای بات «${ui.state.bot?.name || ui.state.botId}» را تأیید کرد. برای دیدن پیشنهادها، در گفت‌وگوی بات / را بزنید.`;
  }

  async function sync() {
    if (pending || ui.state.activeWrites || !ui.state.authenticated || !(ui.state.bot?.configured ?? ui.state.status?.configured?.bot)) return;
    const stamp = scopeKey();
    const path = ui.tenantPath(`bots/${encodeURIComponent(ui.state.botId)}/commands`);
    pending = true;
    confirmed = null;
    render();
    try {
      const result = await ui.api(path, {method: 'POST'});
      if (!ui.state.authenticated || stamp !== scopeKey()) return;
      const commands = result.commands;
      confirmed = commands.length;
      ui.$('#bot-commands-list').replaceChildren(...commands.map(command => {
        const item = ui.node('li');
        const name = ui.node('code', '', `/${command.command}`);
        name.dir = 'ltr';
        const description = ui.node('span');
        const example = /^(.*?)(\/[a-z][a-z0-9_]*(?:\s+[\w/:.-]+)*)$/.exec(command.description);
        if (example) {
          const sample = ui.node('bdi', '', example[2]);
          sample.dir = 'ltr';
          description.append(document.createTextNode(example[1]), sample);
        } else description.textContent = command.description;
        item.append(name, description);
        return item;
      }));
      ui.toast(`${ui.count(confirmed)} فرمان در منوی تلگرام ثبت شد.`);
    } catch (error) {
      if (!error.stale && ui.state.authenticated && stamp === scopeKey()) ui.toast(error.message, true);
    } finally {
      pending = false;
      render();
    }
  }

  function init(context) {
    ui = context;
    ui.$('#register-bot-commands').addEventListener('click', sync);
    render();
  }
  return {init, render};
})();
