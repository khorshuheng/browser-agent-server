// Minimal, fast CDP client over a single WebSocket. No external CDP library:
// we speak the protocol directly so we control batching, routing and latency.
//
// Two kinds of connections:
//   - browser-level  (ws://127.0.0.1:PORT/devtools/browser/<id>)
//   - target-level   (ws://.../devtools/page/<targetId>)
//
// A CdpConnection can multiplex *sessions* (attached targets) over one socket
// by stamping messages with sessionId, which is how we keep one socket for
// every tab the agent touches.

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

let nextId = 1;

export class CdpConnection extends EventEmitter {
  constructor(url, { label = 'cdp', defaultTimeoutMs = 30000 } = {}) {
    super();
    this.url = url;
    this.label = label;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.pending = new Map(); // id -> {resolve, reject, timer, method}
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    this._open();
  }

  _open() {
    this.ws = new WebSocket(this.url, {
      // Disable permessage-deflate: CDP payloads are small and compression adds
      // per-message latency that hurts command round-trips.
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
    });
    this.ws.on('open', () => this._resolveReady(this));
    this.ws.on('message', (buf) => this._onMessage(buf));
    this.ws.on('error', (err) => {
      if (this.pending.size === 0 && this.closed) return;
      this.emit('error', err);
      if (!this._readySettled) {
        this._readySettled = true;
        this._rejectReady(err);
      }
    });
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      const err = new Error(`CDP socket closed (${code}) ${reason?.toString?.() || ''}`.trim());
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.emit('close', err);
    });
  }

  _onMessage(buf) {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = new Error(`${p.method}: ${msg.error.message}`);
        /** @type {any} */ (err).code = msg.error.code;
        /** @type {any} */ (err).data = msg.error.data;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // Event. Route by sessionId if present.
    const sid = msg.sessionId || null;
    this.emit('event', msg.method, msg.params || {}, sid);
    this.emit(`event:${msg.method}`, msg.params || {}, sid);
    if (sid) this.emit(`session:${sid}:${msg.method}`, msg.params || {}, sid);
  }

  send(method, params = {}, { sessionId = null, timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'));
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // Fire-and-forget: used for high-frequency, latency-sensitive commands where
  // we don't need the ack (e.g. synthetic mouse moves during a drag).
  post(method, params = {}, { sessionId = null } = {}) {
    if (this.closed) return;
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// Discover a running Chrome's browser websocket endpoint via /json/version.
export async function fetchBrowserEndpoint(port, { timeoutMs = 5000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    return json.webSocketDebuggerUrl;
  } finally {
    clearTimeout(t);
  }
}
