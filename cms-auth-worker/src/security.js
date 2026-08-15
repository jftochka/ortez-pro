const encoder = new TextEncoder();

export function isAllowedHost(host, allowedDomains) {
  if (!host) return false;
  const allowed = String(allowedDomains || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.some((rule) => {
    if (rule.startsWith('*.')) {
      const base = rule.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    return host === rule;
  });
}

export function originHost(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

export function isAllowedOrigin(origin, allowedDomains) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return isAllowedHost(u.hostname, allowedDomains);
  } catch {
    return false;
  }
}

export function originRequired(origin, allowedDomains) {
  if (!origin) return false;
  return isAllowedOrigin(origin, allowedDomains);
}

export function normalizePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    out.push(part);
  }
  return '/' + out.join('/');
}

export function isGithubProxyPathAllowed(path, repo) {
  const normalized = normalizePath(path);
  if (!normalized || !repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return false;
  }
  const prefix = `/repos/${repo}`;
  return normalized === prefix || normalized.startsWith(prefix + '/');
}

export function rateLimitDecision(prevCount, limit) {
  const count = Number(prevCount) || 0;
  if (count >= limit) return { allow: false, next: count };
  return { allow: true, next: count + 1 };
}

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlEncodeJson(obj) {
  return bytesToB64url(encoder.encode(JSON.stringify(obj)));
}

export function base64UrlDecodeJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signState(secret, claims) {
  if (!secret || String(secret).length < 16) {
    throw new Error('STATE_SECRET is not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    iat: claims.iat || now,
    exp: claims.exp || now + 600,
  };
  const body = base64UrlEncodeJson(payload);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${bytesToB64url(new Uint8Array(sig))}`;
}

export async function verifyState(secret, token, maxAgeSec) {
  if (!secret || !token || !token.includes('.')) return null;
  const [body, sigB64] = token.split('.');
  if (!body || !sigB64) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlToBytes(sigB64),
    encoder.encode(body)
  );
  if (!ok) return null;
  let payload;
  try {
    payload = base64UrlDecodeJson(body);
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.iat && payload.iat > now + 30) return null;
  if (maxAgeSec && payload.iat && now - payload.iat > maxAgeSec) return null;
  return payload;
}

export async function makePkce() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = bytesToB64url(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return { verifier, challenge: bytesToB64url(new Uint8Array(digest)) };
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}

export async function emailsAllowlisted(email, allowedCsv) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return false;
  const allowed = String(allowedCsv || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const needleHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(needle)));
  for (const item of allowed) {
    const itemHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(item)));
    if (timingSafeEqualBytes(needleHash, itemHash)) return true;
  }
  return false;
}

export function isSafeHref(value) {
  const u = String(value || '').trim();
  if (!u) return false;
  if (u.startsWith('/') && !u.startsWith('//')) return !/[<>"']/.test(u);
  if (/^tel:\+?[0-9#*]+$/.test(u)) return true;
  if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u)) return true;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isSafeMapEmbed(value) {
  const u = String(value || '').trim();
  if (!u.startsWith('https://www.google.com/maps/embed')) return false;
  if (u.includes('..')) return false;
  try {
    const parsed = new URL(u);
    return parsed.hostname === 'www.google.com' && parsed.pathname === '/maps/embed';
  } catch {
    return false;
  }
}

export function isSafeGaId(value) {
  return /^G-[A-Z0-9]+$/.test(String(value || ''));
}

export function isSafeImageSrc(value) {
  const u = String(value || '').trim();
  if (!u || /['"()<>]/.test(u)) return false;
  return u.startsWith('/images/') && !u.includes('..');
}

export function genericErrorMessage() {
  return 'Авторизацію не завершено.';
}

export function applyCommitIdentity(payload, name, email) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (!name || !email) return payload;
  if (typeof payload.message !== 'string') return payload;
  if (!('content' in payload) && !('tree' in payload)) return payload;
  const id = { name: String(name), email: String(email) };
  return { ...payload, author: id, committer: id };
}

export function mapWorkerGithubPath(pathname) {
  let ghPath = pathname;
  if (ghPath.startsWith('/github/api/v3/') || ghPath === '/github/api/v3') {
    ghPath = ghPath.slice('/github/api/v3'.length) || '/';
  } else if (ghPath === '/github/api/graphql' || ghPath === '/github/api/graphql/') {
    return '/graphql';
  } else if (ghPath.startsWith('/github/')) {
    ghPath = ghPath.slice('/github'.length);
  } else if (ghPath === '/github') {
    ghPath = '/';
  }
  return ghPath || '/';
}
