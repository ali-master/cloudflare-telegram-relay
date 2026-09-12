import type { NotificationInput, SourceContext } from './types';

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly uncertain = false,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface TelegramResponse<T = Record<string, unknown>> { ok: true; result: T }

/** Never propagate fetch errors or raw Telegram descriptions: either can contain secrets. */
export async function telegramCall<T = Record<string, unknown>>(
  botToken: string,
  method: string,
  payload: Record<string, unknown> = {},
): Promise<TelegramResponse<T>> {
  if (!botToken) throw new TelegramError('Telegram bot token is not configured.', 503);
  if (!/^[A-Za-z]+$/.test(method)) throw new TelegramError('Invalid Telegram method.', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
      redirect: 'error',
    });
    if (response.status >= 500) throw new TelegramError('Telegram response is uncertain (server error).', response.status, true);
    let data: { ok?: unknown; result?: T; error_code?: unknown; parameters?: { retry_after?: unknown } };
    try { data = await response.json() as typeof data; }
    catch { throw new TelegramError('Telegram response is uncertain (invalid response).', response.status, true); }
    if (response.ok && data?.ok === true && data.result !== undefined) return { ok: true, result: data.result };
    const code = typeof data?.error_code === 'number' ? data.error_code : response.status;
    const retry = data?.parameters?.retry_after;
    if (code === 429 && typeof retry === 'number' && Number.isFinite(retry) && retry > 0) {
      throw new TelegramError('Telegram rate limit; delivery will retry after its cooldown.', 429, false, Math.min(Math.ceil(retry), 86_400));
    }
    if (code >= 500) throw new TelegramError('Telegram response is uncertain (server error).', code, true);
    const message = code === 403 ? 'Bot blocked or access to this chat was revoked.'
      : code === 401 ? 'Telegram rejected the bot credentials.'
      : code === 429 ? 'Telegram rate limit without a valid retry delay.'
      : 'Telegram rejected the request. Check the chat and message or image.';
    if (data?.ok !== false) throw new TelegramError('Telegram response is uncertain (unexpected response).', code, true);
    throw new TelegramError(message, code);
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    throw new TelegramError('Telegram response is uncertain (timeout or network failure).', 0, true);
  } finally { clearTimeout(timer); }
}

const LEVEL_LABELS = { info: 'ℹ️ INFO', success: '✅ SUCCESS', warning: '⚠️ WARNING', error: '🔴 ERROR', critical: '🚨 CRITICAL' } as const;

export function countryFlag(country: string): string {
  if (!/^[A-Z]{2}$/.test(country) || ['XX', 'T1'].includes(country)) return '';
  return [...country].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
}

/** Plain text prevents application-controlled fields from becoming Telegram formatting. */
export function formatNotification(input: NotificationInput, source?: SourceContext, showCountryFlag = false): string {
  const lines = [
    `${LEVEL_LABELS[input.level]} · ${input.application}`,
    ...(input.title ? [input.title] : []),
    `Event: ${input.event}`,
    ...(input.environment ? [`Environment: ${input.environment}`] : []),
    `Time: ${input.timestamp}`,
    ...(showCountryFlag && source && countryFlag(source.country) ? [`Origin: ${countryFlag(source.country)} ${source.country}`] : []),
    '', input.text,
  ];
  if (input.metadata && Object.keys(input.metadata).length) {
    lines.push('', ...Object.entries(input.metadata).map(([key, value]) => `${key}: ${value}`));
  }
  if (input.tags?.length) lines.push('', `Tags: ${input.tags.join(', ')}`);
  if (input.url) lines.push('', input.url);
  return lines.join('\n');
}
