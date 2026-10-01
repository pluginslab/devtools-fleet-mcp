import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'fleet-unit-states-'));
process.env.DEVTOOLS_FLEET_HOME = home;
const states = await import('../../src/lib/states.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

const cookie = (name, domain, extra = {}) => ({ name, value: `SECRET-${name}`, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax', ...extra });

test('state names are validated', () => {
  for (const bad of ['', '../x', 'a/b', '.hidden', 'x'.repeat(65), 'with space']) assert.throws(() => states.assertStateName(bad), undefined, bad);
  for (const ok of ['staging-admin', 'wp_admin.local', 'A1']) assert.doesNotThrow(() => states.assertStateName(ok));
});

test('write, read, summarise: summary never contains values; file is private', () => {
  const summary = states.writeState({
    name: 'app',
    cookies: [cookie('sid', 'app.example.com'), cookie('pref', '.example.com', { expires: Date.now() / 1000 + 3600 })],
    origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 'SECRET-ls' }] }],
    allowedOrigins: ['https://app.example.com/'],
    createdBy: 'cli',
  });
  assert.deepEqual(summary.allowedOrigins, ['https://app.example.com']);
  assert.equal(summary.cookies, 2);
  assert.equal(summary.sessionCookies, 1);
  assert.ok(!JSON.stringify(summary).includes('SECRET'));
  assert.ok(!JSON.stringify(states.listStates()).includes('SECRET'));
  assert.equal(statSync(states.statePath('app')).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'states')).mode & 0o777, 0o700);
  const data = states.readState('app');
  assert.equal(data.cookies[0].value, 'SECRET-sid');
  assert.equal(data.devtoolsFleet.createdBy, 'cli');
});

test('a state without an allowlist is refused', () => {
  assert.throws(() => states.writeState({ name: 'none', cookies: [], origins: [], allowedOrigins: [], createdBy: 'agent' }), /allowed origin/);
});

test('missing state gives a helpful error', () => {
  assert.throws(() => states.readState('nope'), /No state named "nope"/);
});

test('import keeps only cookies and storage inside the allowlist', () => {
  const file = join(home, 'pw.json');
  writeFileSync(file, JSON.stringify({
    cookies: [cookie('sid', 'app.example.com'), cookie('ads', 'tracker.test')],
    origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'a', value: 'b' }] }, { origin: 'https://tracker.test', localStorage: [{ name: 'c', value: 'd' }] }],
  }));
  const { summary, droppedCookies } = states.importState({ name: 'imported', file, allowedOrigins: ['https://app.example.com'] });
  assert.equal(summary.cookies, 1);
  assert.equal(droppedCookies, 1);
  assert.deepEqual(summary.localStorageOrigins, ['https://app.example.com']);
  assert.throws(() => states.importState({ name: 'x', file, allowedOrigins: [] }), /--allow/);
});

test('delete', () => {
  states.deleteState('imported');
  assert.throws(() => states.readState('imported'), /No state/);
  assert.throws(() => states.deleteState('imported'), /No state/);
});

test('refuses to store states inside a git work tree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'fleet-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const script = `
      process.env.DEVTOOLS_FLEET_HOME = ${JSON.stringify(join(repo, '.fleet'))};
      const s = await import(${JSON.stringify(new URL('../../src/lib/states.js', import.meta.url).href)});
      try { s.writeState({ name: 'x', cookies: [], origins: [], allowedOrigins: ['https://a.test'], createdBy: 'cli' }); console.log('WROTE'); }
      catch (e) { console.log(e.message); }`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.match(out, /Refusing to store login states inside a git work tree/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('state files load in Playwright shape', () => {
  const data = JSON.parse(readFileSync(states.statePath('app'), 'utf8'));
  assert.ok(Array.isArray(data.cookies) && Array.isArray(data.origins));
  for (const key of ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']) assert.ok(key in data.cookies[0], key);
});
