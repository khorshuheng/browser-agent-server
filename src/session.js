// A Tab is one page target with its own target-level CDP connection.
//
// Why a dedicated connection per tab instead of flattening sessions over the
// browser socket? Routing stays trivial (every frame/session event belongs to
// this tab), we can enable domains without cross-talk, and each tab's event
// stream is independent — a chatty tab cannot stall another.
//
// Performance notes:
//  - Domains are enabled once at attach, not per command.
//  - `Runtime.evaluate` response parsing uses returnByValue only when asked.
//  - Network events carry requestId; we keep a small request table so we can
//    enrich `responseReceived` with the originating method/url cheaply.

import { EventEmitter } from 'node:events';
import { CdpConnection } from './cdp.js';
import { snapshotFn, digestFn, CONSOLE_HOOK_SOURCE, CONSOLE_DRAIN_SOURCE } from './observe.js';

const NETWORK_BODIES = new Set([
  'Document',
  'XHR',
  'Fetch',
  'Script',
  'Stylesheet',
  'Image',
  'Font',
  'Media',
  'WebSocket',
  'Other',
]);

export class Tab extends EventEmitter {
  constructor({ targetId, wsUrl, events, options = {} }) {
    super();
    this.targetId = targetId;
    this.cdp = new CdpConnection(wsUrl, { label: `tab:${targetId}` });
    this.events = events; // shared EventBus
    this.options = {
      collectNetwork: true,
      collectConsole: true,
      consoleHook: false,
      maxBodyBytes: 64 * 1024,
      ...options,
    };
    this.requests = new Map(); // requestId -> { method, url, type, ts }
    this.frameSessions = new Map(); // sessionId -> frameId (for OOPIFs)
    this.attached = false;
    this._dialogs = [];
    this._downloads = [];
    this._drainTimer = null;
  }

  async attach() {
    await this.cdp.ready;
    await this._enableDomains();
    this._wireEvents();
    if (this.options.consoleHook) await this._installConsoleHook();
    this.attached = true;
    return this;
  }

  // Install the in-page console/error hook. Needed on stealth Chromium builds
  // that do not forward Runtime.consoleAPICalled for CDP-created targets.
  async _installConsoleHook() {
    // Catch every future document (the page's own load-time logs included).
    await this.cdp
      .send('Page.addScriptToEvaluateOnNewDocument', { source: CONSOLE_HOOK_SOURCE })
      .catch(() => {});
    // Catch the already-loaded document too.
    await this.evaluate(CONSOLE_HOOK_SOURCE, { awaitPromise: false }).catch(() => {});
    // Drain periodically so streaming (SSE) clients see logs between actions.
    this._drainTimer = setInterval(() => {
      this.drainConsole().catch(() => {});
    }, 400);
    this._drainTimer.unref?.();
  }

  // Move buffered in-page logs into the event bus. Called after each action so
  // events are attributed to the command that caused them, and on a timer for
  // the streaming path.
  async drainConsole() {
    if (!this.options.consoleHook) return;
    let entries;
    try {
      entries = await this.evaluate(CONSOLE_DRAIN_SOURCE, { awaitPromise: false, timeoutMs: 5000 });
    } catch {
      return;
    }
    if (!Array.isArray(entries) || !entries.length) return;
    for (const e of entries) {
      if (e.type === 'pageerror') {
        this.bus.emit('pageerror', { message: e.text, url: e.url, line: e.line });
      } else {
        const text = String(e.text ?? '').slice(0, 2000);
        this.bus.emit(
          'console',
          { level: e.type, text },
          { key: `console:${e.type}:${text}`, summary: text.slice(0, 140) },
        );
      }
    }
  }

