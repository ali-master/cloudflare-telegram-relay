export const LEGACY_WELCOME_MESSAGE = 'به سامانه اعلان‌ها خوش آمدید. عضویت شما فعال شد. پیش‌فرض، اعلان همهٔ اپلیکیشن‌ها را دریافت می‌کنید. برای انتخاب اپلیکیشن‌ها /apps، دریافت همه /all و توقف اعلان‌ها /stop را ارسال کنید.';

export const DEFAULT_WELCOME_MESSAGE = [
  'به سامانهٔ اعلان‌ها خوش آمدید 👋',
  '✅ دریافت اعلان‌ها فعال است.',
  'در حالت پیش‌فرض، اعلان همهٔ اپلیکیشن‌های مجاز را دریافت می‌کنید.\nانتخاب‌های قبلی شما حفظ می‌شوند.',
  'برای مدیریت دریافت اعلان‌ها، از دکمه‌های زیر استفاده کنید.',
].join('\n\n');

export interface SubscriptionMenu {
  text: string;
  reply_markup: {
    inline_keyboard: Array<Array<{text: string; callback_data: string}>>;
  };
}

export function subscriptionMenu(welcome: string, active: boolean): SubscriptionMenu {
  if (!active) {
    return {
      text: [
        '⏸ دریافت اعلان‌ها متوقف شد.',
        'تا فعال‌سازی دوباره، اعلان تازه‌ای از این بات دریافت نمی‌کنید.\nانتخاب اپلیکیشن‌ها و تنظیمات شما حفظ می‌شوند.',
        'برای ادامه، دکمهٔ زیر را بزنید.',
      ].join('\n\n'),
      reply_markup: {
        inline_keyboard: [[{text: '▶️ فعال‌سازی دوباره', callback_data: 'menu:start'}]],
      },
    };
  }

  return {
    text: welcome,
    reply_markup: {
      inline_keyboard: [
        [
          {text: '🧩 انتخاب اپلیکیشن‌ها', callback_data: 'menu:apps'},
          {text: '⚙️ تنظیمات دریافت', callback_data: 'menu:preferences'},
        ],
        [{text: '📨 دریافت همهٔ اپلیکیشن‌های مجاز', callback_data: 'menu:all'}],
        [{text: '⏸ توقف اعلان‌ها', callback_data: 'menu:stop'}],
      ],
    },
  };
}
