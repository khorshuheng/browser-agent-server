// HTTP + SSE server.
//
// Endpoints (agent-oriented):
//   GET  /health                     -> liveness + chrome/tab state
//   GET  /tabs                       -> list tabs
//   POST /tabs                       -> open a tab            { url }
//   DELETE /tabs/:id                 -> close a tab
//   GET  /tabs/:id/snapshot          -> compact page snapshot  ?maxNodes=&scope=
//   POST /tabs/:id/act               -> run ONE action
//   POST /tabs/:id/batch             -> run N actions, get N deltas (the hot path)
//   GET  /tabs/:id/events            -> SSE stream since a cursor   ?cursor=
//   GET  /events                     -> SSE stream for all tabs
//   GET  /tabs/:id/events.json       -> poll events since cursor (no SSE)
//   GET  /artifacts/:id              -> fetch a stored artifact (screenshots)
//
// Everything returns JSON; SSE frames carry `seq` so the agent can resume.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Manager } from './manager.js';
import { Executor } from './executor.js';
import { listActions, actions } from './actions.js';

const MAX_BODY = 64 * 1024 * 1024;

export function createServer(options = {}) {
  const manager = new Manager(options);
  const executor = new Executor(options);
  const artifacts = new Map(); // id -> { buf, type, ts }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---- helpers ------------------------------------------------------------

  const json = (res, status, body, extraHeaders = {}) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(buf);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`invalid JSON body: ${e.message}`));
        }
      });
      req.on('error', reject);
    });

  const requireTab = async (id) => {
    try {
      return await manager.ensureTab(id === 'default' ? undefined : id);
    } catch (e) {
      const err = new Error(e.message);
      /** @type {any} */ (err).status = 404;
      throw err;
    }
  };

  // Large results (screenshots) are stored out-of-band; the agent receives a
  // small fetchable handle instead of hundreds of KB of base64 in the JSON.
  const stowArtifacts = (out) => {
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.__artifactData) {
        const id = randomUUID();
        artifacts.set(id, {
          buf: Buffer.from(o.__artifactData, 'base64'),
          type: `image/${o.format || 'png'}`,
          ts: Date.now(),
        });
        delete o.__artifactData;
        o.artifact = `/artifacts/${id}`;
        o.truncated = true;
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(out);
    return out;
  };

  // ---- SSE ----------------------------------------------------------------

  const openSse = (req, res, { targetId = null, cursor = 0, types = null, heartbeatMs = 15000 }) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(':ok\n\n');
    req.socket.setNoDelay(true);

    const matches = (evt) => {
      if (targetId && evt.data?.targetId && evt.data.targetId !== targetId) return false;
      if (types && !types.includes(evt.type)) return false;
      return true;
    };

    // Replay everything after the requested cursor immediately (filtered).
    const backlog = manager.events.since(cursor);
    // If the cursor predates the retained buffer, events were evicted. Tell the
    // client explicitly instead of silently continuing with a gap.
    if (backlog.dropped) {
      res.write(
        `event: dropped\ndata: ${JSON.stringify({ requestedCursor: cursor, oldestAvailable: manager.events.buffer[0]?.seq ?? null })}\n\n`,
      );
    }
    for (const evt of backlog.events) if (matches(evt)) writeEvent(evt);

    let lastSeq = backlog.lastSeq;
    const unsub = manager.events.subscribe((evt, meta) => {
      if (!matches(evt)) return;
      if (evt.seq <= lastSeq && !meta.coalesced) return;
      lastSeq = Math.max(lastSeq, evt.seq);
      writeEvent(evt, meta);
    });

    const hb = setInterval(() => {
      res.write(`:hb ${Date.now()}\n\n`);
    }, heartbeatMs);
    hb.unref?.();

    const cleanup = () => {
      clearInterval(hb);
      unsub();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);

    function writeEvent(evt, meta) {
      const frame = { ...evt.data, seq: evt.seq, ts: evt.ts, type: evt.type };
      if (meta?.coalesced) frame.coalesced = true;
      res.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    }
  };

  // ---- routes -------------------------------------------------------------

  route('GET', /^\/health$/, async (_req, res) => {
    let chrome;
    try {
      if (!manager.browser) await manager.connect();
      const v = await manager.browser.version();
      chrome = { product: v.product, protocolVersion: v.protocolVersion };
    } catch (e) {
      return json(res, 200, { ok: false, chrome: { error: e.message }, tabs: [] });
    }
    json(res, 200, { ok: true, chrome, tabs: manager.listTabs(), cursor: manager.events.seq });
  });

  route('GET', /^\/actions$/, async (_req, res) => {
    json(res, 200, {
      actions: listActions(),
      usage: {
        single: 'POST /tabs/<id>/act {"action":"click","ref":"e5"}',
        batch:
          'POST /tabs/<id>/batch {"commands":[{"action":"navigate","url":"..."},{"action":"click","ref":"e5"}],"observe":"auto"}',
      },
    });
  });

  route('GET', /^\/tabs$/, async (_req, res) => json(res, 200, { tabs: manager.listTabs() }));

  route('POST', /^\/tabs$/, async (req, res) => {
    const body = await readBody(req);
    const tab = await manager.newTab(body.url || 'about:blank');
    json(res, 201, { targetId: tab.targetId });
  });

  route('DELETE', /^\/tabs\/([^/]+)$/, async (req, res, [id]) => {
    await manager.closeTab(id);
    json(res, 200, { closed: id });
  });

  route('GET', /^\/tabs\/([^/]+)\/snapshot$/, async (req, res, [id], url) => {
    const tab = await requireTab(id);
    const maxNodes = Number(url.searchParams.get('maxNodes')) || 250;
    const scope = url.searchParams.get('scope') || null;
    const includeText = url.searchParams.get('includeText') !== 'false';
    const snap = await tab.snapshot({ maxNodes, scope, includeText });
    json(res, 200, snap);
  });

  route('GET', /^\/tabs\/([^/]+)\/events\.json$/, async (req, res, [id], url) => {
    const tab = await requireTab(id);
    const cursor = Number(url.searchParams.get('cursor')) || 0;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
    const types = url.searchParams.get('types')?.split(',').filter(Boolean) || null;
    const r = manager.events.since(cursor);
    // Scope to this tab, matching the SSE endpoint. This route previously
    // returned the global buffer regardless of :id, which leaked other tabs'
    // events (and made the cursor/page semantics wrong) for polling clients.
    let events = r.events.filter((e) => e.data?.targetId === tab.targetId);
    if (types) events = events.filter((e) => types.includes(e.type));
    const page = events.slice(0, limit);
    const nextCursor = page.length ? page[page.length - 1].seq : r.lastSeq;
    json(res, 200, {
      cursor: nextCursor,
      head: r.lastSeq,
      dropped: r.dropped || false,
      // Metadata last so a stray field in the event data cannot clobber the
      // envelope (e.g. a network resource `type` overriding the event type).
      events: page.map((e) => ({ ...e.data, seq: e.seq, ts: e.ts, type: e.type })),
      more: events.length > page.length || undefined,
    });
  });

  route('GET', /^\/tabs\/([^/]+)\/events$/, async (req, res, [id], url) => {
    const tab = await requireTab(id);
    const cursor = Number(url.searchParams.get('cursor')) || 0;
    const types = url.searchParams.get('types')?.split(',').filter(Boolean) || null;
    openSse(req, res, { targetId: tab.targetId, cursor, types });
  });

  route('GET', /^\/events$/, async (req, res, _params, url) => {
    const cursor = Number(url.searchParams.get('cursor')) || 0;
    openSse(req, res, { cursor });
  });

  route('POST', /^\/tabs\/([^/]+)\/act$/, async (req, res, [id]) => {
    const tab = await requireTab(id);
    const body = await readBody(req);
    const out = await executor.run(tab, [body], {
      observe: body.observe || 'auto',
      settleMs: body.settleMs,
      stopOnError: true,
    });
    const r = out.results[0];
    // `r.snapshot` may be a stale-ref recovery snapshot; only override it when
    // the executor produced a top-level observe snapshot.
    const payload = { ...r, cursor: out.cursor };
    if (out.snapshot) payload.snapshot = out.snapshot;
    json(res, r.ok ? 200 : 400, stowArtifacts(payload));
  });

  // The hot path: many commands, one round trip, per-command deltas.
  route('POST', /^\/tabs\/([^/]+)\/batch$/, async (req, res, [id]) => {
    const tab = await requireTab(id);
    const body = await readBody(req);
    const commands = body.commands || body.actions;
    if (!Array.isArray(commands)) {
      return json(res, 400, { error: 'body.commands must be an array' });
    }
    if (commands.length > 500) {
      return json(res, 400, { error: 'too many commands (max 500 per batch)' });
    }
    const out = await executor.run(tab, commands, {
      observe: body.observe || 'auto',
      settleMs: body.settleMs,
      stopOnError: !!body.stopOnError,
      timeoutMs: body.timeoutMs || 30000,
    });
    json(res, 200, stowArtifacts(out));
  });

  route('GET', /^\/artifacts\/([^/]+)$/, async (_req, res, [id]) => {
    const art = artifacts.get(id);
    if (!art) return json(res, 404, { error: 'artifact not found or expired' });
    res.writeHead(200, { 'content-type': art.type, 'content-length': art.buf.length });
    res.end(art.buf);
  });

  // ---- dispatcher ---------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(path);
        if (m) return await r.handler(req, res, m.slice(1), url);
      }
      json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (e) {
      const status = e.status || 500;
      if (!res.headersSent)
        json(res, status, { error: e.message, stack: options.debug ? e.stack : undefined });
      else res.end();
    }
  });

  /** @type {any} */ (server).manager = manager;
  /** @type {any} */ (server).executor = executor;
  // Periodic artifact GC.
  const gc = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, a] of artifacts) if (a.ts < cutoff) artifacts.delete(id);
  }, 60_000);
  gc.unref?.();
  server.on('close', () => clearInterval(gc));
  return server;
}

export { actions };
