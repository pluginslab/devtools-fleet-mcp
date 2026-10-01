#!/usr/bin/env node
// Detached background process that closes abandoned fleet browsers. Started
// by devtools-fleet-mcp on demand; exits by itself when there is nothing left.
import { loadConfig } from './lib/config.js';
import { runReaper } from './lib/reaper.js';

runReaper({ loadConfig }).catch((err) => {
  console.error(`${new Date().toISOString()} reaper crashed: ${err.stack ?? err.message}`);
  process.exit(1);
});
