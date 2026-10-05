(() => {
  'use strict';

  const form = document.querySelector('#compose-form');
  const mode = document.querySelector('#compose-parse-mode');
  const content = document.querySelector('#compose-text');
  const hint = document.querySelector('#compose-content-hint');
  const counter = document.querySelector('#compose-content-count');
  const help = document.querySelector('#compose-html-help');
  const count = new Intl.NumberFormat('fa-IR');

  function update() {
    const html = mode.value === 'HTML';
    content.maxLength = html ? 12000 : 3000;
    content.dir = html ? 'ltr' : 'auto';
    content.classList.toggle('notification-html-source', html);
    content.placeholder = html ? '<p><b>Deployment completed</b></p>\n<p>Version <code>2.4.1</code> is healthy.</p>' : 'جزئیاتی که تیم باید بداند…';
    hint.textContent = html ? 'منبع HTML تا ۱۲۰۰۰ کاراکتر؛ متن پس از تبدیل تا ۳۰۰۰ کاراکتر. تگ‌های پشتیبانی‌شده در راهنما.' : 'تا ۳۰۰۰ کاراکتر؛ نشانه‌ها و تگ‌ها عیناً نمایش داده می‌شوند.';
    counter.textContent = `${count.format(content.value.length)} / ${count.format(content.maxLength)}`;
    content.setCustomValidity(content.value.length > content.maxLength ? 'متن از سقف قالب انتخاب‌شده طولانی‌تر است.' : '');
    help.hidden = !html;
    if (!html) help.open = false;
  }

  mode.addEventListener('change', update);
  content.addEventListener('input', update);
  form.addEventListener('reset', () => queueMicrotask(update));
  update();
})();
