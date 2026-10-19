// CloakBrowser lifecycle (macOS).
//
// CloakBrowser is a stealth Chromium with source-level fingerprint patches. It
// is a standard Chromium binary, so this server drives it over plain CDP; we
// only need to locate the binary, launch it with a dedicated profile and the
// stealth flags, and attach to its debugging endpoint.
//
// Binary resolution order:
//   1. an explicit path (--binary)
//   2. $CLOAKBROWSER_BINARY_PATH
//   3. the newest install under ~/.cloakbrowser/chromium-*/
//
// Install it once with: npx cloakbrowser install

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, fetchBrowserEndpoint } from './cdp.js';

export const CLOAK_HOME = join(homedir(), '.cloakbrowser');
export const MAC_RELATIVE_BINARY = 'Chromium.app/Contents/MacOS/Chromium';
export const DEFAULT_PROFILE = join(homedir(), '.pi-browser', 'profile');
// Deliberately not 9222: that is the conventional Chrome debugging port and is
// frequently already taken by a user's own Chrome. Attaching to the wrong
// browser (and driving the user's real profile) is the failure we most want to
// avoid, so CloakBrowser gets its own well-known port.
export const DEFAULT_CDP_PORT = 9223;
export const INSTALL_HINT = 'Run `npx cloakbrowser install` (or pass --binary <path>).';

function isExecutable(p) {
  try {
    return !!p && existsSync(p);
  } catch {
    return false;
  }
}

// Newest installed CloakBrowser binary, or null. Directories look like
// chromium-145.0.7632.109.2, so compare version components numerically.
export function findInstalledBinary() {
  try {
    const dirs = readdirSync(CLOAK_HOME).filter((d) => d.startsWith('chromium-'));
    const sorted = dirs.sort((a, b) => {
      const pa = a.replace('chromium-', '').split('.').map(Number);
      const pb = b.replace('chromium-', '').split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] || 0) - (pa[i] || 0);
        if (d) return d;
      }
      return 0;
    });
    for (const d of sorted) {
      const bin = join(CLOAK_HOME, d, MAC_RELATIVE_BINARY);
      if (isExecutable(bin)) return bin;
    }
  } catch {
    /* not installed */
  }
  return null;
}

export function resolveBinary(explicit) {
  const candidate = explicit || process.env.CLOAKBROWSER_BINARY_PATH || findInstalledBinary();
  if (!candidate) {
    throw new Error(`CloakBrowser binary not found in ${CLOAK_HOME}. ${INSTALL_HINT}`);
  }
  if (!isExecutable(candidate)) {
    throw new Error(`CloakBrowser binary is not executable: ${candidate}`);
  }
  return candidate;
}

// A persistent profile wants a stable fingerprint, so the seed is generated
// once and stored beside the profile rather than randomised on every launch.
export function resolveFingerprint(userDataDir, explicit) {
  if (explicit != null && explicit !== '') return String(explicit);
  const seedFile = join(userDataDir, 'fingerprint.txt');
  try {
    const existing = readFileSync(seedFile, 'utf8').trim();
    if (/^\d+$/.test(existing)) return existing;
  } catch {
    /* first run */
  }
  const seed = String(Math.floor(Math.random() * 90000) + 10000);
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(seedFile, seed);
  } catch {
    /* best effort */
  }
  return seed;
}

export function stealthArgs(fingerprint) {
  return [`--fingerprint=${fingerprint}`, '--fingerprint-platform=macos'];
}

export async function isBrowserListening(port, timeoutMs = 1500) {
  try {
    return (await fetchBrowserEndpoint(port, { timeoutMs })) || false;
  } catch {
    return false;
  }
}

// --- ownership tracking ----------------------------------------------------
//
// We only ever attach to a browser this server launched, unless the caller
// explicitly opts in with --attach-only. Ownership is recorded as a pid file
// beside the profile, so a later run can tell "our CloakBrowser is still up"
// apart from "something else is squatting on the port".

export function pidFileFor(userDataDir) {
  return join(userDataDir, 'browser.pid');
}

export function writePidFile(userDataDir, pid) {
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(pidFileFor(userDataDir), String(pid));
  } catch {
    /* best effort */
  }
}

export function readPidFile(userDataDir) {
  try {
    const raw = readFileSync(pidFileFor(userDataDir), 'utf8').trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

export function clearPidFile(userDataDir) {
  try {
    rmSync(pidFileFor(userDataDir), { force: true });
  } catch {
    /* best effort */
  }
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Launch CloakBrowser against a dedicated profile. Returns the child process.
export function launchCloak({
  binary,
  port = 9222,
  userDataDir = DEFAULT_PROFILE,
  headless = false,
  fingerprint,
  extraArgs = [],
  startUrl = 'about:blank',
}) {
  const bin = resolveBinary(binary);
  const profile = userDataDir || DEFAULT_PROFILE;
  mkdirSync(profile, { recursive: true });
  const seed = resolveFingerprint(profile, fingerprint);

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    ...stealthArgs(seed),
    '--no-first-run',
    '--no-default-browser-check',
    // Keep the page active even when the window is occluded; important for
    // timers, animations and requestAnimationFrame during automation.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    startUrl,
  ];
  const child = spawn(bin, args, { stdio: 'ignore', detached: false });
  child.on('error', () => {});
  /** @type {any} */ (child).binary = bin;
  return child;
}

// Wait until the debugging port answers, then return the browser ws endpoint.
export async function waitForBrowser(port, { timeoutMs = 25000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await isBrowserListening(port, 1000);
    if (url) return url;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`CloakBrowser did not expose a debugging endpoint on port ${port} within ${timeoutMs}ms`);
}

// Browser-level connection with a couple of convenience helpers.
export class Browser extends CdpConnection {
  constructor(wsUrl) {
    super(wsUrl, { label: 'browser' });
    this.targets = new Map(); // targetId -> info
  }

  async init() {
    await this.ready;
    this.on('event:Target.targetCreated', (p) => this.targets.set(p.targetInfo.targetId, p.targetInfo));
    this.on('event:Target.targetInfoChanged', (p) => this.targets.set(p.targetInfo.targetId, p.targetInfo));
    this.on('event:Target.targetDestroyed', (p) => this.targets.delete(p.targetId));
    // Discover targets but do NOT auto-attach from the browser socket: we open a
    // dedicated connection per page. Browser-level auto-attach combined with a
    // per-tab Target.setAutoAttach causes recursive attach/detach and can tear
    // down targets unexpectedly.
    await this.send('Target.setDiscoverTargets', { discover: true });
    return this;
  }

  async closePage(targetId) {
    await this.send('Target.closeTarget', { targetId });
  }

  listPages() {
    return [...this.targets.values()].filter((t) => t.type === 'page');
  }

  async version() {
    return this.send('Browser.getVersion');
  }
}
