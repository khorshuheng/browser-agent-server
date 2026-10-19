// Sequence-numbered, bounded, coalescing event log. Every signal a browser
// emits (console, network, navigation, errors, DOM digests) lands here. Agents
// subscribe with a cursor and get only what happened since; high-frequency
// events are coalesced so a fast page never floods the stream.

export class EventBus {
  constructor({ capacity = 2000, coalesceWindowMs = 0 } = {}) {
    this.capacity = capacity;
    this.coalesceWindowMs = coalesceWindowMs;
    this.seq = 0;
    this.buffer = []; // { seq, ts, type, data, summary }
    this.subscribers = new Set();
    this._lastByKey = new Map();
  }

  // key: optional coalescing key. If an event with the same key was emitted
  // within coalesceWindowMs, it is merged (summary updated) instead of appended.
  emit(type, data, { key = null, summary = null } = {}) {
    const now = Date.now();
    if (key && this.coalesceWindowMs > 0) {
      const prev = this._lastByKey.get(key);
      if (prev && now - prev.ts < this.coalesceWindowMs) {
        prev.data = data;
        prev.ts = now;
        prev.count = (prev.count || 1) + 1;
        prev.summary = summary || prev.summary;
        this._notify(prev, { coalesced: true });
        return prev;
      }
    }
    const evt = { seq: ++this.seq, ts: now, type, data, summary, key };
    if (key) this._lastByKey.set(key, evt);
    this.buffer.push(evt);
    if (this.buffer.length > this.capacity) {
      const removed = this.buffer.splice(0, this.buffer.length - this.capacity);
      for (const r of removed) {
        // Evict the coalescing entry only if it still points at this event.
        if (r.key && this._lastByKey.get(r.key) === r) this._lastByKey.delete(r.key);
      }
    }
    this._notify(evt, { coalesced: false });
    return evt;
  }

  _notify(evt, meta) {
    for (const sub of this.subscribers) {
      try {
        sub(evt, meta);
      } catch {
        /* subscriber errors must never break the bus */
      }
    }
  }

  since(cursor = 0) {
    // O(log n)-ish: buffer is append-ordered by seq.
    const events = this.buffer.filter((e) => e.seq > cursor);
    const lastSeq = events.length ? events[events.length - 1].seq : cursor;
    return { events, lastSeq, dropped: cursor > 0 && this.buffer.length && cursor < this.buffer[0].seq - 1 };
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  mark() {
    return this.seq;
  }
}

// Reduce a raw event list into a token-cheap "what changed" digest for the agent.
export function summarize(events) {
  const byType = {};
  const highlights = [];
  for (const e of events) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    if (e.type === 'console' && (e.data.level === 'error' || e.data.level === 'warning')) {
      highlights.push(`[${e.data.level}] ${e.data.text}`);
    } else if (e.type === 'pageerror') {
      highlights.push(`[pageerror] ${e.data.message}`);
    } else if (e.type === 'requestfailed') {
      highlights.push(`[netfail] ${e.data.method} ${e.data.url} ${e.data.failure}`);
    } else if (e.type === 'response' && e.data.status >= 400) {
      highlights.push(`[http ${e.data.status}] ${e.data.method} ${e.data.url}`);
    } else if (e.type === 'navigation') {
      highlights.push(`[nav] ${e.data.url}`);
    } else if (e.type === 'dialog') {
      highlights.push(`[dialog ${e.data.kind}] ${e.data.message || ''}`);
    } else if (e.type === 'download') {
      highlights.push(`[download] ${e.data.filename || e.data.url}`);
    }
  }
  return { byType, highlights: highlights.slice(0, 40), total: events.length };
}

// deliberate bad formatting
