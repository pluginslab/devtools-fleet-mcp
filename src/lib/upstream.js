import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// chrome-devtools-mcp runs as a child process, pointed at a Chrome fleet
// launched itself (--browserUrl). Fleet is an MCP client to it and passes its
// tools through unchanged. It comes from our own node_modules at a pinned
// range, never `npx @latest`, so startup doesn't depend on the npm registry.

const require = createRequire(import.meta.url);
const PKG_JSON = require.resolve('chrome-devtools-mcp/package.json');
const UPSTREAM_BIN = join(dirname(PKG_JSON), 'build/src/bin/chrome-devtools-mcp.js');
export const UPSTREAM_VERSION = require(PKG_JSON).version;

// Performance traces and Lighthouse runs can take minutes.
const CALL_TIMEOUT_MS = 10 * 60_000;

export class Upstream {
  #client = null;
  #closed = false;
  onClose = () => {};

  /**
   * @param {string} browserUrl  e.g. http://127.0.0.1:54288 ; null = tool listing only
   * @param {(() => Promise<Array>)|null} rootsProvider  the MCP client's workspace roots.
   *   Upstream only reads and writes files inside roots (plus the temp dir), so
   *   they're passed through; without them, screenshots can't go to the project.
   */
  static async start({ browserUrl, extraArgs = [], rootsProvider = null }) {
    const upstream = new Upstream();
    // A port nothing listens on is fine for listing: upstream connects lazily.
    const url = browserUrl ?? 'http://127.0.0.1:9';
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [UPSTREAM_BIN, `--browserUrl=${url}`, ...extraArgs],
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      // Upstream prints a privacy banner on every start; keep real errors only.
      if (/error|exception|fatal/i.test(text)) process.stderr.write(`[chrome-devtools-mcp] ${text}`);
    });
    const client = new Client(
      { name: 'devtools-fleet-mcp', version: '1' },
      { capabilities: rootsProvider ? { roots: { listChanged: true } } : {} },
    );
    if (rootsProvider) {
      client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: await rootsProvider().catch(() => []) }));
    }
    client.onclose = () => {
      // close() sets #closed first, so only an unexpected exit reaches onClose.
      const unexpected = !upstream.#closed;
      upstream.#closed = true;
      if (unexpected) upstream.onClose();
    };
    await client.connect(transport);
    upstream.#client = client;
    return upstream;
  }

  get closed() {
    return this.#closed;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const page = await this.#client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  getInstructions() {
    return this.#client.getInstructions();
  }

  sendRootsListChanged() {
    if (!this.#closed) this.#client.sendRootsListChanged().catch(() => {});
  }

  async callTool(name, args) {
    return this.#client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client?.close().catch(() => {});
  }
}
