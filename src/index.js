#!/usr/bin/env node
import { startServer } from './server.js';

startServer().catch((err) => {
  console.error(`[devtools-fleet-mcp] failed to start: ${err.message}`);
  process.exit(1);
});
