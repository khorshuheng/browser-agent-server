// Injected into every page/frame. Builds a compact, token-cheap snapshot and
// exposes stable element handles so an agent can act by ref instead of by
// brittle CSS selectors. Kept dependency-free and side-effect free.

export const REF_ATTR = 'data-pi-ref';

// Runs in the browser. Receives { maxNodes, includeText, scope } and returns a snapshot.
// IMPORTANT: this function is stringified and evaluated in the page, so it must be
// fully self-contained — no references to module-scope bindings.
export function snapshotFn(opts) {
  const { maxNodes = 250, includeText = true, scope = null } = opts || {};
  const REF_ATTR = 'data-pi-ref';

  const root = scope ? document.querySelector(scope) : document;

  const isVisible = (el) => {
    if (el.hasAttribute('hidden')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'form') return 'form';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6')
      return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'table') return 'table';
    if (tag === 'iframe') return 'iframe';
    return 'generic';
  };

  const INTERACTIVE = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'slider',
    'combobox',
    'menuitem',
    'option',
    'tab',
    'switch',
    'searchbox',
  ]);

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((id) => {
        const t = document.getElementById(id);
        return t ? t.textContent : '';
      });
      const joined = parts.join(' ').trim();
      if (joined) return joined;
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels)
        .map((l) => l.textContent)
        .join(' ')
        .trim();
      if (t) return t;
    }
    const ph = el.getAttribute('placeholder');
    if (ph) return ph.trim();
    const title = el.getAttribute('title');
    if (title) return title.trim();
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button') && el.value) return el.value;
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt) return txt.slice(0, 120);
    return '';
  };

  // Assign/refresh stable-ish refs. Refs are derived from DOM order so they are
  // deterministic across snapshots of an unchanged page (cheap diffing).
  let refCounter = 0;
  const nodes = [];
  const tag = (el, role) => {
    let ref = el.getAttribute(REF_ATTR);
    refCounter += 1;
    if (!ref) {
      ref = 'e' + refCounter;
      el.setAttribute(REF_ATTR, ref);
    }
    nodes.push({ ref, el, role });
    return ref;
  };

  // Subtrees that never contribute to what an agent should see. Skipping them
  // (rather than recursing and filtering later) keeps snapshots cheap on pages
  // with large inline scripts, styles or SVG sprites.
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH']);
  const out = [];
  const counts = {};
  let truncated = false;

  const visit = (el) => {
    if (truncated || SKIP_TAGS.has(el.tagName)) return;
    const role = roleOf(el);
    const visible = isVisible(el);
    const interactive = INTERACTIVE.has(role) || el.hasAttribute('contenteditable') || el.onclick != null;
    const interesting = interactive || role !== 'generic';

    if (interesting && visible) {
      if (out.length >= maxNodes) {
        truncated = true;
        return;
      }
      const entry = { ref: null, role };
      entry.ref = tag(el, role);
      const name = accessibleName(el);
      if (name) entry.name = name;
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
        const v = 'value' in el ? el.value : '';
        if (v) entry.value = String(v).slice(0, 120);
      }
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        entry.checked = !!el.checked || el.getAttribute('aria-checked') === 'true';
      }
      if (role === 'combobox' && el.tagName === 'SELECT') {
        entry.value = el.value;
        entry.options = Array.from(el.options)
          .slice(0, 30)
          .map((o) => o.value);
      }
      if (role === 'link') {
        const href = el.getAttribute('href');
        if (href) entry.href = href.slice(0, 200);
      }
      if (role === 'heading') {
        entry.level = Number(el.tagName.slice(1)) || undefined;
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') entry.disabled = true;
      if (!interactive && includeText && name) entry.name = name;
      if (includeText && !name) {
        const direct = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (direct) entry.text = direct.slice(0, 160);
      }
      counts[role] = (counts[role] || 0) + 1;
      out.push(entry);
    }
    for (const child of el.children) visit(child);
  };

  for (const child of root.children) visit(child);

  const summary = {
    url: location.href,
    title: document.title,
    scroll: {
      y: Math.round(window.scrollY),
      maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)),
    },
    counts,
    nodes: out,
    truncated: truncated || undefined,
  };
  return summary;
}

// Fast, low-token change detector: hashes the digest of the interesting DOM.
export function digestFn() {
  const parts = [];
  const walk = (el) => {
    parts.push(el.tagName, el.getAttribute('data-pi-ref') || '');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      parts.push(String(el.value || ''));
    }
    for (const c of el.children) walk(c);
  };
  walk(document.body);
  const s = parts.join('\u0001');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return {
    hash: (h >>> 0).toString(36),
    url: location.href,
    title: document.title,
    readyState: document.readyState,
  };
}

// In-page console + error capture.
//
// Some stealth Chromium forks (e.g. CloakBrowser) deliberately suppress
// Runtime.consoleAPICalled / Runtime.exceptionThrown for pages created via
// Target.createTarget — a CDP-created page is an automation tell. Where the CDP
// console bridge is void, we capture the same information from inside the page
// instead: wrap console methods and listen for error / unhandledrejection, then
// buffer into window.__pi_events for the server to drain over Runtime.evaluate
// (which always works). Injected via Page.addScriptToEvaluateOnNewDocument.
export const CONSOLE_HOOK_SOURCE = `(() => {
  if (window.__pi_hooked) return;
  window.__pi_hooked = true;
  const buf = (window.__pi_events = []);
  const fmt = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } };
  const push = (type, text, extra) => {
    buf.push({ type, text, ...(extra || {}) });
    if (buf.length > 1000) buf.splice(0, buf.length - 1000);
  };
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const orig = console[level];
    console[level] = function (...args) {
      push(level === 'warn' ? 'warning' : level === 'error' ? 'error' : 'log', args.map(fmt).join(' '));
      return orig.apply(this, args);
    };
  }
  window.addEventListener('error', (e) => push('pageerror', e.message || String(e.error), { url: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => push('pageerror', 'Unhandled rejection: ' + fmt(e.reason)));
})();`;

// Atomically read and clear the buffer. Returns [] if the hook never installed.
//
// Must splice in place rather than rebind window.__pi_events: the hook closure
// captures the original array, so assigning a fresh array would orphan it and
// silently drop every subsequent log.
export const CONSOLE_DRAIN_SOURCE = `(() => {
  const buf = window.__pi_events;
  if (!Array.isArray(buf)) return [];
  return buf.splice(0, buf.length);
})();`;
