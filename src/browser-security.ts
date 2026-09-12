const dashboardScripts = new Set(['/theme.js', '/selects.js', '/app.js']);

export function contentSecurityPolicy(nonce?: string): string {
  return [
    "default-src 'self'",
    `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''} https://static.cloudflareinsights.com`,
    "style-src 'self'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' https://cloudflareinsights.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** Serve the trusted dashboard shell with a fresh nonce that Cloudflare can reuse for injected scripts. */
export async function dashboardAsset(request: Request, assets: Fetcher): Promise<Response> {
  const assetRequest = new Request(request);
  // A cached or partial shell cannot safely share a newly generated response nonce.
  for (const name of ['If-None-Match', 'If-Modified-Since', 'Range', 'If-Range']) assetRequest.headers.delete(name);
  const asset = await assets.fetch(assetRequest);
  if (asset.status !== 200 || asset.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/html') return asset;

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
  const headers = new Headers(asset.headers);
  // Replace the static asset policy: a second stricter CSP would still block the nonce.
  headers.set('Content-Security-Policy', contentSecurityPolicy(nonce));
  headers.set('Cache-Control', 'no-store');
  for (const name of ['ETag', 'Last-Modified', 'Content-Length']) headers.delete(name);
  const shell = new Response(asset.body, {status: asset.status, statusText: asset.statusText, headers});
  return new HTMLRewriter().on('script[src]', {
    element(element) {
      // Only our bundled entry points receive a nonce; never authorize arbitrary inline content.
      if (dashboardScripts.has(element.getAttribute('src') ?? '')) element.setAttribute('nonce', nonce);
    },
  }).transform(shell);
}
