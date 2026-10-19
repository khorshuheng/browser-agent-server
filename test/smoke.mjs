#!/usr/bin/env node
// Hermetic smoke test.
//
// Launches a headless Chrome with a throwaway profile on a private port, starts
// the control server in-process, then exercises the real HTTP/SSE surface
// against local file:// fixtures (no network dependency).
//
//   node test/smoke.mjs
//
// Exits non-zero on the first failed assertion. Always cleans up its child
// Chrome and temp profile.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { resolveBinary, stealthArgs } from '../src/chrome.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = `file://${join(__dirname, 'fixtures', 'form.html')}`;
const UPLOAD_FIXTURE = `file://${join(__dirname, 'fixtures', 'upload.html')}`;

// CloakBrowser-only server: resolve the stealth Chromium binary. Allow an
// override via SMOKE_CHROME and extra flags via SMOKE_ARGS.
const BINARY = process.env.SMOKE_CHROME || resolveBinary(null);
const EXTRA_ARGS = (process.env.SMOKE_ARGS || '').split(/\s+/).filter(Boolean);
// Console capture is optional and off by default; gate the console/error
// assertions on it so the suite is meaningful in both modes.
const CONSOLE_HOOK = process.env.CONSOLE_HOOK === '1';
// Headed by default (matching the server); SMOKE_HEADLESS=1 runs headless.
const HEADLESS = process.env.SMOKE_HEADLESS === '1';

