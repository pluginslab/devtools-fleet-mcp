import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

// The plugin runs the server from npm, so the pinned version is what every
// session actually gets. It must move with every release.
test('plugin.json pins the npm package at this version', () => {
  const { version } = read('package.json');
  const plugin = read('.claude-plugin/plugin.json');
  assert.equal(plugin.version, version);
  assert.ok(plugin.mcpServers['devtools-fleet'].args.includes(`devtools-fleet-mcp@${version}`), 'mcpServers args pin devtools-fleet-mcp@<version>');
});
