import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedHost,
  isAllowedOrigin,
  normalizePath,
  isGithubProxyPathAllowed,
  originRequired,
  signState,
  verifyState,
  makePkce,
  isSafeHref,
  isSafeMapEmbed,
  isSafeGaId,
  isSafeImageSrc,
  emailsAllowlisted,
  rateLimitDecision,
  genericErrorMessage,
} from './security.js';

describe('isAllowedHost', () => {
  it('allows exact host only', () => {
    assert.equal(isAllowedHost('ortez.com.ua', 'ortez.com.ua'), true);
    assert.equal(isAllowedHost('evil.ortez.com.ua', 'ortez.com.ua'), false);
    assert.equal(isAllowedHost('ortez.com.ua.evil.com', 'ortez.com.ua'), false);
    assert.equal(isAllowedHost('localhost', 'ortez.com.ua'), false);
  });

  it('supports explicit wildcard rules only', () => {
    assert.equal(isAllowedHost('cms.ortez.com.ua', '*.ortez.com.ua'), true);
    assert.equal(isAllowedHost('ortez.com.ua', '*.ortez.com.ua'), true);
    assert.equal(isAllowedHost('notortez.com.ua', '*.ortez.com.ua'), false);
  });

  it('rejects empty host', () => {
    assert.equal(isAllowedHost('', 'ortez.com.ua'), false);
    assert.equal(isAllowedHost(null, 'ortez.com.ua'), false);
  });
});

describe('originRequired', () => {
  it('denies missing origin', () => {
    assert.equal(originRequired('', 'ortez.com.ua'), false);
    assert.equal(originRequired(null, 'ortez.com.ua'), false);
  });

  it('allows only allowlisted https origins', () => {
    assert.equal(originRequired('https://ortez.com.ua', 'ortez.com.ua'), true);
    assert.equal(originRequired('https://evil.com', 'ortez.com.ua'), false);
  });
});

describe('isAllowedOrigin', () => {
  it('requires https and allowlisted host', () => {
    assert.equal(isAllowedOrigin('https://ortez.com.ua', 'ortez.com.ua'), true);
    assert.equal(isAllowedOrigin('http://ortez.com.ua', 'ortez.com.ua'), false);
    assert.equal(isAllowedOrigin('https://evil.com', 'ortez.com.ua'), false);
  });
});

describe('normalizePath + github allowlist', () => {
  const repo = 'jftochka/ortez-pro';

  it('allows only the configured repo tree', () => {
    assert.equal(isGithubProxyPathAllowed('/repos/jftochka/ortez-pro', repo), true);
    assert.equal(isGithubProxyPathAllowed('/repos/jftochka/ortez-pro/contents/data/site.yaml', repo), true);
    assert.equal(isGithubProxyPathAllowed('/repos/jftochka/ortez-pro/git/blobs', repo), true);
  });

  it('rejects other repos, graphql, and traversal', () => {
    assert.equal(isGithubProxyPathAllowed('/graphql', repo), false);
    assert.equal(isGithubProxyPathAllowed('/repos/evil/repo', repo), false);
    assert.equal(isGithubProxyPathAllowed('/repos/jftochka/ortez-pro/../secrets', repo), false);
    assert.equal(isGithubProxyPathAllowed('/app/installations/1/access_tokens', repo), false);
    assert.equal(isGithubProxyPathAllowed('/', repo), false);
  });

  it('normalizes dot segments and rejects escape', () => {
    assert.equal(normalizePath('/repos/jftochka/ortez-pro/./contents'), '/repos/jftochka/ortez-pro/contents');
    assert.equal(normalizePath('/repos/jftochka/ortez-pro/../../etc'), null);
    assert.equal(normalizePath('/foo/%2e%2e/bar'), null);
  });
});

describe('signed state', () => {
  const secret = 'test-state-secret-at-least-32-bytes-long!!';

  it('round-trips origin and pkce verifier', async () => {
    const pkce = await makePkce();
    const token = await signState(secret, {
      origin: 'https://ortez.com.ua',
      nonce: 'n1',
      cv: pkce.verifier,
    });
    const parsed = await verifyState(secret, token, 600);
    assert.equal(parsed.origin, 'https://ortez.com.ua');
    assert.equal(parsed.cv, pkce.verifier);
    assert.ok(pkce.challenge.length > 20);
  });

  it('rejects tampered or unsigned state', async () => {
    const token = await signState(secret, { origin: 'https://ortez.com.ua', nonce: 'n1' });
    assert.equal(await verifyState(secret, token.slice(0, -2) + 'aa', 600), null);
    assert.equal(await verifyState(secret, 'not-a-state', 600), null);
    const forged = Buffer.from(JSON.stringify({ origin: 'https://evil.com' })).toString('base64url');
    assert.equal(await verifyState(secret, forged, 600), null);
  });

  it('rejects expired state', async () => {
    const token = await signState(secret, { origin: 'https://ortez.com.ua', nonce: 'n1', exp: 1 });
    assert.equal(await verifyState(secret, token, 600), null);
  });
});

describe('emailsAllowlisted', () => {
  it('matches trimmed lowercase emails', async () => {
    assert.equal(await emailsAllowlisted('Owner@Gmail.com', 'owner@gmail.com,other@x.com'), true);
    assert.equal(await emailsAllowlisted('nope@x.com', 'owner@gmail.com'), false);
    assert.equal(await emailsAllowlisted('', 'owner@gmail.com'), false);
  });
});

describe('rateLimitDecision', () => {
  it('allows under the cap and blocks at the cap', () => {
    assert.deepEqual(rateLimitDecision(0, 10), { allow: true, next: 1 });
    assert.deepEqual(rateLimitDecision(9, 10), { allow: true, next: 10 });
    assert.deepEqual(rateLimitDecision(10, 10), { allow: false, next: 10 });
  });
});

describe('url / field allowlists', () => {
  it('isSafeHref', () => {
    assert.equal(isSafeHref('/kontakty/'), true);
    assert.equal(isSafeHref('https://t.me/ortez_pro'), true);
    assert.equal(isSafeHref('tel:+380633927652'), true);
    assert.equal(isSafeHref('mailto:ortez@ukr.net'), true);
    assert.equal(isSafeHref('javascript:alert(1)'), false);
    assert.equal(isSafeHref('data:text/html,x'), false);
    assert.equal(isSafeHref('http://evil.com'), false);
  });

  it('isSafeMapEmbed', () => {
    assert.equal(isSafeMapEmbed('https://www.google.com/maps/embed?pb=abc'), true);
    assert.equal(isSafeMapEmbed('https://evil.com/maps/embed'), false);
    assert.equal(isSafeMapEmbed('https://www.google.com/maps/embed/../../../'), false);
  });

  it('isSafeGaId', () => {
    assert.equal(isSafeGaId('G-89B6QW9E7W'), true);
    assert.equal(isSafeGaId("G-89B6QW9E7W');alert(1)//"), false);
    assert.equal(isSafeGaId(''), false);
  });

  it('isSafeImageSrc', () => {
    assert.equal(isSafeImageSrc('/images/logo.png'), true);
    assert.equal(isSafeImageSrc("javascript:alert(1)"), false);
    assert.equal(isSafeImageSrc("/images/x.png');alert(1)"), false);
  });
});

describe('genericErrorMessage', () => {
  it('does not echo upstream bodies', () => {
    assert.equal(genericErrorMessage('Google token exchange failed: secret'), 'Авторизацію не завершено.');
    assert.ok(!genericErrorMessage('x').includes('secret'));
  });
});
