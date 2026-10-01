import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'fleet-unit-'));
process.env.DEVTOOLS_FLEET_HOME = home;
const { withLock } = await import('../../src/lib/lock.js');
const registry = await import('../../src/lib/registry.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('lock serialises 20 separate processes (read-modify-write never loses an update)', async () => {
  const counter = join(home, 'counter');
  writeFileSync(counter, '0');
  const worker = `
    import { withLock } from ${JSON.stringify(join(ROOT, 'src/lib/lock.js'))};
    import { readFileSync, writeFileSync } from 'node:fs';
    for (let i = 0; i < 5; i++) {
      await withLock('registry', async () => {
        const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
        await new Promise(r => setTimeout(r, Math.random() * 5));
        writeFileSync(${JSON.stringify(counter)}, String(n + 1));
      });
    }`;
  const runs = Array.from({ length: 20 }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', worker], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  }));
  await Promise.all(runs);
  assert.equal(Number(readFileSync(counter, 'utf8')), 100);
});

test('a lock left by a dead process is taken over', async () => {
  const { mkdirSync } = await import('node:fs');
  const dir = join(home, 'locks', 'stale.lock');
  mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(dir, 'owner'), dead);
  const started = Date.now();
  assert.equal(await withLock('stale', async () => 'got it', { timeoutMs: 3000 }), 'got it');
  assert.ok(Date.now() - started < 2000);
});

test('registry files are private and classify by liveness', () => {
  const base = { kind: 'agent', port: 1234, lastSeen: Date.now(), createdAt: Date.now() };
  registry.writeEntry({ ...base, id: 'aaaa0001', fleetPid: process.pid, anchorPid: process.pid });
  registry.writeEntry({ ...base, id: 'aaaa0002', fleetPid: 0, anchorPid: process.pid });
  registry.writeEntry({ ...base, id: 'aaaa0003', fleetPid: 0, anchorPid: 999_999 });
  registry.writeEntry({ ...base, id: 'aaaa0004', fleetPid: 0, anchorPid: 0, anchorLabel: 'session:x' });
  registry.writeEntry({ ...base, id: 'aaaa0005', fleetPid: process.pid, port: null });
  const byId = Object.fromEntries(registry.listEntries().map((e) => [e.id, registry.classify(e)]));
  assert.deepEqual(byId, { aaaa0001: 'active', aaaa0002: 'detached', aaaa0003: 'orphan', aaaa0004: 'detached', aaaa0005: 'starting' });
  assert.equal(statSync(registry.entryPath('aaaa0001')).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'browsers')).mode & 0o777, 0o700);
  registry.updateEntry('aaaa0001', { state: 'x' });
  assert.equal(registry.readEntry('aaaa0001').state, 'x');
  for (const e of registry.listEntries()) registry.removeEntry(e.id);
  assert.equal(registry.listEntries().length, 0);
});
