// Batch executor: run a list of commands against a tab and, for each command,
// return only the events that command produced. This is the core of the agent
// loop — one HTTP round trip yields N actions *and* their observed effects.

import { actions } from './actions.js';
import { summarize } from './events.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Actions that observe the page without mutating it must not pay the settle
// cost; the page cannot have reacted to a read. `wait` handles its own
// synchronization, so it is included here too.
const READ_ONLY = new Set(['snapshot', 'evaluate', 'getText', 'getHtml', 'screenshot', 'wait']);

export class Executor {
  constructor({ defaultSettleMs = 250, maxSettleMs = 5000 } = {}) {
    this.defaultSettleMs = defaultSettleMs;
    this.maxSettleMs = maxSettleMs;
  }

  /**
   * @param {any} tab
   * @param {any[]} commands
   * @param {{ observe?: string, settleMs?: number, stopOnError?: boolean, timeoutMs?: number }} [options]
   */
  async run(tab, commands, { observe = 'auto', settleMs, stopOnError = false, timeoutMs = 30000 } = {}) {
    const results = [];
    const startSeq = tab.bus.mark();
    let cursor = startSeq;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      const name = cmd.action || cmd.type;
      const fn = actions[name];
      const cmdStart = Date.now();
      const { params = {}, ...rest } = cmd;
      const args = { ...rest, ...params };
      delete args.action;
      delete args.type;

      if (!fn) {
        results.push({
          i,
          action: name,
          ok: false,
          error: `unknown action "${name}"`,
          known: Object.keys(actions),
        });
        if (stopOnError) break;
        continue;
      }

      let result;
      let err;
      try {
        result = await withTimeout(fn(tab, args), timeoutMs, `action "${name}" timed out`);
      } catch (e) {
        err = e;
      }

      // Settle: wait for the page to react before snapshotting deltas. Read-only
      // actions skip this entirely — there is nothing to react to, and paying a
      // fixed delay per command is the difference between a fast loop and a slow
      // one across a batch.
      const readOnly = READ_ONLY.has(name);
      const requested = settleMs !== undefined ? settleMs : this.defaultSettleMs;
      const settleBudget = readOnly ? 0 : requested;
      if (settleBudget > 0) await this._settle(tab, settleBudget);

      // When console events are captured in-page, drain them now so they are
      // attributed to this command's delta window rather than a later one.
      if (tab.options.consoleHook) await tab.drainConsole();

      const events = tab.bus.since(cursor);
      cursor = events.lastSeq;

      const entry = {
        i,
        action: name,
        ok: !err,
        ms: Date.now() - cmdStart,
      };
      if (err) {
        entry.error = err.message;
        if (err.code) entry.code = err.code;
        // Surface structured remediation (selector, hint) from ActionError so
        // the agent can fix the call without another round trip.
        if (err.details) entry.details = err.details;
        // A stale ref is the single most common agent stumble. Rather than make
        // the agent spend another round trip re-snapshotting, hand it the fresh
        // snapshot right here so it can re-target in the same turn.
        if (err.code === 'not_found' || err.code === 'not_visible') {
          try {
            entry.snapshot = await tab.snapshot({ maxNodes: 250, includeText: true });
            entry.hint =
              'element reference is stale (page changed); re-target using a ref from the returned snapshot';
          } catch {
            /* snapshot is best-effort */
          }
        }
      } else if (result !== undefined) {
        entry.result = compact(result);
      }
      entry.events = this._compactEvents(events.events, observe);
      results.push(entry);

      if (err && stopOnError) break;
    }

    const tail = tab.bus.since(cursor);
    const out = {
      cursor: tail.lastSeq,
      results,
    };
    if (observe === 'always' || observe === 'auto') {
      out.snapshot = await this._maybeSnapshot(tab, observe, results);
    }
    return out;
  }

  // Wait for the page to become quiet after a mutating action.
  //
  // The previous implementation polled a DOM digest every 50ms for the whole
  // budget and never exited early (its early-exit flag was never set), so every
  // action paid the full delay AND an evaluate round trip per tick. It also
  // derived "pending requests" from a monotonic CDP timestamp subtracted from
  // Date.now(), which is meaningless.
  //
  // Now: the live `requests` map IS the pending set (entries are removed on
  // loadingFinished/loadingFailed). We poll cheaply (no evaluate) for in-flight
  // network, then exit as soon as the page is idle, up to the budget.
  async _settle(tab, maxMs) {
    const deadline = Date.now() + Math.min(maxMs, this.maxSettleMs);
    // A short floor lets a just-dispatched request register in the map before we
    // conclude the page is idle.
    let sawActivity = false;
    while (Date.now() < deadline) {
      if (tab.requests.size > 0) sawActivity = true;
      if (sawActivity && tab.requests.size === 0) return;
      if (!sawActivity && Date.now() + 60 >= deadline) return;
      await sleep(20);
    }
  }

  _compactEvents(events, observe) {
    if (!events.length) return undefined;
    const summary = summarize(events);
    const payload = {
      count: events.length,
      byType: summary.byType,
    };
    if (summary.highlights.length) payload.highlights = summary.highlights;
    if (observe === 'full') payload.all = events.map(slimEvent);
    return payload;
  }

  async _maybeSnapshot(tab, observe, results) {
    // "auto": only take a snapshot when something plausibly changed the page.
    if (observe === 'auto') {
      const changed = results.some((r) => {
        if (!r.ok) return false;
        if (r.events) return true;
        return [
          'navigate',
          'click',
          'fill',
          'select',
          'press',
          'check',
          'history',
          'scroll',
          'wait',
        ].includes(r.action);
      });
      if (!changed) return undefined;
    }
    if (observe === 'never') return undefined;
    try {
      return await tab.snapshot({ maxNodes: 250, includeText: true });
    } catch (e) {
      return { error: e.message };
    }
  }
}

function slimEvent(e) {
  const d = e.data || {};
  return {
    seq: e.seq,
    type: e.type,
    ...pick(d, ['level', 'text', 'message', 'url', 'status', 'method', 'failure', 'kind']),
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// Screenshots can be hundreds of KB. Keep the base64 only long enough for the
// server to stow it as an artifact; the agent gets a small fetchable handle.
function compact(result) {
  if (result && typeof result === 'object' && result.data && result.format) {
    return {
      format: result.format,
      bytes: result.bytes,
      __artifactData: result.data,
    };
  }
  return result;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]);
}
