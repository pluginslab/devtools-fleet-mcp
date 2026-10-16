import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, validateConfig, parseViewport } from '../../src/lib/config.js';

test('defaults are valid', () => {
  assert.doesNotThrow(() => validateConfig({ ...DEFAULTS }));
});

test('the default viewport is desktop-sized, and can be switched off', () => {
  assert.equal(DEFAULTS.viewport, '1366x900');
  assert.ok(parseViewport(DEFAULTS.viewport).width >= 1024, 'above common tablet/desktop breakpoints');
  assert.doesNotThrow(() => validateConfig({ ...DEFAULTS, viewport: null }));
});

test('viewport parsing', () => {
  assert.deepEqual(parseViewport('1280x720'), { width: 1280, height: 720 });
  assert.throws(() => parseViewport('1280*720'));
  assert.throws(() => parseViewport('big'));
});

test('rejects bad values', () => {
  assert.throws(() => validateConfig({ ...DEFAULTS, channel: 'nightly' }), /channel/);
  assert.throws(() => validateConfig({ ...DEFAULTS, maxBrowsers: 0 }), /maxBrowsers/);
  assert.throws(() => validateConfig({ ...DEFAULTS, upstreamArgs: '--x' }), /array/);
});

test('upstreamArgs may not take over the browser', () => {
  for (const flag of ['--browserUrl=http://x', '--isolated', '--headless', '--userDataDir=/tmp/x', '--autoConnect', '--executablePath=/x', '--no-headless', '-u']) {
    assert.throws(() => validateConfig({ ...DEFAULTS, upstreamArgs: [flag] }), /manages the browser/, flag);
  }
  assert.doesNotThrow(() => validateConfig({ ...DEFAULTS, upstreamArgs: ['--no-usage-statistics', '--no-performance-crux'] }));
});
