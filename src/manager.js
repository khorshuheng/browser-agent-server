// Manager owns the lifecycle of the CloakBrowser attachment and all Tabs.
//
// The server is CloakBrowser-only: it locates the stealth Chromium binary,
// launches it against a dedicated profile if nothing is already listening, and
// attaches over CDP. Set autoLaunch:false to only attach.

import {
  Browser,
  isBrowserListening,
  launchCloak,
  waitForBrowser,
  resolveBinary,
  readPidFile,
  writePidFile,
  clearPidFile,
  isProcessAlive,
  DEFAULT_PROFILE,
  DEFAULT_CDP_PORT,
} from './chrome.js';
import { Tab } from './session.js';
import { EventBus } from './events.js';
import { fetchBrowserEndpoint } from './cdp.js';

export class Manager {
  constructor(options = {}) {
    this.options = {
      port: DEFAULT_CDP_PORT,
      autoLaunch: true,
      headless: false, // headed by default: visible, debuggable, less detectable
      userDataDir: DEFAULT_PROFILE,
      binary: null, // resolved via chrome.js when launching
      fingerprint: null, // persisted in the profile when omitted
      consoleHook: false, // capture console/errors in-page (see session.js)
      eventCapacity: 4000,
      coalesceWindowMs: 400,
      collectNetwork: true,
      collectConsole: true,
      ...options,
    };
    this.events = new EventBus({
      capacity: this.options.eventCapacity,
      coalesceWindowMs: this.options.coalesceWindowMs,
    });
    this.browser = null;
    this.tabs = new Map(); // targetId -> Tab
    this._launchedChild = null;
    this._connecting = null;
  }

