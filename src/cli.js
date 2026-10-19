#!/usr/bin/env node
// CLI entry: `pi-browser [options]`
//
// CloakBrowser-only (macOS and Linux). By default the server launches CloakBrowser in
// headed mode against a dedicated profile at ~/.pi-browser/profile (created if
// missing). Pass --attach-only to connect to a browser you started yourself.
//
//   npx cloakbrowser install     # one-time: fetch the stealth Chromium
//   pi-browser                   # launch + serve on http://127.0.0.1:8787

import { createServer } from './server.js';
import { DEFAULT_PROFILE, DEFAULT_CDP_PORT, resolveBinary } from './chrome.js';

export function parseArgs(argv) {
  const opts = {
    port: Number(process.env.CDP_PORT) || DEFAULT_CDP_PORT,
    httpPort: Number(process.env.HTTP_PORT) || 8787,
    host: process.env.HOST || '127.0.0.1',
    autoLaunch: true,
    headless: false,
    userDataDir: process.env.CLOAKBROWSER_PROFILE || DEFAULT_PROFILE,
    binary: process.env.CLOAKBROWSER_BINARY_PATH || null,
    fingerprint: process.env.CLOAKBROWSER_FINGERPRINT || null,
    consoleHook: process.env.CONSOLE_HOOK === '1',
    settleMs: 250,
    debug: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') opts.port = Number(next());
    else if (a === '--http-port') opts.httpPort = Number(next());
    else if (a === '--host') opts.host = next();
    else if (a === '--headless') opts.headless = true;
    else if (a === '--headed') opts.headless = false;
    else if (a === '--attach-only') opts.autoLaunch = false;
    else if (a === '--profile' || a === '--user-data-dir') opts.userDataDir = next();
    else if (a === '--binary' || a === '--chrome') opts.binary = next();
    else if (a === '--fingerprint') opts.fingerprint = next();
    else if (a === '--console-hook') opts.consoleHook = true;
    else if (a === '--settle-ms') opts.settleMs = Number(next());
    else if (a === '--debug') opts.debug = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const HELP = `pi-browser — CloakBrowser control server for coding agents

Usage: pi-browser [options]

  -p, --port <n>         Remote-debugging port (default 9223)
      --http-port <n>    HTTP server port (default 8787)
      --host <addr>      Bind address (default 127.0.0.1)
      --headless         Run without a window (default: headed)
      --headed           Run with a visible window (default)
      --attach-only      Do not launch; attach to a browser already on --port
      --profile <dir>    Profile directory (default ~/.pi-browser/profile,
                         created if missing; holds a stable fingerprint)
      --binary <path>    CloakBrowser binary (default: newest in ~/.cloakbrowser)
      --fingerprint <n>  Fingerprint seed (default: generated once per profile)
      --console-hook     Capture console output and uncaught errors in-page.
                         CloakBrowser does not forward these over CDP, so without
                         this flag console/error events are absent. Wrapping
                         console is a faint fingerprint; enable for debugging.
      --settle-ms <n>    Default settle delay after each action (default 250)
      --debug            Include stack traces in error responses

Typical use:
  npx cloakbrowser install
  pi-browser
`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

// Fail fast with an actionable message if the browser is missing, rather than
// letting the first request discover it.
if (opts.autoLaunch && !opts.binary) {
  try {
    resolveBinary(null);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

const server = createServer({
  port: opts.port,
  autoLaunch: opts.autoLaunch,
  headless: opts.headless,
  userDataDir: opts.userDataDir,
  binary: opts.binary,
  fingerprint: opts.fingerprint,
  consoleHook: opts.consoleHook,
  defaultSettleMs: opts.settleMs,
  debug: opts.debug,
});

server.listen(opts.httpPort, opts.host, async () => {
  const base = `http://${opts.host}:${opts.httpPort}`;
  console.log(`pi-browser listening on ${base}`);
  try {
    const mgr = /** @type {any} */ (server).manager;
    await mgr.connect();
    const how = mgr.launched ? 'launched' : 'attached to';
    console.log(`${how} CloakBrowser on port ${opts.port} (profile: ${opts.userDataDir})`);
    if (!opts.consoleHook) {
      console.log('note: console/error capture is off (enable with --console-hook)');
    }
  } catch (e) {
    console.warn(`warning: not attached yet — ${e.message}`);
  }
});

const shutdown = async () => {
  console.log('\nshutting down…');
  const mgr = /** @type {any} */ (server).manager;
  await mgr.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
