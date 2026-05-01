/**
 * Sveltia CMS auth bridge: Google OAuth -> GitHub App installation token.
 *
 * Flow:
 *   1. CMS opens popup at /auth?provider=github&...
 *   2. Worker redirects popup to Google OAuth (consent + login)
 *   3. Google redirects back to /callback?code=...
 *   4. Worker exchanges code for Google ID token
 *   5. Worker verifies ID token signature against Google's JWKS
 *   6. Worker checks email is in ALLOWED_EMAILS allowlist
 *   7. Worker generates GitHub App installation token (RS256 JWT -> /app/installations/.../access_tokens)
 *   8. Worker returns HTML that postMessages the GitHub token back to the CMS opener
 *
 * Required Cloudflare Worker environment variables (set as secrets):
 *   GOOGLE_CLIENT_ID            - from console.cloud.google.com OAuth client
 *   GOOGLE_CLIENT_SECRET        - from console.cloud.google.com OAuth client
 *   GITHUB_APP_ID               - from github.com/settings/apps/<your-app>
 *   GITHUB_APP_PRIVATE_KEY      - PEM-format private key (multi-line ok)
 *   GITHUB_APP_INSTALLATION_ID  - the installation ID for the repo
 *   ALLOWED_EMAILS              - comma-separated allowlist (e.g. "owner@gmail.com,manager@gmail.com")
 *   ALLOWED_DOMAINS             - comma-separated origins that may use this worker
 *                                 (e.g. "ortez.com.ua,localhost,127.0.0.1")
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GITHUB_API = 'https://api.github.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/auth') return await handleAuthInitiate(request, env);
      if (url.pathname === '/callback') return await handleCallback(request, env);
      if (url.pathname.startsWith('/github/') || url.pathname === '/github') {
        return await handleGithubProxy(request, env);
      }
      if (url.pathname === '/' || url.pathname === '') return new Response('Sveltia CMS auth bridge OK', { status: 200 });
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('Worker error:', err && err.stack || err);
      return new Response(JSON.stringify({ error: String(err && err.message || err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
      });
    }
  },
};

// ─── GitHub API proxy ────────────────────────────────────────────────────────
// Sveltia/Decap CMS calls api.github.com directly using the token we issued.
// GitHub App *installation* tokens cannot access /user (it is user-scoped),
// so we proxy via this endpoint:
//   - /github/user           -> synthetic bot identity (no upstream call)
//   - /github/<rest>         -> forwarded to api.github.com/<rest>
// CORS is enforced -- only allowlisted CMS origins may use this proxy.
async function handleGithubProxy(request, env) {
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Block calls from origins not in ALLOWED_DOMAINS
  const origin = request.headers.get('origin') || '';
  const originHost = (() => { try { return new URL(origin).hostname; } catch { return ''; } })();
  if (originHost && !isAllowedHost(originHost, env.ALLOWED_DOMAINS)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const url = new URL(request.url);
  const ghPath = url.pathname.replace(/^\/github/, '') || '/';

  // Synthetic /user endpoint -- installation tokens can't reach this on GitHub
  if (ghPath === '/user' || ghPath === '/user/') {
    const body = JSON.stringify({
      login: 'ortez-pro-cms-bot',
      id: 0,
      node_id: 'BOT_kgDOAAAAAA',
      avatar_url: 'https://avatars.githubusercontent.com/u/0?v=4',
      html_url: 'https://github.com/apps/ortez-pro-cms-bot',
      type: 'Bot',
      name: 'Ortez-Pro CMS',
      email: null,
      site_admin: false,
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
    });
  }

  // Forward everything else to api.github.com
  const upstreamUrl = `https://api.github.com${ghPath}${url.search}`;
  const upstreamHeaders = new Headers();
  const auth = request.headers.get('authorization');
  if (auth) upstreamHeaders.set('Authorization', auth);
  upstreamHeaders.set(
    'Accept',
    request.headers.get('accept') || 'application/vnd.github+json'
  );
  const ct = request.headers.get('content-type');
  if (ct) upstreamHeaders.set('Content-Type', ct);
  upstreamHeaders.set('X-GitHub-Api-Version', '2022-11-28');
  upstreamHeaders.set('User-Agent', 'sveltia-cms-auth-bridge');

  const init = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: 'follow',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  const upstreamRes = await fetch(upstreamUrl, init);
  const resHeaders = new Headers(upstreamRes.headers);
  // Strip headers that don't make sense to pass through
  resHeaders.delete('content-encoding');
  resHeaders.delete('transfer-encoding');
  resHeaders.delete('content-length');
  // Always add CORS so the browser accepts the response
  for (const [k, v] of Object.entries(cors)) resHeaders.set(k, v);

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders,
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const originHost = (() => { try { return new URL(origin).hostname; } catch { return ''; } })();
  const allowOrigin = (originHost && isAllowedHost(originHost, env.ALLOWED_DOMAINS)) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version, Accept, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': 'ETag, Link, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ─── Step 1: redirect popup to Google ────────────────────────────────────────
async function handleAuthInitiate(request, env) {
  const url = new URL(request.url);

  // Sveltia/Decap CMS sends `site_id` query param with the hostname.
  // Modern browsers may strip Referer on cross-origin popup navigations,
  // so site_id is the canonical signal. Fall back to Referer for safety.
  const siteId = (url.searchParams.get('site_id') || '').trim();
  const referrer = request.headers.get('referer') || '';

  let cmsOrigin = '';
  let detectedHost = '';
  if (siteId && isAllowedHost(siteId, env.ALLOWED_DOMAINS)) {
    cmsOrigin = `https://${siteId}`;
    detectedHost = siteId;
  } else if (isAllowedReferrer(referrer, env.ALLOWED_DOMAINS)) {
    cmsOrigin = refOrigin(referrer);
    detectedHost = refHost(referrer);
  } else {
    detectedHost = siteId || refHost(referrer) || 'невідомий';
    return errorPage('Доступ заборонено', `Домен (${detectedHost}) не в списку дозволених.`);
  }

  const state = base64UrlEncode(JSON.stringify({
    nonce: crypto.randomUUID(),
    origin: cmsOrigin,
  }));

  const googleAuthUrl = new URL(GOOGLE_AUTH_URL);
  googleAuthUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  googleAuthUrl.searchParams.set('redirect_uri', `${url.origin}/callback`);
  googleAuthUrl.searchParams.set('response_type', 'code');
  googleAuthUrl.searchParams.set('scope', 'openid email profile');
  googleAuthUrl.searchParams.set('state', state);
  googleAuthUrl.searchParams.set('access_type', 'online');
  googleAuthUrl.searchParams.set('prompt', 'select_account');

  return Response.redirect(googleAuthUrl.toString(), 302);
}

// ─── Step 2: receive Google code, validate, mint GitHub token ───────────────
async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) return errorPage('Google OAuth помилка', errorParam);
  if (!code) return errorPage('Помилка', 'Не отримано code від Google.');

  let state;
  try {
    state = JSON.parse(base64UrlDecodeText(stateParam || ''));
  } catch {
    return errorPage('Помилка', 'Невірний state параметр.');
  }
  const cmsOrigin = state.origin || '';

  // Exchange code -> tokens (must use exact same redirect_uri)
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    return errorPage('Помилка обміну токена з Google', await tokenRes.text());
  }
  const tokens = await tokenRes.json();
  const idToken = tokens.id_token;
  if (!idToken) return errorPage('Помилка', 'Google не повернув id_token.');

  // Verify ID token signature + claims
  const claims = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);
  if (!claims) return errorPage('Помилка', 'Не вдалося верифікувати Google ID токен.');
  if (!claims.email_verified) return errorPage('Доступ заборонено', 'Email не верифіковано в Google.');

  const email = String(claims.email || '').toLowerCase();
  const allowed = (env.ALLOWED_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email)) {
    return errorPage('Доступ заборонено', `Email ${email} не має дозволу на вхід.`, cmsOrigin);
  }

  // Mint a GitHub App installation token
  let githubToken;
  try {
    githubToken = await getGithubAppInstallationToken(env);
  } catch (err) {
    return errorPage('Помилка GitHub App', String(err.message || err));
  }
  if (!githubToken) {
    return errorPage('Помилка GitHub App', 'Не вдалося отримати installation token.');
  }

  return successPage(githubToken, email, cmsOrigin);
}

// ─── Google ID Token verification (RS256 JWT) ────────────────────────────────
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

  const jwksRes = await fetch(GOOGLE_JWKS_URL);
  if (!jwksRes.ok) return null;
  const { keys } = await jwksRes.json();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = base64UrlDecodeBytes(sigB64);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;
  if (payload.iat && payload.iat > now + 300) return null; // sanity
  if (payload.aud !== expectedAudience) return null;
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return null;

  return payload;
}

// ─── GitHub App: sign JWT, exchange for installation token ───────────────────
async function getGithubAppInstallationToken(env) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
    throw new Error('GitHub App secrets not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: 'RS256', typ: 'JWT' };
  const jwtPayload = {
    iat: now - 60,        // 1 min in past for clock skew
    exp: now + 9 * 60,    // GitHub allows up to 10 min, use 9 for safety
    iss: String(env.GITHUB_APP_ID),
  };

  const headerB64 = base64UrlEncode(JSON.stringify(jwtHeader));
  const payloadB64 = base64UrlEncode(JSON.stringify(jwtPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importRsaPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)
  );
  const sigB64 = base64UrlEncodeBytes(new Uint8Array(sigBuf));
  const jwt = `${signingInput}.${sigB64}`;

  const res = await fetch(
    `${GITHUB_API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
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
  // Accept both literal newlines and "\n" escaped
  const cleaned = String(pem).replace(/\\n/g, '\n');

  // Convert PKCS#1 (BEGIN RSA PRIVATE KEY) to PKCS#8 if needed
  let pkcs8Pem = cleaned;
  if (cleaned.includes('BEGIN RSA PRIVATE KEY')) {
    // GitHub gives PKCS#1; Web Crypto only supports PKCS#8.
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

// Wrap PKCS#1 RSA private key in a minimal PKCS#8 envelope so Web Crypto accepts it.
async function pkcs1ToPkcs8(pkcs1Pem) {
  const body = pkcs1Pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
    .replace(/-----END RSA PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const pkcs1 = base64ToBytes(body);

  // PKCS#8: SEQUENCE { version (0), AlgorithmIdentifier (rsaEncryption), OCTET STRING (PKCS#1) }
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

// ─── Helpers: origin allowlist ───────────────────────────────────────────────
function refHost(ref) { try { return new URL(ref).hostname; } catch { return ''; } }
function refOrigin(ref) { try { return new URL(ref).origin; } catch { return ''; } }
function isAllowedHost(host, allowedDomains) {
  if (!host) return false;
  const allowed = (allowedDomains || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.some(rule => {
    if (rule.startsWith('*.')) {
      const base = rule.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    return host === rule;
  });
}
function isAllowedReferrer(ref, allowedDomains) {
  return isAllowedHost(refHost(ref), allowedDomains);
}

// ─── Helpers: base64/utf8 ────────────────────────────────────────────────────
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

// ─── HTML response helpers ───────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Posts the GitHub token back to the opener (Sveltia CMS).
// Sveltia handshake protocol:
//   1. Opener listens for "authorizing:github" from popup
//   2. Popup posts "authorizing:github" on load
//   3. Opener echoes back "authorizing:github"
//   4. Popup posts final "authorization:github:success:{json}"
// Sveltia expects payload shape { token, refreshToken? }.
// Decap CMS uses { token, provider } -- we include both for compatibility.
function successPage(githubToken, email, cmsOrigin) {
  const payload = JSON.stringify({ token: githubToken, provider: 'github' });
  const message = `authorization:github:success:${payload}`;
  const targetOrigin = cmsOrigin || '*';
  const html = `<!DOCTYPE html>
<html lang="uk"><head>
<meta charset="utf-8">
<title>Авторизація успішна</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:40px;}</style>
</head><body>
<h2>Авторизація успішна</h2>
<p>Користувач: <strong>${escapeHtml(email)}</strong></p>
<p>Це вікно закриється автоматично...</p>
<script>
(function(){
  var msg = ${JSON.stringify(message)};
  var target = ${JSON.stringify(targetOrigin)};
  function send(){
    if (window.opener) {
      try { window.opener.postMessage(msg, target); } catch(e){}
      try { window.opener.postMessage(msg, '*'); } catch(e){}
      setTimeout(function(){ window.close(); }, 200);
    }
  }
  // Decap/Sveltia CMS handshake: wait for "authorizing:github" then respond
  window.addEventListener('message', function(e){
    if (e.data === 'authorizing:github') send();
  });
  // Also try immediately for older clients
  setTimeout(send, 50);
  setTimeout(send, 1000);
})();
</script>
</body></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function errorPage(title, detail, cmsOrigin) {
  // Sveltia expects { error, errorCode }; Decap expects { message }. Send both.
  const payload = JSON.stringify({
    error: `${title}: ${detail}`,
    errorCode: 'AUTH_FAILED',
    message: `${title}: ${detail}`,
  });
  const message = `authorization:github:error:${payload}`;
  const targetOrigin = cmsOrigin || '*';
  const html = `<!DOCTYPE html>
<html lang="uk"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:40px;color:#333;}
.box{max-width:540px;margin:0 auto;background:#fff5f5;border:1px solid #f5c2c2;padding:25px;border-radius:8px;}
button{padding:10px 20px;background:#e74c3c;color:white;border:none;border-radius:4px;cursor:pointer;}</style>
</head><body>
<div class="box">
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(detail)}</p>
  <button onclick="window.close()">Закрити вікно</button>
</div>
<script>
(function(){
  var msg = ${JSON.stringify(message)};
  var target = ${JSON.stringify(targetOrigin)};
  if (window.opener) {
    try { window.opener.postMessage(msg, target); } catch(e){}
    try { window.opener.postMessage(msg, '*'); } catch(e){}
  }
})();
</script>
</body></html>`;
  return new Response(html, {
    status: 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