  async connect() {
    if (this.browser && !this.browser.closed) return this.browser;
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async _doConnect() {
    const profile = this.options.userDataDir || DEFAULT_PROFILE;
    let wsUrl = await isBrowserListening(this.options.port);

    if (wsUrl) {
      // Never silently drive a browser we did not start — it could be the
      // user's own Chrome. Only a live pid we recorded for this profile counts
      // as "ours"; --attach-only (autoLaunch:false) opts into anything.
      if (this.options.autoLaunch && !this._isOurBrowser(profile)) {
        throw new Error(
          `Port ${this.options.port} is in use by a browser this server did not start.\n` +
            `  * pass --attach-only to use it anyway, or\n` +
            `  * pass --port <n> to use a free port.`,
        );
      }
    } else {
      if (!this.options.autoLaunch) {
        throw new Error(
          `Nothing listening on port ${this.options.port} and auto-launch is off. ` +
            `Start CloakBrowser yourself or drop --attach-only.`,
        );
      }
      this._launchedChild = launchCloak({
        binary: this.options.binary,
        port: this.options.port,
        userDataDir: profile,
        headless: this.options.headless,
        fingerprint: this.options.fingerprint,
      });
      writePidFile(profile, this._launchedChild.pid);
      wsUrl = await waitForBrowser(this.options.port);
    }

    const browser = new Browser(wsUrl);
    await browser.init();
    this.browser = browser;

    // Track page targets as they appear so teardown stays in sync.
    browser.on('event:Target.targetDestroyed', (p) => {
      const t = this.tabs.get(p.targetId);
      if (t) t.close().catch(() => {});
      this.tabs.delete(p.targetId);
    });
    browser.on('close', () => {
      this.browser = null;
      this.tabs.clear();
    });

    // Attach to pages that already exist.
    const existing = await browser.send('Target.getTargets');
    for (const t of existing.targetInfos.filter((t) => t.type === 'page')) {
      await this._attachTab(t);
    }
    return browser;
  }

  // True when a pid file for this profile points at a live process.
  _isOurBrowser(profile) {
    const pid = readPidFile(profile);
    return !!(pid && isProcessAlive(pid));
  }

  async _attachTab(info) {
    if (this.tabs.has(info.targetId)) return this.tabs.get(info.targetId);
    const endpoint = info.webSocketDebuggerUrl || (await this._resolveTargetWs(info.targetId));
    if (!endpoint) return null;
    const tab = new Tab({
      targetId: info.targetId,
      wsUrl: endpoint,
      events: this.events,
      options: {
        collectNetwork: this.options.collectNetwork,
        collectConsole: this.options.collectConsole,
        consoleHook: this.options.consoleHook,
      },
    });
    this.tabs.set(info.targetId, tab);
    try {
      await tab.attach();
    } catch (e) {
      this.tabs.delete(info.targetId);
      throw e;
    }
    return tab;
  }

  async _resolveTargetWs(targetId) {
    // Fall back to the HTTP endpoint list if the ws url wasn't advertised.
    try {
      const res = await fetch(`http://127.0.0.1:${this.options.port}/json/list`);
      const list = await res.json();
      const t = list.find((x) => x.id === targetId);
      return t?.webSocketDebuggerUrl || null;
    } catch {
      return null;
    }
  }

  // Resolve a tab by id, or the most recently used page, or create one.
  //
  // "Most recently used" is tracked explicitly: Map iteration order is insertion
  // order, which made /tabs/default nondeterministic (it depended on the order
  // Chrome happened to report pre-existing targets at connect time).
  async ensureTab(targetId) {
    if (!this.browser) await this.connect();
    if (targetId) {
      const t = this.tabs.get(targetId);
      if (t) return this.touch(t);
      const found = [...this.tabs.values()].find((x) => x.targetId === targetId);
      if (found) return this.touch(found);
      throw new Error(`unknown tab ${targetId}`);
    }
    const open = [...this.tabs.values()];
    if (open.length) {
      const mru = this._mru && this.tabs.get(this._mru);
      return mru || open[open.length - 1];
    }
    return this.newTab();
  }

  touch(tab) {
    this._mru = tab.targetId;
    return tab;
  }

  // Open a tab and navigate it.
  //
  // The target is created blank and navigated *after* attaching/enabling the
  // Page and Network domains. Creating it with the final URL races the attach:
  // the page can finish loading (and fire navigation/request/response events)
  // before the domains are enabled, and those events are then lost — which made
  // a freshly opened tab occasionally appear to have no events at all.
  async newTab(url = 'about:blank') {
    if (!this.browser) await this.connect();
    const { targetId } = await this.browser.send('Target.createTarget', { url: 'about:blank' });
    const ws = await this._resolveTargetWs(targetId);
    if (!ws) throw new Error(`created target ${targetId} but could not resolve its debugger URL`);
    const tab = await this._attachTab({ targetId, webSocketDebuggerUrl: ws });
    if (url && url !== 'about:blank') {
      await tab.cdp.send('Page.navigate', { url }).catch(() => {});
    }
    return this.touch(tab);
  }

  async closeTab(targetId) {
    const tab = this.tabs.get(targetId);
    if (tab) {
      await tab.close().catch(() => {});
      this.tabs.delete(targetId);
    }
    if (this.browser) await this.browser.closePage(targetId).catch(() => {});
  }

  listTabs() {
    return [...this.tabs.values()].map((t) => ({
      targetId: t.targetId,
      attached: t.attached,
      pendingRequests: t.requests.size,
    }));
  }

  // True when we launched the browser ourselves (vs. attaching to a running one).
  get launched() {
    return !!(this._launchedChild && !this._launchedChild.killed);
  }

  async close() {
    for (const t of this.tabs.values()) await t.close().catch(() => {});
    this.tabs.clear();
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    // Only stop a browser we started; never kill one we attached to.
    if (this._launchedChild && !this._launchedChild.killed) {
      this._launchedChild.kill('SIGTERM');
      clearPidFile(this.options.userDataDir || DEFAULT_PROFILE);
    }
  }
}

export { resolveBinary, fetchBrowserEndpoint };
