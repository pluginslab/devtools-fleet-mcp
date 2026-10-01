import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOriginPattern, checkUrl, isSubset, cookieMatchesAllowlist, patternMatchesOrigin } from '../../src/lib/origins.js';

test('normalizes origins and wildcards', () => {
  assert.equal(normalizeOriginPattern('https://App.Example.com/'), 'https://app.example.com');
  assert.equal(normalizeOriginPattern('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(normalizeOriginPattern('https://example.com:443'), 'https://example.com');
  assert.equal(normalizeOriginPattern('https://*.example.com'), 'https://*.example.com');
  assert.equal(normalizeOriginPattern('https://*.example.com:8443'), 'https://*.example.com:8443');
});

test('rejects things that are not bare http(s) origins', () => {
  for (const bad of ['example.com', 'https://example.com/login', 'https://example.com?x=1', 'ftp://example.com', 'https://user:pw@example.com', 'https://*.com', 'nonsense']) {
    assert.throws(() => normalizeOriginPattern(bad), undefined, bad);
  }
});

test('checkUrl: no allowlist allows everything', () => {
  assert.equal(checkUrl(null, 'https://anything.test/').allowed, true);
});

test('checkUrl: exact origins, ports and schemes matter', () => {
  const allow = ['https://app.example.com', 'http://127.0.0.1:3000'];
  assert.equal(checkUrl(allow, 'https://app.example.com/dashboard?x=1').allowed, true);
  assert.equal(checkUrl(allow, 'http://app.example.com/').allowed, false);
  assert.equal(checkUrl(allow, 'https://evil.example.com/').allowed, false);
  assert.equal(checkUrl(allow, 'http://127.0.0.1:3000/x').allowed, true);
  assert.equal(checkUrl(allow, 'http://127.0.0.1:3001/x').allowed, false);
  assert.equal(checkUrl(allow, 'http://localhost:3000/x').allowed, false);
});

test('checkUrl: inline and internal schemes pass, file: does not', () => {
  const allow = ['https://app.example.com'];
  for (const ok of ['about:blank', 'data:text/html,hi', 'blob:https://app.example.com/1', 'chrome-error://chromewebdata/']) {
    assert.equal(checkUrl(allow, ok).allowed, true, ok);
  }
  assert.equal(checkUrl(allow, 'file:///etc/passwd').allowed, false);
  assert.equal(checkUrl(allow, 'chrome://settings').allowed, false);
});

test('checkUrl: wildcards cover subdomains only', () => {
  const allow = ['https://*.example.com'];
  assert.equal(checkUrl(allow, 'https://a.example.com/').allowed, true);
  assert.equal(checkUrl(allow, 'https://a.b.example.com/').allowed, true);
  assert.equal(checkUrl(allow, 'https://example.com/').allowed, false);
  assert.equal(checkUrl(allow, 'https://example.com.evil.test/').allowed, false);
  assert.equal(checkUrl(allow, 'https://notexample.com/').allowed, false);
  assert.equal(checkUrl(allow, 'http://a.example.com/').allowed, false);
});

test('checkUrl: websockets follow the http(s) origin', () => {
  const allow = ['https://app.example.com'];
  assert.equal(checkUrl(allow, 'wss://app.example.com/socket').allowed, true);
  assert.equal(checkUrl(allow, 'wss://other.example.com/socket').allowed, false);
});

test('isSubset only lets an allowlist narrow', () => {
  const wide = ['https://app.example.com', 'https://*.corp.test'];
  assert.equal(isSubset(['https://app.example.com'], wide), true);
  assert.equal(isSubset(['https://x.corp.test'], wide), true);
  assert.equal(isSubset(['https://*.a.corp.test'], wide), true);
  assert.equal(isSubset(['https://*.corp.test'], ['https://x.corp.test']), false);
  assert.equal(isSubset(['https://evil.test'], wide), false);
  assert.equal(isSubset(['https://app.example.com', 'https://evil.test'], wide), false);
});

test('cookie domains are matched to the allowlist', () => {
  const allow = ['https://app.example.com', 'https://*.corp.test'];
  assert.equal(cookieMatchesAllowlist('app.example.com', allow), true);
  assert.equal(cookieMatchesAllowlist('.example.com', allow), true, 'parent-domain cookie is sent to app.example.com');
  assert.equal(cookieMatchesAllowlist('other.example.com', allow), false);
  assert.equal(cookieMatchesAllowlist('tracker.test', allow), false);
  assert.equal(cookieMatchesAllowlist('x.corp.test', allow), true);
  assert.equal(cookieMatchesAllowlist('.corp.test', allow), true);
  assert.equal(cookieMatchesAllowlist('127.0.0.1', ['http://127.0.0.1:3000']), true);
});

test('patternMatchesOrigin handles bad input', () => {
  assert.equal(patternMatchesOrigin('https://*.example.com', 'not a url'), false);
});
