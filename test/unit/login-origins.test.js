import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeLoginAllowlist, loginStorageOrigins } from '../../src/lib/login-origins.js';

test('a login proposes where it started and landed, and leaves out origins only passed through', () => {
  const { proposed, passedThrough } = proposeLoginAllowlist({
    startOrigin: 'https://app.example.com',
    landed: ['https://app.example.com', 'https://admin.example.com'],
    extra: ['https://cdn.example.com'],
    visited: ['https://app.example.com', 'https://sso.provider.com', 'https://admin.example.com'],
  });
  assert.deepEqual(proposed.sort(), ['https://admin.example.com', 'https://app.example.com', 'https://cdn.example.com']);
  assert.deepEqual(passedThrough, ['https://sso.provider.com']);
});

test('storage is read for exact allowed origins and allowed visited ones, never wildcards', () => {
  const origins = loginStorageOrigins(['https://app.example.com', 'https://*.example.org'], ['https://a.example.org', 'https://sso.provider.com']);
  assert.deepEqual(origins.sort(), ['https://a.example.org', 'https://app.example.com']);
});
