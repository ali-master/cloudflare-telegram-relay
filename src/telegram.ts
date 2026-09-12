export { countryFlag, formatNotification, formatRichNotification } from './rich-message';
export type { InputRichMessage } from './rich-message';

export type TelegramErrorReason = 'timeout' | 'network' | 'invalid_response' | 'upstream_error' | 'rate_limited' | 'rejected';

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly uncertain = false,
    public readonly retryAfter?: number,
    public readonly reason?: TelegramErrorReason,
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
  if (!botToken) throw new TelegramError('Telegram bot token is not configured.', 503, false, undefined, 'rejected');
  if (!/^[A-Za-z]+$/.test(method)) throw new TelegramError('Invalid Telegram method.', 400, false, undefined, 'rejected');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
      // workerd supports manual/follow only. Reject redirects explicitly to keep the bot token on this origin.
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) throw new TelegramError('Telegram response is uncertain (unexpected redirect).', response.status, true, undefined, 'invalid_response');
    if (response.status >= 500) throw new TelegramError('Telegram response is uncertain (server error).', response.status, true, undefined, 'upstream_error');
    let data: { ok?: unknown; result?: T; error_code?: unknown; parameters?: { retry_after?: unknown } };
    try { data = await response.json() as typeof data; }
    catch {
      if (controller.signal.aborted) throw new TelegramError('Telegram response is uncertain (timeout).', 0, true, undefined, 'timeout');
      throw new TelegramError('Telegram response is uncertain (invalid response).', response.status, true, undefined, 'invalid_response');
    }
    if (response.ok && data?.ok === true && data.result !== undefined) return { ok: true, result: data.result };
    const code = typeof data?.error_code === 'number' ? data.error_code : response.status;
    const retry = data?.parameters?.retry_after;
    if (code === 429 && typeof retry === 'number' && Number.isFinite(retry) && retry > 0) {
      throw new TelegramError('Telegram rate limit; delivery will retry after its cooldown.', 429, false, Math.min(Math.ceil(retry), 86_400), 'rate_limited');
    }
    if (code >= 500) throw new TelegramError('Telegram response is uncertain (server error).', code, true, undefined, 'upstream_error');
    const message = code === 403 ? 'Bot blocked or access to this chat was revoked.'
      : code === 401 ? 'Telegram rejected the bot credentials.'
      : code === 429 ? 'Telegram rate limit without a valid retry delay.'
      : 'Telegram rejected the request. Check the chat and message or image.';
    if (data?.ok !== false) throw new TelegramError('Telegram response is uncertain (unexpected response).', code, true, undefined, 'invalid_response');
    throw new TelegramError(message, code, false, undefined, code === 429 ? 'rate_limited' : 'rejected');
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    if (controller.signal.aborted) throw new TelegramError('Telegram response is uncertain (timeout).', 0, true, undefined, 'timeout');
    throw new TelegramError('Telegram response is uncertain (network failure).', 0, true, undefined, 'network');
  } finally { clearTimeout(timer); }
}
