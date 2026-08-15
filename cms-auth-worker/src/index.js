/**
 * Sveltia CMS auth bridge: Google OAuth -> GitHub App installation token.
 *
 * Required secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_APP_ID,
 * GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID, ALLOWED_EMAILS,
 * ALLOWED_DOMAINS, STATE_SECRET.
 * Optional var: GITHUB_REPO (default jftochka/ortez-pro).
 */

import {
  applyCommitIdentity,
  emailsAllowlisted,
  genericErrorMessage,
  isAllowedHost,
  isAllowedOrigin,
  isGithubProxyPathAllowed,
  makePkce,
  mapWorkerGithubPath,
  originRequired,
  rateLimitDecision,
  signState,
  verifyState,
} from './security.js';
import { errorPage, successPage } from './pages.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GITHUB_API = 'https://api.github.com';
const EDITOR_LOGIN = 'cms-editor';
const DEFAULT_REPO = 'jftochka/ortez-pro';
const DEFAULT_COMMIT_NAME = 'jftochka';
const DEFAULT_COMMIT_EMAIL = '36163658+jftochka@users.noreply.github.com';
const AUTH_RATE_LIMIT = 20;
const AUTH_RATE_WINDOW_SEC = 300;
const PROXY_BODY_MAX = 2 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/auth') return await handleAuthInitiate(request, env);
      if (url.pathname === '/callback') return await handleCallback(request, env);
      if (url.pathname.startsWith('/github/') || url.pathname === '/github') {
        return await handleGithubProxy(request, env);
      }
      if (url.pathname === '/' || url.pathname === '') {
        return new Response('Sveltia CMS auth bridge OK', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(JSON.stringify({
        message: 'worker error',
        error: err && err.message ? err.message : String(err),
        path: url.pathname,
      }));
      return new Response(JSON.stringify({ error: genericErrorMessage() }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
      });
    }
  },
};

function configuredRepo(env) {
  return (env.GITHUB_REPO || DEFAULT_REPO).trim();
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowOrigin = originRequired(origin, env.ALLOWED_DOMAINS) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version, Accept, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': 'ETag, Link, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

async function consumeRateLimit(request, bucket) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const keyUrl = `https://rl.internal/${bucket}/${ip}`;
  const cache = caches.default;
  const hit = await cache.match(keyUrl);
  const prev = hit ? Number(await hit.text()) || 0 : 0;
  const decision = rateLimitDecision(prev, AUTH_RATE_LIMIT);
  if (!decision.allow) return false;
  const res = new Response(String(decision.next), {
    headers: { 'Cache-Control': `max-age=${AUTH_RATE_WINDOW_SEC}` },
  });
  await cache.put(keyUrl, res);
  return true;
}

