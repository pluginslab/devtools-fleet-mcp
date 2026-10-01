import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'fleet-policy-'));
const home = join(root, 'fleet-home');
mkdirSync(join(home, 'states'), { recursive: true });
process.env.DEVTOOLS_FLEET_HOME = home;
const { checkToolCall, isInsideFleetHome } = await import('../../src/lib/policy.js');

test.after(() => rmSync(root, { recursive: true, force: true }));

const allow = ['https://app.example.com'];

test('navigation: allowlist, schemes, file: URLs', () => {
  assert.equal(checkToolCall('new_page', { url: 'https://app.example.com/x' }, { allowlist: allow }), null);
  assert.match(checkToolCall('new_page', { url: 'https://evil.test/' }, { allowlist: allow }), /not in this browser's allowlist/);
  assert.equal(checkToolCall('navigate_page', { url: 'about:blank' }, { allowlist: allow }), null);
  assert.equal(checkToolCall('navigate_page', { url: 'data:text/html,hi' }, { allowlist: null }), null);
  assert.match(checkToolCall('navigate_page', { url: 'chrome://settings' }, { allowlist: null }), /can't be opened/);
  assert.match(checkToolCall('navigate_page', { url: 'view-source:https://x.test' }, { allowlist: null }), /can't be opened/);
  assert.match(checkToolCall('navigate_page', { url: 'javascript:alert(1)' }, { allowlist: null }), /can't be opened/);
  assert.match(checkToolCall('navigate_page', { url: 'not a url' }, { allowlist: null }), /Not a valid URL/);
  assert.equal(checkToolCall('navigate_page', { url: 'file:///tmp/report.html' }, { allowlist: null }), null);
  assert.match(checkToolCall('navigate_page', { url: 'file:///tmp/report.html' }, { allowlist: allow }), /file: URLs are not available/);
  assert.match(checkToolCall('navigate_page', { url: `file://${home}/states/prod.json` }, { allowlist: null }), /holds saved logins/);
  assert.equal(checkToolCall('navigate_page', { type: 'back' }, { allowlist: allow }), null);
});

test('file arguments may not point into the fleet home, even through a symlink', () => {
  const link = join(root, 'innocent');
  symlinkSync(home, link);
  assert.match(checkToolCall('upload_file', { uid: 'x', filePaths: [join(home, 'states', 'prod.json')] }, { allowlist: null }), /filePaths points inside/);
  assert.match(checkToolCall('upload_file', { uid: 'x', filePaths: [join(link, 'states', 'prod.json')] }, { allowlist: null }), /filePaths points inside/);
  assert.match(checkToolCall('take_screenshot', { filePath: join(link, 'new-dir', 'x.png') }, { allowlist: null }), /filePath points inside/);
  assert.match(checkToolCall('lighthouse_audit', { outputDirPath: home }, { allowlist: null }), /outputDirPath/);
  assert.equal(checkToolCall('take_screenshot', { filePath: join(root, 'shot.png') }, { allowlist: null }), null);
  assert.equal(isInsideFleetHome(join(root, 'fleet-home-sibling')), false);
});

test('no extra browser contexts when an allowlist is active', () => {
  assert.match(checkToolCall('new_page', { url: 'https://app.example.com', isolatedContext: 'x' }, { allowlist: allow }), /isolatedContext/);
  assert.equal(checkToolCall('new_page', { url: 'https://x.test', isolatedContext: 'x' }, { allowlist: null }), null);
});
