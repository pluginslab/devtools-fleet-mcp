import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSessionAnchor, isWrapper, anchorMatches, processStartTime, readProcess } from '../../src/lib/process-tree.js';

test('wrappers are recognised by executable or retitled args', () => {
  assert.equal(isWrapper('/usr/local/bin/node', 'node /x/_npx/abc/node_modules/.bin/devtools-fleet-mcp'), true);
  assert.equal(isWrapper('/usr/local/bin/node', 'node /usr/local/lib/node_modules/npm/bin/npx-cli.js devtools-fleet-mcp'), true);
  assert.equal(isWrapper('node', 'node /repo/devtools-fleet-mcp/src/index.js'), true);
  assert.equal(isWrapper('npm exec devtools-fleet-mcp', 'npm exec devtools-fleet-mcp'), true);
  assert.equal(isWrapper('/bin/zsh', '-zsh'), true);
  assert.equal(isWrapper('-zsh', '-zsh'), true);
  assert.equal(isWrapper('claude', 'claude --continue'), false);
  // A client that is itself a Node program is a session, not a wrapper.
  assert.equal(isWrapper('node', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'), false);
  assert.equal(isWrapper('node', 'node ./my-orchestrator.js'), false);
  assert.equal(isWrapper('/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin)', 'Cursor Helper (Plugin)'), false);
});

function tree(processes) {
  return (pid) => processes[pid] ?? null;
}

test('skips npx/npm/node wrappers up to the client session', () => {
  const readProc = tree({
    300: { ppid: 200, comm: 'node', args: 'node /x/_npx/1/node_modules/.bin/devtools-fleet-mcp' },
    200: { ppid: 100, comm: 'npm exec devtools-fleet-mcp', args: 'npm exec devtools-fleet-mcp' },
    100: { ppid: 50, comm: 'claude', args: 'claude --dangerously-skip-permissions' },
    50: { ppid: 1, comm: '-zsh', args: '-zsh' },
  });
  delete process.env.DEVTOOLS_FLEET_SESSION;
  assert.deepEqual(findSessionAnchor({ readProc, startTime: () => 'T0', startPid: 300 }), { pid: 100, start: 'T0', label: 'claude' });
});

test('falls back to the parent when only wrappers are found', () => {
  const readProc = tree({ 300: { ppid: 1, comm: 'npm exec x', args: 'npm exec x' } });
  delete process.env.DEVTOOLS_FLEET_SESSION;
  assert.deepEqual(findSessionAnchor({ readProc, startTime: () => null, startPid: 300 }), { pid: 300, start: null, label: 'parent' });
});

test('DEVTOOLS_FLEET_SESSION overrides the lookup', () => {
  process.env.DEVTOOLS_FLEET_SESSION = 'ci-job-7';
  try {
    assert.deepEqual(findSessionAnchor({ readProc: () => { throw new Error('should not be called'); } }), { pid: 0, start: null, label: 'session:ci-job-7' });
  } finally {
    delete process.env.DEVTOOLS_FLEET_SESSION;
  }
});

test('reads real processes through ps', { skip: process.platform === 'win32' }, () => {
  const me = readProcess(process.pid);
  assert.equal(me.ppid, process.ppid);
  assert.match(me.comm, /node/);
  assert.match(me.args, /node/);
  assert.equal(readProcess(999_999_999), null);
});

test('the real process tree resolves past wrappers to a real process', { skip: process.platform === 'win32' }, () => {
  const anchor = findSessionAnchor();
  assert.ok(anchor.pid > 0);
  assert.notEqual(anchor.label, 'parent', 'walked the tree instead of falling back');
  assert.ok(anchor.start, 'start time recorded');
});

test('a recycled pid is not the same session', () => {
  const start = processStartTime(process.pid);
  assert.ok(start);
  const anchor = { pid: process.pid, start, label: 'node' };
  assert.equal(anchorMatches({ anchorPid: process.pid, anchorStart: start }, anchor), true);
  assert.equal(anchorMatches({ anchorPid: process.pid, anchorStart: 'Mon Jan  1 00:00:00 2024' }, anchor), false);
  assert.equal(anchorMatches({ anchorPid: 0, anchorLabel: 'session:a' }, { pid: 0, label: 'session:a' }), true);
  assert.equal(anchorMatches({ anchorPid: 0, anchorLabel: 'session:a' }, { pid: 0, label: 'session:b' }), false);
});
