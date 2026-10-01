import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockdownArgs } from '../../src/lib/lockdown.js';

test('lockdown flags: dead proxy, loopback first, host:port rules with explicit ports', () => {
  const args = lockdownArgs(['https://app.example.com', 'http://127.0.0.1:3000', 'https://*.cdn.example.com', 'http://app.example.com:8080', 'https://app.example.com']);
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:0'));
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>;app.example.com:443;127.0.0.1:3000;*.cdn.example.com:443;app.example.com:8080'));
  assert.ok(args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(!args.some((a) => a.startsWith('--force-webrtc')), 'the force- variant does nothing');
});
