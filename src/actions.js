// Action vocabulary. Each action is a plain async function (tab, params) => result.
// Actions are designed for an agent loop:
//   - they accept either a `ref` (from a snapshot) or a CSS `selector`
//   - they resolve geometry via the DOM, then dispatch *real* CDP input events
//     so sites behave as they would for a human
//   - they return a tiny result object, never a page dump

import { REF_ATTR } from './observe.js';

const DEFAULT_TIMEOUT = 15000;
const POLL = 60;

function selectorFor({ ref, selector }) {
  if (ref) return `[${REF_ATTR}="${ref}"]`;
  if (selector) return selector;
  throw new Error('action requires either "ref" or "selector"');
}

const BOX_FN = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { empty: true };
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    left: r.left, top: r.top, width: r.width, height: r.height,
    tag: el.tagName, type: el.type || undefined,
    disabled: !!el.disabled,
    needsFocus: !el.isContentEditable && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'),
  };
}`;

export class ActionError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: Record<string, unknown> }} [options]
   */
  constructor(message, { code = 'action_failed', details } = {}) {
    super(message);
    /** @type {string} */
    this.code = code;
    /** @type {Record<string, unknown> | undefined} */
    this.details = details;
  }
}

async function waitForBox(tab, sel, timeoutMs = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await tab.callFunction(BOX_FN, sel, { timeoutMs: 5000 });
    if (last && !last.empty) return last;
    await sleep(POLL);
  }
  if (last && last.empty)
    throw new ActionError(`element ${sel} is present but not visible`, { code: 'not_visible' });
  throw new ActionError(`element ${sel} not found within ${timeoutMs}ms`, { code: 'not_found' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dispatch a realistic click: move, press, release. Some UIs ignore
// down+up with no intervening move.
async function realClick(tab, x, y, { button = 'left', clickCount = 1 } = {}) {
  const base = { x, y, button, clickCount };
  await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function realType(tab, text, { delay = 0 } = {}) {
  // insertText is dramatically faster than per-key events and is what tools
  // like CDP clients use for bulk input. Use per-key when delay is requested
  // (e.g. sites with debounced handlers that need keystroke timing).
  if (!delay) {
    await tab.cdp.send('Input.insertText', { text });
    return;
  }
  for (const ch of text) {
    await tab.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await tab.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
    await sleep(delay);
  }
}

const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
};

async function pressKey(tab, name) {
  const spec = KEY_CODES[name] || {
    key: name,
    code: name,
    windowsVirtualKeyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0,
  };
  await tab.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
  if (spec.text) await tab.cdp.send('Input.dispatchKeyEvent', { type: 'char', ...spec });
  await tab.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
}

// Focus helper: click then optionally clear existing value.
async function focusElement(tab, sel, { clear = false } = {}) {
  const box = await waitForBox(tab, sel);
  if (box.needsFocus) {
    await realClick(tab, box.x, box.y);
    if (clear) {
      await tab.callFunction(
        `(sel) => { const el = document.querySelector(sel); if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } }`,
        sel,
      );
    }
  } else {
    await tab.callFunction(
      `(sel) => { const el = document.querySelector(sel); if (el && el.focus) el.focus(); }`,
      sel,
    );
  }
  return box;
}

// ---- Action implementations ----------------------------------------------

export const actions = {
  async navigate(tab, { url, waitUntil = 'load', timeoutMs = 30000 }) {
    // Honor waitUntil: 'load' waits for the load event, 'domcontentloaded' waits
    // for DOMContentLoaded, anything else (incl. 'none') returns once navigation
    // is committed. The previous version accepted the param and ignored it.
    const wanted =
      waitUntil === 'domcontentloaded'
        ? ['domcontentloaded']
        : waitUntil === 'none'
          ? []
          : ['load', 'domcontentloaded'];
    const done = wanted.length ? waitForEvent(tab, wanted, timeoutMs).catch(() => null) : null;
    const frameTree = await tab.cdp.send('Page.navigate', { url });
    if (frameTree.errorText) throw new Error(`navigation failed: ${frameTree.errorText}`);
    if (done) await done;
    return { url: await tab.evaluate('location.href'), errorText: frameTree.errorText || undefined };
  },

  async click(
    tab,
    { ref, selector, button = 'left', clickCount = 1, waitForNav = false, timeoutMs = DEFAULT_TIMEOUT },
  ) {
    const sel = selectorFor({ ref, selector });
    let nav = null;
    if (waitForNav) nav = waitForEvent(tab, ['navigation', 'load'], timeoutMs).catch(() => null);
    const box = await waitForBox(tab, sel, timeoutMs);
    if (box.disabled) throw new Error(`element ${sel} is disabled`);
    await realClick(tab, box.x, box.y, { button, clickCount });
    if (nav) await nav;
    return { clicked: true, at: { x: Math.round(box.x), y: Math.round(box.y) } };
  },

  async fill(tab, { ref, selector, value = '', clear = true, pressEnter = false, delay = 0 }) {
    const sel = selectorFor({ ref, selector });
    await focusElement(tab, sel, { clear: false });
    if (clear) {
      // Select-all then type replaces in one shot, works for inputs and textareas.
      await tab.callFunction(
        `(sel) => { const el = document.querySelector(sel); if (el && 'select' in el) el.select(); else if (el && el.isContentEditable) document.execCommand('selectAll'); }`,
        sel,
      );
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
      });
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
      });
    }
    await realType(tab, String(value), { delay });
    if (pressEnter) await pressKey(tab, 'Enter');
    const actual = await tab.callFunction(
      `(sel) => { const el = document.querySelector(sel); return el ? (el.value ?? el.textContent) : null; }`,
      sel,
    );
    return { value: actual };
  },

  async type(tab, { ref, selector, text = '', delay = 0 }) {
    const sel = selectorFor({ ref, selector });
    await focusElement(tab, sel);
    await realType(tab, String(text), { delay });
    return { typed: true };
  },

  async press(tab, { key }) {
    await pressKey(tab, key);
    return { key };
  },

  async select(tab, { ref, selector, value, label, index }) {
    const sel = selectorFor({ ref, selector });
    const result = await tab.callFunction(
      `(a) => {
        const el = document.querySelector(a.sel);
        if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'not a select' };
        let opt;
        if (a.value != null) opt = Array.from(el.options).find(o => o.value === a.value);
        else if (a.label != null) opt = Array.from(el.options).find(o => o.textContent.trim() === a.label);
        else if (a.index != null) opt = el.options[a.index];
        if (!opt) return { ok: false, reason: 'option not found', options: Array.from(el.options).map(o => o.value) };
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      }`,
      { sel, value, label, index },
    );
    if (!result.ok) throw new Error(`select failed: ${result.reason}`);
    return result;
  },

  async hover(tab, { ref, selector }) {
    const sel = selectorFor({ ref, selector });
    const box = await waitForBox(tab, sel);
    await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    return { hovered: true };
  },

  async scroll(tab, { dx = 0, dy = 0, ref, selector }) {
    if (ref || selector) {
      const sel = selectorFor({ ref, selector });
      await tab.callFunction(
        `(sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' })`,
        sel,
      );
    } else {
      await tab.evaluate(`window.scrollBy(${Number(dx) || 0}, ${Number(dy) || 0}); true`);
    }
    const pos = await tab.evaluate(
      '({ x: Math.round(scrollX), y: Math.round(scrollY), maxY: Math.round(document.documentElement.scrollHeight - innerHeight) })',
    );
    return pos;
  },

  async check(tab, { ref, selector, checked = true }) {
    const sel = selectorFor({ ref, selector });
    const state = await tab.callFunction(
      `(sel) => { const el = document.querySelector(sel); return el ? !!el.checked : null; }`,
      sel,
    );
    if (state === null) throw new ActionError('element is not a checkbox/radio', { code: 'wrong_type' });
    const target = !!checked;
    if (state !== target) {
      const box = await waitForBox(tab, sel);
      await realClick(tab, box.x, box.y);
    }
    // Verify rather than assume: report both the desired and observed state.
    const after = await tab.callFunction(
      `(sel) => { const el = document.querySelector(sel); return el ? !!el.checked : null; }`,
      sel,
    );
    return { checked: after, changed: state !== target, requested: target };
  },

  async setFiles(tab, { ref, selector, files }) {
    const sel = selectorFor({ ref, selector });
    const list = Array.isArray(files) ? files : [files];
    if (!list.length)
      throw new ActionError('setFiles requires a non-empty "files" array', { code: 'bad_request' });
    const { root } = await tab.cdp.send('DOM.getDocument', { depth: -1, pierce: false });
    const { nodeId } = await tab.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!nodeId)
      throw new ActionError(`no element matches ${sel} for setFiles`, {
        code: 'no_file_input',
        details: {
          selector: sel,
          hint: 'setFiles needs an <input type="file">; if the target is a dropzone, use dropFiles instead',
        },
      });
    // Fail loudly when the selector resolves to something that is not a file
    // input, rather than letting CDP throw an opaque error.
    const { node } = await tab.cdp.send('DOM.describeNode', { nodeId });
    const attrs = {};
    for (let i = 0; i < (node?.attributes?.length || 0); i += 2)
      attrs[node.attributes[i]] = node.attributes[i + 1];
    if ((node?.nodeName || '').toUpperCase() !== 'INPUT' || (attrs.type || 'text').toLowerCase() !== 'file')
      throw new ActionError(
        `${sel} is not an <input type="file"> (got <${(node?.nodeName || '?').toLowerCase()}>)`,
        {
          code: 'wrong_type',
          details: {
            selector: sel,
            hint: 'for drag-and-drop targets, use dropFiles instead of setFiles',
          },
        },
      );
    await tab.cdp.send('DOM.setFileInputFiles', { nodeId, files: list });
    return { files: list };
  },

  // Attach files to a dropzone by dispatching a real drag sequence
  // (dragEnter -> dragOver -> drop) with the files on the drag data. Many apps
  // (Expensify, Google Drive, ...) accept file drops but expose no usable
  // <input type=file>, so this is the reliable path for them.
  async dropFiles(tab, { ref, selector, files, stepDelayMs = 60 }) {
    const sel = selectorFor({ ref, selector });
    const list = Array.isArray(files) ? files : [files];
    if (!list.length)
      throw new ActionError('dropFiles requires a non-empty "files" array', { code: 'bad_request' });
    const box = await waitForBox(tab, sel);
    const data = { items: [], files: list, dragOperationsMask: 1 };
    try {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await tab.cdp.send('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
        await sleep(stepDelayMs);
      }
    } catch (e) {
      throw new ActionError(`dropFiles failed for ${sel}: ${e.message}`, {
        code: 'drop_failed',
        details: {
          selector: sel,
          hint: 'Input.dispatchDragEvent needs a modern Chrome; check the target is a dropzone',
        },
      });
    }
    return { files: list, target: sel };
  },

  /**
   * @param {any} tab
   * @param {{ format?: string, quality?: number, fullPage?: boolean, ref?: string, selector?: string, clip?: any }} [options]
   */
  async screenshot(tab, { format = 'png', quality, fullPage = false, ref, selector, clip } = {}) {
    if (ref || selector) {
      const sel = selectorFor({ ref, selector });
      const box = await tab.callFunction(BOX_FN, sel);
      if (!box) throw new Error(`element ${sel} not found`);
      clip = { x: box.left, y: box.top, width: box.width, height: box.height, scale: 1 };
    } else if (fullPage) {
      const metrics = await tab.cdp.send('Page.getLayoutMetrics');
      const { width, height } = metrics.cssContentSize;
      clip = { x: 0, y: 0, width, height, scale: 1 };
    }
    const params = { format, captureBeyondViewport: !!fullPage };
    if (quality != null && format === 'jpeg') params.quality = quality;
    if (clip) params.clip = clip;
    const { data } = await tab.cdp.send('Page.captureScreenshot', params, { timeoutMs: 30000 });
    return { format, data, bytes: data.length };
  },

  async wait(tab, { ms = 500, forSelector, forText, timeoutMs = DEFAULT_TIMEOUT }) {
    if (forSelector) {
      await waitForBox(tab, forSelector, timeoutMs);
      return { found: true };
    }
    if (forText) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = await tab.callFunction(
          `(t) => document.body && document.body.innerText.includes(t)`,
          forText,
          { timeoutMs: 5000 },
        );
        if (found) return { found: true };
        await sleep(120);
      }
      throw new Error(`text ${JSON.stringify(forText)} not found within ${timeoutMs}ms`);
    }
    await sleep(Math.min(ms, 60000));
    return { waited: ms };
  },

  async evaluate(tab, { expression, awaitPromise = true, returnByValue = true }) {
    const value = await tab.evaluate(expression, { awaitPromise, returnByValue });
    return { value };
  },

  async history(tab, { direction = 'back' }) {
    const entry = direction === 'back' ? await prevEntry(tab) : await nextEntry(tab);
    await tab.cdp.send('Page.navigateToHistoryEntry', entry);
    return { url: await tab.evaluate('location.href') };
  },

  async acceptDialog(tab, { accept = true, promptText }) {
    await tab.cdp.send('Page.handleJavaScriptDialog', { accept, promptText });
    return { handled: true };
  },
};

// ---- Helpers --------------------------------------------------------------

function waitForEvent(tab, types, timeoutMs) {
  return new Promise((resolve, reject) => {
    const seen = new Set();
    const unsub = tab.bus.subscribe((evt) => {
      if (types.includes(evt.type)) {
        seen.add(evt.type);
        cleanup();
        resolve(evt);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${types.join('/')}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      unsub();
    }
  });
}

async function prevEntry(tab) {
  const history = await tab.cdp.send('Page.getNavigationHistory');
  const idx = history.currentIndex - 1;
  if (idx < 0) throw new Error('no previous history entry');
  return { entryId: history.entries[idx].id };
}
async function nextEntry(tab) {
  const history = await tab.cdp.send('Page.getNavigationHistory');
  const idx = history.currentIndex + 1;
  if (idx >= history.entries.length) throw new Error('no next history entry');
  return { entryId: history.entries[idx].id };
}

export function listActions() {
  return Object.keys(actions).sort();
}