  async _enableDomains() {
    const send = (m, p = {}) => this.cdp.send(m, p).catch(() => {});
    const tasks = [
      send('Page.enable'),
      send('DOM.enable'),
      send('Runtime.enable'),
      send('Log.enable'),
      send('Page.setLifecycleEventsEnabled', { enabled: true }),
      // Keep targets discoverable so we can follow OOPIFs / new workers.
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }),
    ];
    if (this.options.collectNetwork) {
      tasks.push(
        send('Network.enable', {
          maxTotalBufferSize: 32 * 1024 * 1024,
          maxResourceBufferSize: 8 * 1024 * 1024,
          maxPostDataSize: 64 * 1024,
        }),
      );
    }
    await Promise.all(tasks);
  }

  _wireEvents() {
    // Stamp every event with the owning tab so per-tab SSE filtering works.
    const bus = {
      emit: (type, data, opts) => this.events.emit(type, { ...data, targetId: this.targetId }, opts),
      subscribe: (fn) => this.events.subscribe(fn),
      mark: () => this.events.mark(),
      since: (c) => this.events.since(c),
    };
    this.bus = bus;
    this.cdp.on('event', (method, params, _sessionId) => {
      switch (method) {
        case 'Runtime.consoleAPICalled': {
          // When the in-page hook is active it is the sole console source, so the
          // CDP path is skipped to avoid double-counting (stock Chrome fires both).
          if (!this.options.collectConsole || this.options.consoleHook) break;
          // Console lines are extremely high-frequency on SPAs; coalesce
          // identical consecutive lines so the agent sees counts, not floods.
          const text = (params.args || [])
            .map((a) => {
              if (a.value !== undefined)
                return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
              if (a.unserializableValue !== undefined) return String(a.unserializableValue);
              if (a.description) return a.description;
              return a.type;
            })
            .join(' ')
            .slice(0, 2000);
          bus.emit(
            'console',
            { level: params.type, text, stack: params.stackTrace?.callFrames?.[0]?.url || undefined },
            { key: `console:${params.type}:${text}`, summary: text.slice(0, 140) },
          );
          break;
        }
        case 'Runtime.exceptionThrown': {
          if (this.options.consoleHook) break;
          const d = params.exceptionDetails;
          bus.emit('pageerror', {
            message: d.exception?.description || d.text,
            url: d.url,
            line: d.lineNumber,
            column: d.columnNumber,
          });
          break;
        }
        case 'Log.entryAdded': {
          if (this.options.consoleHook) break;
          const e = params.entry;
          bus.emit(
            'console',
            {
              level: e.level === 'warning' ? 'warning' : e.level,
              text: e.text,
              source: e.source,
              url: e.url,
            },
            { key: `log:${e.level}:${e.text}`, summary: e.text?.slice(0, 140) },
          );
          break;
        }
        case 'Page.frameNavigated': {
          if (!params.frame.parentId) {
            bus.emit('navigation', { url: params.frame.url, name: params.frame.name }, { key: 'navigation' });
          }
          break;
        }
        case 'Page.navigatedWithinDocument': {
          bus.emit('navigation', { url: params.url, sameDocument: true }, { key: 'navigation' });
          break;
        }
        case 'Page.loadEventFired': {
          bus.emit('load', { timestamp: params.timestamp }, { key: 'load' });
          break;
        }
        case 'Page.domContentEventFired': {
          bus.emit('domcontentloaded', {});
          break;
        }
        case 'Page.javascriptDialogOpening': {
          bus.emit('dialog', { kind: params.type, message: params.message }, { key: 'dialog' });
          break;
        }
        case 'Page.fileChooserOpened': {
          bus.emit('filechooser', { mode: params.mode, backendNodeId: params.backendNodeId });
          break;
        }
        case 'Network.requestWillBeSent': {
          this.requests.set(params.requestId, {
            method: params.request.method,
            url: params.request.url,
            type: params.type,
            ts: params.timestamp,
          });
          if (params.redirectResponse) {
            bus.emit(
              'response',
              {
                requestId: params.requestId,
                status: params.redirectResponse.status,
                method: params.request.method,
                url: params.redirectResponse.url,
                resourceType: params.type,
                redirect: true,
              },
              { key: `resp:${params.redirectResponse.url}:${params.redirectResponse.status}` },
            );
          }
          bus.emit(
            'request',
            {
              requestId: params.requestId,
              method: params.request.method,
              url: params.request.url,
              resourceType: NETWORK_BODIES.has(params.type) ? params.type : 'Other',
            },
            { key: `req:${params.request.method}:${params.request.url}` },
          );
          break;
        }
        case 'Network.responseReceived': {
          const info = this.requests.get(params.requestId) || {};
          bus.emit(
            'response',
            {
              requestId: params.requestId,
              status: params.response.status,
              statusText: params.response.statusText,
              method: info.method,
              url: params.response.url,
              mimeType: params.response.mimeType,
              resourceType: params.type,
            },
            { key: `resp:${params.response.url}:${params.response.status}` },
          );
          break;
        }
        case 'Network.loadingFailed': {
          const info = this.requests.get(params.requestId) || {};
          bus.emit(
            'requestfailed',
            {
              requestId: params.requestId,
              url: info.url,
              method: info.method,
              failure: params.errorText,
              canceled: params.canceled || undefined,
            },
            { key: `fail:${info.url}:${params.errorText}` },
          );
          this.requests.delete(params.requestId);
          break;
        }
        case 'Network.loadingFinished': {
          this.requests.delete(params.requestId);
          break;
        }
        case 'Network.webSocketFrameReceived': {
          bus.emit('websocket', {
            direction: 'in',
            opcode: params.response.opcode,
            payload: params.response.payloadData?.slice(0, 500),
          });
          break;
        }
        case 'Page.downloadWillBegin': {
          bus.emit('download', { url: params.url, filename: params.suggestedFilename });
          break;
        }
        // OOPIF / worker sub-sessions routed by the same socket.
        case 'Target.attachedToTarget': {
          this._handleChildAttach(params);
          break;
        }
        case 'Target.detachedFromTarget': {
          this.frameSessions.delete(params.sessionId);
          break;
        }
      }
    });
  }

  async _handleChildAttach(params) {
    const info = params.targetInfo;
    if (info.type !== 'iframe' && info.type !== 'worker') return;
    const sid = params.sessionId;
    this.frameSessions.set(sid, info.targetId);
    // Let child run; enable console/network on it too so OOPIF logs surface.
    const send = (m, p = {}) => this.cdp.send(m, p, { sessionId: sid }).catch(() => {});
    await send('Runtime.enable');
    await send('Log.enable');
    if (this.options.collectNetwork) await send('Network.enable');
    this.cdp.on(`session:${sid}:Runtime.consoleAPICalled`, (p) => {
      const text = (p.args || [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ')
        .slice(0, 1000);
      this.bus.emit(
        'console',
        { level: p.type, text, frame: info.url },
        { key: `console:${p.type}:${text}`, summary: text.slice(0, 140) },
      );
    });
    this.cdp.on(`session:${sid}:Runtime.exceptionThrown`, (p) => {
      this.bus.emit('pageerror', {
        message: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text,
        frame: info.url,
      });
    });
  }

  // ---- Evaluation ---------------------------------------------------------

  /**
   * @param {string} expression
   * @param {{ awaitPromise?: boolean, returnByValue?: boolean, timeoutMs?: number, args?: any }} [options]
   */
  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 20000, args } = {}) {
    const wrapped = args
      ? `(async () => { const __args = ${JSON.stringify(args)}; return (${expression})(__args); })()`
      : expression;
    const res = await this.cdp.send(
      'Runtime.evaluate',
      {
        expression: wrapped,
        awaitPromise,
        returnByValue,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true,
      },
      { timeoutMs },
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const err = new Error(d.exception?.description || d.text || 'evaluate failed');
      /** @type {any} */ (err).cdp = d;
      throw err;
    }
    return returnByValue ? res.result.value : res.result;
  }

  async callFunction(fnString, arg, opts = {}) {
    // Wrap so we can pass a single JSON arg without string-escaping hazards.
    const expr = `(${fnString})(${JSON.stringify(arg === undefined ? null : arg)})`;
    return this.evaluate(expr, opts);
  }

  // ---- Observation --------------------------------------------------------

  async snapshot(opts = {}) {
    return this.callFunction(snapshotFn.toString(), opts, { timeoutMs: opts.timeoutMs || 15000 });
  }

  async digest() {
    try {
      return await this.callFunction(digestFn.toString(), null, { timeoutMs: 8000 });
    } catch {
      return null;
    }
  }

  async close() {
    if (this._drainTimer) clearInterval(this._drainTimer);
    this._drainTimer = null;
    await this.cdp.close();
  }
}
