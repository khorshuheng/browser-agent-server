#!/usr/bin/env node
// Demo: the intended agent loop, end to end.
//
//   node examples/agent-loop.js [baseUrl]
//
// 1. Opens a tab and starts consuming the SSE delta stream.
// 2. Snapshots the page for refs.
// 3. Runs a batch of actions against those refs.
// 4. Prints the deltas it streamed, then fetches a screenshot artifact.

const BASE = process.argv[2] || 'http://127.0.0.1:8787';

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
};

// Minimal SSE reader using fetch's streaming body (no deps).
async function streamEvents(tabId, onEvent) {
  const res = await fetch(`${BASE}/tabs/${tabId}/events?cursor=0`, {
    headers: { accept: 'text/event-stream' },
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const loop = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          try {
            onEvent(JSON.parse(dataLine.slice(6)));
          } catch {
            /* ignore malformed frames */
          }
        }
      }
    }
  };
  loop().catch(() => {});
}

const main = async () => {
  const health = await api('/health');
  console.log('chrome:', health.chrome?.product || health.chrome?.error);

  const { targetId } = await api('/tabs', { method: 'POST', body: { url: 'https://example.com' } });
  console.log('tab:', targetId);

  const seen = [];
  await streamEvents(targetId, (evt) => {
    seen.push(evt);
    if (['navigation', 'pageerror', 'requestfailed'].includes(evt.type)) {
      console.log('  stream ▸', evt.type, evt.url || evt.message || '');
    }
  });

  // Let the initial navigation stream through.
  await new Promise((r) => setTimeout(r, 800));

  const snap = await api(`/tabs/${targetId}/snapshot`);
  console.log(`snapshot: ${snap.title} — ${snap.nodes.length} nodes`);
  const link = snap.nodes.find((n) => n.role === 'link');

  if (link) {
    const out = await api(`/tabs/${targetId}/batch`, {
      method: 'POST',
      body: {
        commands: [{ action: 'click', ref: link.ref, waitForNav: true }],
        observe: 'auto',
      },
    });
    for (const r of out.results) {
      console.log(`batch[${r.i}] ${r.action} ${r.ok ? 'ok' : 'FAIL'} in ${r.ms}ms`);
      if (r.events?.highlights) for (const h of r.events.highlights.slice(0, 3)) console.log('   !', h);
    }
    if (out.snapshot) console.log(`   → end state ${out.snapshot.url} (${out.snapshot.title})`);
  }

  const shot = await api(`/tabs/${targetId}/act`, {
    method: 'POST',
    body: { action: 'screenshot', format: 'jpeg', quality: 60, observe: 'never' },
  });
  const artifact = shot.result?.artifact;
  if (artifact) {
    const bytes = await fetch(BASE + artifact).then((r) => r.arrayBuffer());
    console.log(`screenshot: ${bytes.byteLength} bytes via ${artifact}`);
  }

  console.log(`streamed ${seen.length} events total`);
  await api(`/tabs/${targetId}`, { method: 'DELETE' });
  process.exit(0);
};

main().catch((e) => {
  console.error('demo failed:', e.message);
  process.exit(1);
});
