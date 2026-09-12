import {describe, expect, it, vi} from 'vitest';
import {contentSecurityPolicy, dashboardAsset} from '../src/browser-security';

const origin = 'https://relay.test';
const shell = '<!doctype html><html><head><script src="/theme.js"></script><script src="/selects.js" defer></script><script src="/app.js" defer></script></head><body><h1>Relay</h1></body></html>';
const assetHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'",
  'Cache-Control': 'public, max-age=3600',
  ETag: '"shell-v1"',
  'Last-Modified': 'Sat, 12 Sep 2026 00:00:00 GMT',
  'Content-Length': String(shell.length),
  'X-Content-Type-Options': 'nosniff',
};
const fixtureAssets = (body = shell, headers: HeadersInit = assetHeaders) => ({fetch: vi.fn(async () => new Response(body, {headers}))}) as unknown as Fetcher;
const nonceOf = (response: Response) => response.headers.get('Content-Security-Policy')?.match(/'nonce-([^']+)'/)?.[1];

describe('dashboard browser security', () => {
  it('uses fresh response nonces that match all owned script tags', async () => {
    const assets = fixtureAssets();
    const first = await dashboardAsset(new Request(`${origin}/`), assets);
    const second = await dashboardAsset(new Request(`${origin}/index.html`), assets);
    const firstNonce = nonceOf(first)!;
    const secondNonce = nonceOf(second)!;
    expect(atob(firstNonce).length).toBeGreaterThanOrEqual(16);
    expect(secondNonce).not.toBe(firstNonce);
    for (const [response, nonce] of [[first, firstNonce], [second, secondNonce]] as const) {
      const body = await response.text();
      expect(body).toContain('<h1>Relay</h1>');
      expect([...body.matchAll(/nonce="([^"]+)"/g)].map(match => match[1])).toEqual([nonce, nonce, nonce]);
      expect(response.headers.get('Content-Security-Policy')).toBe(contentSecurityPolicy(nonce));
    }
  });

  it('does not authorize inline, unknown, or foreign scripts with the trusted nonce', async () => {
    const body = shell.replace('</head>', '<script>untrusted()</script><script src="/other.js"></script><script src="https://evil.test/app.js"></script><script src="//evil.test/theme.js"></script></head>');
    const response = await dashboardAsset(new Request(origin), fixtureAssets(body));
    const output = await response.text();
    expect(output).toContain('<script>untrusted()</script>');
    expect(output).toContain('<script src="/other.js"></script>');
    expect(output).toContain('<script src="https://evil.test/app.js"></script>');
    expect(output).toContain('<script src="//evil.test/theme.js"></script>');
    expect([...output.matchAll(/nonce="/g)]).toHaveLength(3);
  });

  it('requests a complete shell despite browser validators and prevents nonce caching', async () => {
    const request = new Request(origin, {
      headers: {
        'If-None-Match': '"shell-v1"', 'If-Modified-Since': assetHeaders['Last-Modified'],
        Range: 'bytes=0-99', 'If-Range': '"shell-v1"', 'Accept-Language': 'fa',
      }
    });
    let observed: Request | undefined;
    const assets = {
      fetch: async (input: Request) => {
        observed = input;
        return input.headers.has('If-None-Match') ? new Response(null, {status: 304}) : new Response(shell, {headers: assetHeaders});
      }
    } as unknown as Fetcher;
    const response = await dashboardAsset(request, assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>Relay</h1>');
    for (const name of ['If-None-Match', 'If-Modified-Since', 'Range', 'If-Range']) expect(observed!.headers.has(name)).toBe(false);
    expect(observed!.headers.get('Accept-Language')).toBe('fa');
    expect(request.headers.get('If-None-Match')).toBe('"shell-v1"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    for (const name of ['ETag', 'Last-Modified', 'Content-Length']) expect(response.headers.has(name)).toBe(false);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).not.toContain(',');
  });

  it('passes through non-HTML assets and non-success responses unchanged', async () => {
    for (const asset of [
      new Response('body { color: red; }', {
        headers: {
          'Content-Type': 'text/css',
          ETag: '"css-v1"',
          'Cache-Control': 'public, max-age=3600'
        }
      }),
      new Response('<h1>Missing</h1>', {status: 404, headers: {'Content-Type': 'text/html'}}),
      new Response(null, {status: 302, headers: {Location: '/'}}),
    ]) {
      const response = await dashboardAsset(new Request(`${origin}/app.css`), {fetch: async () => asset} as unknown as Fetcher);
      expect(response).toBe(asset);
      expect(nonceOf(response)).toBeUndefined();
      await response.arrayBuffer();
    }
  });

  it('permits the Cloudflare beacon without inline execution, eval, broad origins, or objects', () => {
    const policy = contentSecurityPolicy();
    expect(policy).toContain("script-src 'self' https://static.cloudflareinsights.com");
    expect(policy).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|nonce-|sha256-|\*/);
    expect(policy.split('; ').find(part => part.startsWith('script-src'))).not.toMatch(/(?:^|\s)https:(?:\s|$)/);
  });
});
