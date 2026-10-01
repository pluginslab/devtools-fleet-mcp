// Minimal Chrome DevTools Protocol client over the built-in WebSocket.
//
// Fleet keeps its own CDP connection next to chrome-devtools-mcp's, for the
// few things upstream doesn't do: cookie and storage transfer, and the
// navigation allowlist. Flat sessions only (Target.setAutoAttach flatten).

export class CdpConnection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  static async connect(wsUrl, { timeoutMs = 10_000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timed out: ${wsUrl}`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP connect failed: ${wsUrl}`)); }, { once: true });
    });
    return new CdpConnection(ws);
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', () => this.#onClose());
  }

  get closed() {
    return this.#closed;
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.#closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(message));
    });
  }

  /** Listen for an event. Handler gets (params, sessionId). Returns an unsubscribe function. */
  on(method, handler) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(handler);
    return () => this.#listeners.get(method)?.delete(handler);
  }

  waitFor(method, predicate = () => true, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
      const off = this.on(method, (params, sessionId) => {
        if (!predicate(params, sessionId)) return;
        clearTimeout(timer);
        off();
        resolve({ params, sessionId });
      });
    });
  }

  close() {
    if (this.#closed) return;
    this.#ws.close();
    this.#onClose();
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    const handlers = this.#listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message.params, message.sessionId);
      } catch (err) {
        console.error(`[devtools-fleet] CDP handler for ${message.method} threw:`, err);
      }
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, method } of this.#pending.values()) {
      reject(new Error(`CDP connection closed (${method})`));
    }
    this.#pending.clear();
    for (const handler of this.#listeners.get('__close') ?? []) handler();
  }
}