const CDP_PORT = Number(process.env.SMOKE_CDP_PORT) || 9444;
const HTTP_PORT = Number(process.env.SMOKE_HTTP_PORT) || 8977;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const VERBOSE = !!process.env.DEBUG;

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(name);
    console.log(`  \u2717 ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

// --- Chrome lifecycle ------------------------------------------------------

function launchBrowser(profile) {
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    ...stealthArgs(4242),
    ...(HEADLESS ? ['--headless=new', '--disable-gpu'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...EXTRA_ARGS,
    'about:blank',
  ];
  // Keep the tail of the browser's output: when the launch fails (missing
  // sandbox, bad flags, unresolvable libs) that stderr is the only diagnosis,
  // and CI only ever sees it if we capture it here.
  /** @type {string[]} */
  const output = [];
  const child = spawn(BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      const text = String(chunk);
      output.push(text);
      if (output.length > 40) output.shift();
      if (VERBOSE) process.stderr.write(text);
    });
  }
  child.on('error', () => {});
  /** @type {any} */ (child).output = output;
  return child;
}

async function waitForBrowser(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

// --- Tests -----------------------------------------------------------------

async function runTests() {
  console.log('\nhealth');
  {
    const { status, body } = await api('/health');
    check('responds 200', status === 200, status);
    check('reports ok', body.ok === true, JSON.stringify(body));
    check('reports chrome product', /Chrome\//.test(body.chrome?.product || ''), body.chrome?.product);
  }

  console.log('\ntabs');
  const created = await api('/tabs', { method: 'POST', body: { url: FIXTURE } });
  check('creates a tab', created.status === 201, created.status);
  const tab = created.body.targetId;
  check('returns a targetId', typeof tab === 'string' && tab.length > 0);
  await sleep(400);

  console.log('\nsnapshot');
  const snap = await api(`/tabs/${tab}/snapshot`);
  const roles = new Set((snap.body.nodes || []).map((n) => n.role));
  check('has a title', snap.body.title === 'Fixture: Form', snap.body.title);
  check('exposes a textbox', roles.has('textbox'));
  check('exposes a combobox', roles.has('combobox'));
  check('exposes a checkbox', roles.has('checkbox'));
  check('exposes a button', roles.has('button'));
  check(
    'every node has a ref',
    (snap.body.nodes || []).every((n) => typeof n.ref === 'string'),
  );

  const byName = (name) => (snap.body.nodes || []).find((n) => n.name === name)?.ref;
  const emailRef = byName('Email');
  const countryRef = (snap.body.nodes || []).find((n) => n.role === 'combobox')?.ref;
  const tosRef = (snap.body.nodes || []).find((n) => n.role === 'checkbox')?.ref;
  const submitRef = (snap.body.nodes || []).find(
    (n) => n.role === 'button' && n.name === 'Create account',
  )?.ref;

  console.log('\nbatch (snapshot -> act on refs)');
  const batch = await api(`/tabs/${tab}/batch`, {
    method: 'POST',
    body: {
      commands: [
        { action: 'fill', ref: emailRef, value: 'agent@pi.dev' },
        { action: 'select', ref: countryRef, value: 'sg' },
        { action: 'check', ref: tosRef },
        { action: 'fill', selector: '#bio', value: 'hello' },
        { action: 'hover', selector: '#hover-target' },
        { action: 'click', ref: submitRef },
      ],
      observe: 'auto',
    },
  });
  check('all steps reported', batch.body.results?.length === 6);
  check(
    'all steps ok',
    (batch.body.results || []).every((r) => r.ok),
    JSON.stringify((batch.body.results || []).filter((r) => !r.ok)),
  );
  check('fill verifies its value', batch.body.results[0]?.result?.value === 'agent@pi.dev');
  check('check verifies state', batch.body.results[2]?.result?.changed === true);
  check('observe:auto returns a snapshot', typeof batch.body.snapshot?.url === 'string');
  check('form submitted', batch.body.snapshot?.title === 'Submitted', batch.body.snapshot?.title);

  console.log('\npage state verification (evaluate)');
  const state = await api(`/tabs/${tab}/act`, {
    method: 'POST',
    body: {
      action: 'evaluate',
      expression:
        "({email:document.querySelector('#email').value,country:document.querySelector('#country').value,tos:document.querySelector('#tos').checked,bio:document.querySelector('#bio').value,hover:document.querySelector('#hover-target').textContent})",
      observe: 'never',
    },
  });
  const v = state.body.result?.value || {};
  check('email persisted', v.email === 'agent@pi.dev', v.email);
  check('select persisted', v.country === 'sg', v.country);
  check('checkbox persisted', v.tos === true, v.tos);
  check('textarea persisted', v.bio === 'hello', v.bio);
  check('hover fired', v.hover === 'hovered!', v.hover);

  console.log(`\nconsole + errors (hook ${CONSOLE_HOOK ? 'on' : 'off'})`);
  const flood = await api(`/tabs/${tab}/act`, {
    method: 'POST',
    body: { action: 'click', selector: '#flood', observe: 'never' },
  });
  const floodConsole = flood.body.events?.byType?.console || 0;

  const boom = await api(`/tabs/${tab}/act`, {
    method: 'POST',
    body: { action: 'click', selector: '#boom', observe: 'never' },
  });

  if (CONSOLE_HOOK) {
    check('200 repeated logs coalesce to few events', floodConsole > 0 && floodConsole < 10, floodConsole);
    check(
      'surfaces the thrown page error',
      boom.body.events?.byType?.pageerror === 1,
      JSON.stringify(boom.body.events?.byType),
    );
    check(
      'error appears in highlights',
      (boom.body.events?.highlights || []).some((h) => h.includes('intentional explosion')),
    );
  } else {
    // CloakBrowser does not forward console/exception events over CDP, so with
    // the hook disabled the correct behaviour is to observe none of them.
    check('console is not captured without the hook', floodConsole === 0, floodConsole);
    check(
      'page errors are not captured without the hook',
      !boom.body.events?.byType?.pageerror,
      JSON.stringify(boom.body.events?.byType),
    );
    console.log('    (set CONSOLE_HOOK=1 to assert full console/error capture)');
  }

  console.log('\nstale-ref recovery');
  const stale = await api(`/tabs/${tab}/act`, {
    method: 'POST',
    body: { action: 'click', ref: 'e999999', observe: 'never' },
  });
  check('fails with not_found', stale.body.code === 'not_found', stale.body.code);
  check('returns a recovery snapshot', (stale.body.snapshot?.nodes || []).length > 0);
  check('includes a hint', typeof stale.body.hint === 'string');

  console.log('\nunknown action');
  const unknown = await api(`/tabs/${tab}/act`, {
    method: 'POST',
    body: { action: 'definitely_not_real' },
  });
  check('rejects unknown action', unknown.body.ok === false);
  check('lists known actions', Array.isArray(unknown.body.known));

  console.log('\nscreenshot artifact');
  const shot = await api(`/tabs/${tab}/act`, {
    method: 'POST',
    body: { action: 'screenshot', format: 'png', observe: 'never' },
  });
  const artifact = shot.body.result?.artifact;
  check('returns an artifact handle', typeof artifact === 'string' && artifact.startsWith('/artifacts/'));
  if (artifact) {
    const bytes = await fetch(BASE + artifact).then((r) => r.arrayBuffer());
    check('artifact is fetchable', bytes.byteLength > 0, bytes.byteLength);
  }

  console.log('\nevent paging (no gaps, no overlap)');
  {
    const a = await api(`/tabs/${tab}/events.json?cursor=0&limit=5`);
    const cursor = a.body.cursor;
    const b = await api(`/tabs/${tab}/events.json?cursor=${cursor}&limit=5`);
    const sa = (a.body.events || []).map((e) => e.seq);
    const sb = (b.body.events || []).map((e) => e.seq);
    check('first page has events', sa.length > 0, sa.length);
    check(
      'pages do not overlap',
      sa.every((s) => !sb.includes(s)),
      `${sa} vs ${sb}`,
    );
    if (sa.length && sb.length) check('pages are contiguous', sb[0] === sa[sa.length - 1] + 1);
    check(
      'events carry a targetId',
      a.body.events?.[0]?.targetId === tab,
      `first=${a.body.events?.[0]?.targetId} want=${tab} n=${a.body.events?.length}`,
    );
  }

  console.log('\nSSE per-tab isolation');
  {
    const other = await api('/tabs', { method: 'POST', body: { url: 'about:blank' } });
    const otherId = other.body.targetId;
    await sleep(300);

    const ctrl = new AbortController();
    const frames = [];
    const sse = fetch(`${BASE}/tabs/${otherId}/events?cursor=0`, {
      headers: { accept: 'text/event-stream' },
      signal: ctrl.signal,
    })
      .then(async (res) => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line) {
              try {
                frames.push(JSON.parse(line.slice(6)));
              } catch {
                /* ignore */
              }
            }
          }
        }
      })
      .catch(() => {});

    await sleep(300);
    // Generate traffic on the OTHER tab; it must not leak into this stream.
    await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: { action: 'navigate', url: FIXTURE, observe: 'never' },
    });
    await api(`/tabs/${otherId}/act`, {
      method: 'POST',
      body: { action: 'navigate', url: 'about:blank', observe: 'never' },
    });
    await sleep(600);
    ctrl.abort();
    await sse;

    check('stream received frames', frames.length > 0, frames.length);
    check(
      'no cross-tab leakage',
      frames.every((f) => f.targetId === otherId),
      JSON.stringify(frames.filter((f) => f.targetId !== otherId).slice(0, 3)),
    );
  }

  console.log('\nread-only fast path');
  {
    const t0 = Date.now();
    const fast = await api(`/tabs/${tab}/batch`, {
      method: 'POST',
      body: {
        commands: [
          { action: 'evaluate', expression: '1' },
          { action: 'evaluate', expression: '2' },
        ],
        observe: 'never',
      },
    });
    const total = Date.now() - t0;
    const sum = (fast.body.results || []).reduce((s, r) => s + (r.ms || 0), 0);
    check('read-only batch avoids settle delay', sum < 100, `${sum}ms (wall ${total}ms)`);
  }

  console.log('\nfile input (setFiles)');
  {
    const dir = mkdtempSync(join(tmpdir(), 'pi-upload-'));
    const file = join(dir, 'receipt.txt');
    writeFileSync(file, 'hello receipt');

    await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: { action: 'navigate', url: UPLOAD_FIXTURE, observe: 'never' },
    });
    await sleep(200);

    const set = await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: { action: 'setFiles', selector: '#file-input', files: [file], observe: 'never' },
    });
    check('setFiles succeeds', set.body.ok === true, set.body.error);
    await sleep(200);
    const report = await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: {
        action: 'evaluate',
        expression: 'document.querySelector("#files-report").textContent',
        observe: 'never',
      },
    });
    check(
      'file input change fired with filename',
      report.body.result?.value === 'receipt.txt',
      report.body.result?.value,
    );

    // The change event still fires even when the app clears input.files -- the
    // exact pattern that disguised a broken upload against a live site.
    const set2 = await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: { action: 'setFiles', selector: '#file-input-reset', files: [file], observe: 'never' },
    });
    check('setFiles succeeds on a self-clearing input', set2.body.ok === true, set2.body.error);
    await sleep(200);
    const reset = await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: {
        action: 'evaluate',
        expression: 'document.querySelector("#reset-report").textContent',
        observe: 'never',
      },
    });
    check(
      'self-clearing input still reported the file',
      reset.body.result?.value === 'receipt.txt',
      reset.body.result?.value,
    );

    console.log('\ndropzone (dropFiles)');
    const drop = await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: { action: 'dropFiles', selector: '#dropzone', files: [file], observe: 'never' },
    });
    check('dropFiles succeeds', drop.body.ok === true, drop.body.error);
    await sleep(200);
    const dropped = await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: {
        action: 'evaluate',
        expression: 'document.querySelector("#drop-report").textContent',
        observe: 'never',
      },
    });
    check(
      'drop handler received the filename',
      dropped.body.result?.value === 'receipt.txt',
      dropped.body.result?.value,
    );

    console.log('\nfile attach error paths');
    const wrong = await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: { action: 'setFiles', selector: '#dropzone', files: [file], observe: 'never' },
    });
    check('setFiles on a non-input fails', wrong.body.ok === false);
    check('failure carries a structured code', wrong.body.code === 'wrong_type', wrong.body.code);
    check(
      'failure hints at dropFiles',
      /dropFiles/.test(wrong.body.details?.hint || wrong.body.error || ''),
      wrong.body.details?.hint,
    );
    const missing = await api(`/tabs/${tab}/act`, {
      method: 'POST',
      body: { action: 'setFiles', selector: '#does-not-exist', files: [file], observe: 'never' },
    });
    check('setFiles on a missing selector fails', missing.body.ok === false);
    check('missing-selector code is no_file_input', missing.body.code === 'no_file_input', missing.body.code);

    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nclose tab');
  {
    const closed = await api(`/tabs/${tab}`, { method: 'DELETE' });
    check('closes cleanly', closed.status === 200, closed.status);
  }
}

// --- Main ------------------------------------------------------------------

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'pi-smoke-'));
  const browser = launchBrowser(profile);
  let server;

  const cleanup = async () => {
    if (server) await new Promise((r) => server.close(r));
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    if (!(await waitForBrowser())) {
      const tail = (browser.output || []).join('').trim();
      throw new Error(
        `CloakBrowser did not start on port ${CDP_PORT}${tail ? `\nbrowser output:\n${tail}` : ''}`,
      );
    }
    console.log(`chrome ready on ${CDP_PORT}`);

    server = createServer({
      port: CDP_PORT,
      autoLaunch: false, // the suite launches the browser itself
      consoleHook: CONSOLE_HOOK,
    });
    await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
    console.log(`server listening on ${BASE}`);

    await runTests();

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log('failed:');
      for (const f of failures) console.log(`  - ${f}`);
    }
    await cleanup();
    process.exit(failures.length ? 1 : 0);
  } catch (err) {
    console.error('\nsmoke test error:', err.message);
    await cleanup();
    process.exit(1);
  }
}

main();
