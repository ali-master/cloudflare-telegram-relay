import {afterEach, describe, expect, it, vi} from 'vitest';
import {telegramCall, TelegramError} from '../src/telegram';

const token = '910020:fixture-token';
const privateDetail = `https://api.telegram.org/bot${token}/getMe private-upstream-diagnostic`;

async function failure(): Promise<TelegramError> {
  try {
    await telegramCall(token, 'getMe');
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramError);
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain('private-upstream-diagnostic');
    return error as TelegramError;
  }
  throw new Error('Expected a Telegram error.');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Telegram transport and safe diagnostics', () => {
  it('uses the Workers-supported manual redirect mode and accepts a realistic getMe response', async () => {
    const bot = {id: 910020, is_bot: true, first_name: 'Operations', username: 'operations_bot', can_join_groups: true};
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      result: bot
    })));
    expect(await telegramCall(token, 'getMe')).toEqual({ok: true, result: bot});
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://api.telegram.org/bot${token}/getMe`, expect.objectContaining({
      method: 'POST',
      redirect: 'manual',
      body: '{}',
      headers: {'Content-Type': 'application/json'},
      signal: expect.any(AbortSignal)
    }));
  });

  it('rejects redirects without following their Location or exposing it', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(privateDetail, {
      status: 302,
      headers: {Location: `https://other.example/${token}`}
    }));
    expect(await failure()).toMatchObject({code: 302, reason: 'invalid_response', uncertain: true});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('treats a confirmed unchanged-message edit as successful without exposing the raw diagnostic', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      ok: false, error_code: 400, description: `Bad Request: message is not modified: ${privateDetail}`,
    }), {status: 400}));
    const result = await telegramCall(token, 'editMessageText', {chat_id: 42, message_id: 123, rich_message: {blocks: []}});
    expect(result).toEqual({ok: true, result: {message_id: 123}});
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('private-upstream-diagnostic');
  });

  it.each([
    {method: 'sendRichMessage', messageId: 123, status: 400, description: 'Bad Request: message is not modified'},
    {method: 'editMessageText', messageId: 0, status: 400, description: 'Bad Request: message is not modified'},
    {method: 'editMessageText', messageId: '123', status: 400, description: 'Bad Request: message is not modified'},
    {method: 'editMessageText', messageId: Number.MAX_SAFE_INTEGER + 1, status: 400, description: 'Bad Request: message is not modified'},
    {method: 'editMessageText', messageId: 123, status: 403, description: 'Bad Request: message is not modified'},
    {method: 'editMessageText', messageId: 123, status: 400, description: 'Bad Request: message is not modified unexpectedly'},
    {method: 'editMessageText', messageId: 123, status: 400, description: 'Bad Request: message to edit not found'},
  ])('does not mistake other failures for an idempotent edit: $method / $messageId / $status / $description', async ({method, messageId, status, description}) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ok: false, error_code: status, description}), {status}));
    await expect(telegramCall(token, method, {chat_id: 42, message_id: messageId})).rejects.toMatchObject({code: status, uncertain: false, reason: 'rejected'});
  });

  it('keeps network errors safe and never retries inside the transport', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError(privateDetail));
    expect(await failure()).toMatchObject({code: 0, reason: 'network', uncertain: true});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'credentials rejection',
      status: 401,
      data: {ok: false, error_code: 401, description: privateDetail},
      reason: 'rejected',
      uncertain: false,
      retryAfter: undefined
    },
    {
      label: 'blocked chat',
      status: 403,
      data: {ok: false, error_code: 403, description: privateDetail},
      reason: 'rejected',
      uncertain: false,
      retryAfter: undefined
    },
    {
      label: 'bounded retry delay',
      status: 429,
      data: {ok: false, error_code: 429, description: privateDetail, parameters: {retry_after: 100_000}},
      reason: 'rate_limited',
      uncertain: false,
      retryAfter: 86_400
    },
    {
      label: 'rate limit without retry delay',
      status: 429,
      data: {ok: false, error_code: 429, description: privateDetail},
      reason: 'rate_limited',
      uncertain: false,
      retryAfter: undefined
    },
    {
      label: 'upstream server failure',
      status: 502,
      data: {description: privateDetail},
      reason: 'upstream_error',
      uncertain: true,
      retryAfter: undefined
    },
    {
      label: 'missing result',
      status: 200,
      data: {ok: true, description: privateDetail},
      reason: 'invalid_response',
      uncertain: true,
      retryAfter: undefined
    },
  ])('classifies $label without changing retry safety', async ({status, data, reason, uncertain, retryAfter}) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(data), {status}));
    expect(await failure()).toMatchObject({code: status, reason, uncertain, retryAfter});
  });

  it('classifies non-JSON responses without exposing response bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`<html>${privateDetail}</html>`));
    expect(await failure()).toMatchObject({code: 200, reason: 'invalid_response', uncertain: true});
  });

  it.each(['headers', 'body'])('identifies a deadline abort while waiting for %s', async phase => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = init!.signal!;
      if (phase === 'headers') return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(privateDetail)), {once: true}));
      const stream = new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(new Error(privateDetail)), {once: true});
        }
      });
      return new Response(stream);
    });
    const pending = failure();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await pending).toMatchObject({code: 0, reason: 'timeout', uncertain: true});
    expect(vi.getTimerCount()).toBe(0);
  });
});