async function handleGithubProxy(request, env) {
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const origin = request.headers.get('origin') || '';
  if (!originRequired(origin, env.ALLOWED_DOMAINS)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const auth = request.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) {
    return new Response(JSON.stringify({ error: 'Missing authorization' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const url = new URL(request.url);
  const ghPath = mapWorkerGithubPath(url.pathname);

  if (ghPath === '/user' || ghPath === '/user/') {
    const body = JSON.stringify({
      login: EDITOR_LOGIN,
      id: 0,
      node_id: 'BOT_kgDOAAAAAA',
      avatar_url: 'https://avatars.githubusercontent.com/u/0?v=4',
      html_url: 'https://github.com/jftochka',
      type: 'User',
      name: 'jftochka',
      email: DEFAULT_COMMIT_EMAIL,
      site_admin: false,
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
    });
  }

  const collabMatch = ghPath.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/?$/);
  if (collabMatch && collabMatch[1] === EDITOR_LOGIN) {
    return new Response(null, { status: 204, headers: cors });
  }

  const permMatch = ghPath.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission\/?$/);
  if (permMatch && permMatch[1] === EDITOR_LOGIN) {
    const body = JSON.stringify({
      permission: 'write',
      role_name: 'write',
      user: { login: EDITOR_LOGIN, id: 0, type: 'User', site_admin: false },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
    });
  }

  if (!isGithubProxyPathAllowed(ghPath, configuredRepo(env))) {
    return new Response(JSON.stringify({ error: 'Path not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const len = Number(request.headers.get('content-length') || 0);
  if (len > PROXY_BODY_MAX) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const upstreamHeaders = new Headers();
  upstreamHeaders.set('Authorization', auth);
  upstreamHeaders.set('Accept', request.headers.get('accept') || 'application/vnd.github+json');
  const ct = request.headers.get('content-type');
  if (ct) upstreamHeaders.set('Content-Type', ct);
  upstreamHeaders.set('X-GitHub-Api-Version', '2022-11-28');
  upstreamHeaders.set('User-Agent', 'sveltia-cms-auth-bridge');

  const init = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: 'manual',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > PROXY_BODY_MAX) {
      return new Response(JSON.stringify({ error: 'Payload too large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    const text = new TextDecoder().decode(buf);
    try {
      const parsed = JSON.parse(text);
      const stamped = applyCommitIdentity(
        parsed,
        env.COMMIT_AUTHOR_NAME || DEFAULT_COMMIT_NAME,
        env.COMMIT_AUTHOR_EMAIL || DEFAULT_COMMIT_EMAIL
      );
      init.body = JSON.stringify(stamped);
    } catch {
      init.body = buf;
    }
  }

  const upstreamRes = await fetch(`https://api.github.com${ghPath}${url.search}`, init);
  const resHeaders = new Headers(upstreamRes.headers);
  resHeaders.delete('content-encoding');
  resHeaders.delete('transfer-encoding');
  resHeaders.delete('content-length');
  for (const [k, v] of Object.entries(cors)) resHeaders.set(k, v);
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders,
  });
}

async function handleAuthInitiate(request, env) {
  if (!(await consumeRateLimit(request, 'auth'))) {
    return errorPage('Доступ заборонено', genericErrorMessage(), '');
  }
  if (!env.STATE_SECRET || !env.GOOGLE_CLIENT_ID || !env.ALLOWED_DOMAINS) {
    return errorPage('Помилка конфігурації', genericErrorMessage(), '');
  }

  const url = new URL(request.url);
  const siteId = (url.searchParams.get('site_id') || '').trim();
  const referrer = request.headers.get('referer') || '';
  let cmsOrigin = '';
  try {
    if (siteId && isAllowedHost(siteId, env.ALLOWED_DOMAINS)) {
      cmsOrigin = `https://${siteId}`;
    } else if (referrer) {
      const ref = new URL(referrer);
      if (isAllowedHost(ref.hostname, env.ALLOWED_DOMAINS)) cmsOrigin = ref.origin;
    }
  } catch {
    cmsOrigin = '';
  }
  if (!isAllowedOrigin(cmsOrigin, env.ALLOWED_DOMAINS)) {
    return errorPage('Доступ заборонено', genericErrorMessage(), '');
  }

  const pkce = await makePkce();
  const state = await signState(env.STATE_SECRET, {
    nonce: crypto.randomUUID(),
    origin: cmsOrigin,
    cv: pkce.verifier,
  });

  const googleAuthUrl = new URL(GOOGLE_AUTH_URL);
  googleAuthUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  googleAuthUrl.searchParams.set('redirect_uri', `${url.origin}/callback`);
  googleAuthUrl.searchParams.set('response_type', 'code');
  googleAuthUrl.searchParams.set('scope', 'openid email profile');
  googleAuthUrl.searchParams.set('state', state);
  googleAuthUrl.searchParams.set('access_type', 'online');
  googleAuthUrl.searchParams.set('prompt', 'select_account');
  googleAuthUrl.searchParams.set('code_challenge', pkce.challenge);
  googleAuthUrl.searchParams.set('code_challenge_method', 'S256');
  return Response.redirect(googleAuthUrl.toString(), 302);
}

async function handleCallback(request, env) {
  if (!(await consumeRateLimit(request, 'callback'))) {
    return errorPage('Доступ заборонено', genericErrorMessage(), '');
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  if (url.searchParams.get('error') || !code) {
    return errorPage('Помилка', genericErrorMessage(), '');
  }

  const state = await verifyState(env.STATE_SECRET, stateParam || '', 600);
  if (!state || !isAllowedOrigin(state.origin, env.ALLOWED_DOMAINS) || !state.cv) {
    return errorPage('Помилка', genericErrorMessage(), '');
  }
  const cmsOrigin = state.origin;

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/callback`,
      grant_type: 'authorization_code',
      code_verifier: state.cv,
    }),
  });
  if (!tokenRes.ok) {
    console.error(JSON.stringify({ message: 'google token exchange failed', status: tokenRes.status }));
    return errorPage('Помилка', genericErrorMessage(), cmsOrigin);
  }
  const tokens = await tokenRes.json();
  const idToken = tokens.id_token;
  if (!idToken) return errorPage('Помилка', genericErrorMessage(), cmsOrigin);

  const claims = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);
  if (!claims || !claims.email_verified) {
    return errorPage('Доступ заборонено', genericErrorMessage(), cmsOrigin);
  }
  const email = String(claims.email || '').toLowerCase();
  if (!(await emailsAllowlisted(email, env.ALLOWED_EMAILS))) {
    return errorPage('Доступ заборонено', genericErrorMessage(), cmsOrigin);
  }

  let githubToken;
  try {
    githubToken = await getGithubAppInstallationToken(env);
  } catch (err) {
    console.error(JSON.stringify({ message: 'github app token failed', error: String(err && err.message || err) }));
    return errorPage('Помилка', genericErrorMessage(), cmsOrigin);
  }
  if (!githubToken) return errorPage('Помилка', genericErrorMessage(), cmsOrigin);
  return successPage(githubToken, email, cmsOrigin);
}

async function verifyGoogleIdToken(idToken, expectedAudience) {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try {
    header = JSON.parse(base64UrlDecodeText(headerB64));
    payload = JSON.parse(base64UrlDecodeText(payloadB64));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const jwksRes = await fetch(GOOGLE_JWKS_URL);
  if (!jwksRes.ok) return null;
  const { keys } = await jwksRes.json();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecodeBytes(sigB64), data);
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;
  if (payload.iat && payload.iat > now + 300) return null;
  if (payload.aud !== expectedAudience) return null;
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return null;
  return payload;
}

async function getGithubAppInstallationToken(env) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
    throw new Error('GitHub App secrets not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const headerB64 = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncode(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(env.GITHUB_APP_ID),
  }));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await importRsaPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(sigBuf))}`;

  const res = await fetch(
    `${GITHUB_API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sveltia-cms-auth-bridge',
      },
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub /access_tokens failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.token;
}

async function importRsaPrivateKey(pem) {
  const cleaned = String(pem).replace(/\\n/g, '\n');
  let pkcs8Pem = cleaned;
  if (cleaned.includes('BEGIN RSA PRIVATE KEY')) {
    pkcs8Pem = await pkcs1ToPkcs8(cleaned);
  }
  const body = pkcs8Pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(body);
  return crypto.subtle.importKey(
    'pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

async function pkcs1ToPkcs8(pkcs1Pem) {
  const body = pkcs1Pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
    .replace(/-----END RSA PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const pkcs1 = base64ToBytes(body);
  const rsaOid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octetStringHeader = derLengthHeader(0x04, pkcs1.length);
  const innerLen = version.length + rsaOid.length + octetStringHeader.length + pkcs1.length;
  const seqHeader = derLengthHeader(0x30, innerLen);
  const total = new Uint8Array(seqHeader.length + innerLen);
  let off = 0;
  total.set(seqHeader, off); off += seqHeader.length;
  total.set(version, off); off += version.length;
  total.set(rsaOid, off); off += rsaOid.length;
  total.set(octetStringHeader, off); off += octetStringHeader.length;
  total.set(pkcs1, off);
  const b64 = bytesToBase64(total);
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

function derLengthHeader(tag, length) {
  if (length < 0x80) return new Uint8Array([tag, length]);
  if (length < 0x100) return new Uint8Array([tag, 0x81, length]);
  if (length < 0x10000) return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
  return new Uint8Array([tag, 0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function base64UrlEncode(s) {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlEncodeBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecodeText(s) {
  return decodeURIComponent(escape(atob(padBase64(s.replace(/-/g, '+').replace(/_/g, '/')))));
}
function base64UrlDecodeBytes(s) {
  return base64ToBytes(padBase64(s.replace(/-/g, '+').replace(/_/g, '/'))).buffer;
}
function padBase64(s) {
  return s + (s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '');
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
