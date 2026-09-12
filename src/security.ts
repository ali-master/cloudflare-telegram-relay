import ipaddr from 'ipaddr.js';
import { AppError, type Settings, type SourceContext } from './types';

const encoder = new TextEncoder();
export async function equalSecret(actual: string, expected?: string): Promise<boolean> {
  if (!expected || !actual || actual.length > 1024) return false;
  const [a, b] = await Promise.all([actual, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
async function sessionKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
export async function createSession(secret: string): Promise<string> {
  const payload = `${Date.now() + 8 * 60 * 60 * 1000}.${crypto.randomUUID()}`;
  const signature = await crypto.subtle.sign('HMAC', await sessionKey(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}
export async function verifySession(token: string | undefined, secret: string): Promise<boolean> {
  if (!secret || !token || token.length > 256) return false;
  const [expiry, nonce, signature, extra] = token.split('.');
  if (extra || !signature || !nonce || !/^\d+$/.test(expiry)) return false;
  if (+expiry <= Date.now() || +expiry > Date.now() + 8 * 3600_000) return false;
  try {
    const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', await sessionKey(secret), bytes, encoder.encode(`${expiry}.${nonce}`));
  } catch { return false; }
}
export function sourceContext(request: Request, source = 'api'): SourceContext {
  // Only Cloudflare's request metadata authorizes trusting its injected IP header.
  const cf = request.cf;
  return {
    ip: cf ? request.headers.get('CF-Connecting-IP') || 'unknown' : '127.0.0.1',
    country: cf && typeof cf.country === 'string' ? cf.country.toUpperCase() : 'XX', source,
  };
}
export function validIpRule(rule: string): boolean {
  try { rule.includes('/') ? ipaddr.parseCIDR(rule) : ipaddr.parse(rule); return true; } catch { return false; }
}
export function matchesIp(ip: string, rule: string): boolean {
  try {
    let address = ipaddr.process(ip);
    let [network, bits] = rule.includes('/') ? ipaddr.parseCIDR(rule) : [ipaddr.parse(rule), null];
    if (network.kind() === 'ipv6' && (network as ipaddr.IPv6).isIPv4MappedAddress()) {
      if (bits !== null && bits < 96) return false;
      network = (network as ipaddr.IPv6).toIPv4Address();
      if (bits !== null) bits -= 96;
    }
    if (address.kind() !== network.kind()) return false;
    if (bits === null) bits = network.kind() === 'ipv4' ? 32 : 128;
    return address.match(network, bits);
  } catch { return false; }
}
export function checkAccess(settings: Settings, context: SourceContext): void {
  if (settings.ipMode !== 'off') {
    const match = settings.ipRules.some(rule => matchesIp(context.ip, rule));
    if ((settings.ipMode === 'allow' && !match) || (settings.ipMode === 'deny' && match))
      throw new AppError(403, 'IP_BLOCKED', 'این IP اجازه ارسال اعلان ندارد.');
  }
  if (settings.countryMode !== 'off') {
    // Missing geolocation is not allowed to bypass an enabled country policy.
    const match = settings.countries.includes(context.country);
    if (!/^[A-Z]{2}$/.test(context.country) || ['XX', 'T1'].includes(context.country) ||
        (settings.countryMode === 'allow' && !match) || (settings.countryMode === 'deny' && match))
      throw new AppError(403, 'COUNTRY_BLOCKED', 'کشور این درخواست مجاز نیست یا قابل تشخیص نیست.');
  }
}
