import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSuccessHtml, renderErrorHtml } from './pages.js';

describe('auth HTML pages', () => {
  it('posts only to the given origin', () => {
    const html = renderSuccessHtml('tok_test', 'owner@gmail.com', 'https://ortez.com.ua');
    assert.equal(/postMessage\([^)]*,\s*['"]\*['"]/.test(html), false);
    assert.equal(html.includes('tok_test'), true);
    assert.match(html, /var target = "https:\/\/ortez\.com\.ua"/);
  });

  it('refuses to render a token page without an https origin', () => {
    assert.throws(() => renderSuccessHtml('tok_test', 'a@b.c', ''), /origin/);
    assert.throws(() => renderSuccessHtml('tok_test', 'a@b.c', '*'), /origin/);
    assert.throws(() => renderSuccessHtml('tok_test', 'a@b.c', 'http://ortez.com.ua'), /origin/);
  });

  it('escapes email and error detail', () => {
    const html = renderErrorHtml('<x>', '<img onerror=alert(1)>', 'https://ortez.com.ua');
    assert.equal(html.includes('<img onerror=alert(1)>'), false);
    assert.equal(html.includes('&lt;img onerror=alert(1)&gt;'), true);
    assert.equal(html.includes('&lt;x&gt;'), true);
    assert.equal(/postMessage\([^)]*,\s*['"]\*['"]/.test(html), false);
  });
});
