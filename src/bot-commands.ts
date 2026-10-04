export interface TelegramBotCommand {
  command: string;
  description: string;
}

/** The same catalog powers Telegram suggestions and the webhook command parser. */
export const TELEGRAM_BOT_COMMANDS = [
  {command: 'start', description: 'شروع دریافت اعلان‌ها و نمایش منوی اصلی'},
  {command: 'apps', description: 'انتخاب اپلیکیشن‌هایی که اعلانشان را دریافت می‌کنید'},
  {command: 'all', description: 'دریافت اعلان همهٔ اپلیکیشن‌های مجاز'},
  {command: 'preferences', description: 'تنظیمات دریافت اعلان‌ها'},
  {command: 'timezone', description: 'تنظیم منطقهٔ زمانی؛ نمونه: /timezone Asia/Tehran'},
  {command: 'quiet', description: 'تنظیم ساعات سکوت؛ نمونه: /quiet 22:00 08:00'},
  {command: 'stop', description: 'توقف دریافت اعلان‌ها'},
] as const satisfies readonly TelegramBotCommand[];

export type BotCommandName = typeof TELEGRAM_BOT_COMMANDS[number]['command'];
const commandNames = new Set<string>(TELEGRAM_BOT_COMMANDS.map(item => item.command));

export function parseBotCommand(text: string): {command: BotCommandName; argument: string} | null {
  const match = /^\/([a-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text);
  if (!match || !commandNames.has(match[1])) return null;
  return {command: match[1] as BotCommandName, argument: text.trim().split(/\s+/).slice(1).join(' ')};
}
