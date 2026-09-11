/**
 * The in-page agent for lucarne's `supercode/browser-provider-v1` adapter.
 *
 * It is injected into the attached page over CDP (`Page.addScriptToEvaluateOnNewDocument`
 * plus one immediate `Runtime.evaluate`, so it is present on the current document and on
 * every document after a navigation). It owns everything that must be decided IN the page:
 * locator resolution, the page-local `ref` registry, the accessibility snapshot, element
 * inspection and geometry, and the revision counter behind `expectedRevision`.
 *
 * It owns nothing that CDP does better. Every pointer and keyboard act is delegated back
 * to the node process through the `__lucarneHost` CDP binding, which dispatches it with
 * `Input.*` — real, trusted browser input rather than synthesized DOM events. That is the
 * whole reason lucarne is a second provider: it drives a browser it is ATTACHED to.
 *
 * `browser.script` runs author-written Playwright with `page` bound to the same shim object
 * every other operation uses, so a script's clicks take the identical trusted-input path.
 */
export const PAGE_AGENT_SOURCE = String.raw`
(function () {
  if (window.__lucarneBrowser) return;

  var HOST = '__lucarneHost';
  var pending = new Map();
  var seq = 0;

  /** Ask the node side to perform a CDP act. Resolved by _settle() from the host. */
  function request(kind, payload) {
    var host = window[HOST];
    if (typeof host !== 'function') {
      return Promise.reject(new Error('lucarne: the CDP input binding is not installed'));
    }
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      try { host(JSON.stringify({ id: id, kind: kind, payload: payload })); }
      catch (e) { pending.delete(id); reject(e); }
    });
  }

  var revision = 0;
  try {
    new MutationObserver(function () { revision += 1; })
      .observe(document, { attributes: true, childList: true, characterData: true, subtree: true });
  } catch (e) { /* a document that cannot be observed simply never bumps its revision */ }

  // ── refs: page-local, stable for as long as the document lives ──
  var refOf = new WeakMap();
  var byRef = new Map();
  var refSeq = 0;
  function refFor(el) {
    var existing = refOf.get(el);
    if (existing) return existing;
    var ref = 'e' + (++refSeq);
    refOf.set(el, ref);
    byRef.set(ref, el);
    return ref;
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.nodeType !== 1) return false;
    var style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  var IMPLICIT_ROLE = {
    a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
    h5: 'heading', h6: 'heading', img: 'img', nav: 'navigation', main: 'main', header: 'banner',
    footer: 'contentinfo', aside: 'complementary', form: 'form', table: 'table', ul: 'list',
    ol: 'list', li: 'listitem', select: 'combobox', textarea: 'textbox', summary: 'button',
    dialog: 'dialog', option: 'option', progress: 'progressbar', article: 'article', section: 'region'
  };
  var INPUT_ROLE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox',
    radio: 'radio', range: 'slider', search: 'searchbox', email: 'textbox', tel: 'textbox',
    text: 'textbox', url: 'textbox', password: 'textbox', number: 'spinbutton', file: 'button'
  };
  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    return IMPLICIT_ROLE[tag] || null;
  }

  function labelText(el) {
    var doc = el.ownerDocument;
    var id = el.getAttribute && el.getAttribute('id');
    if (id) {
      var forEl = doc.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (forEl) return (forEl.textContent || '').trim();
    }
    var wrap = el.closest ? el.closest('label') : null;
    return wrap ? (wrap.textContent || '').trim() : '';
  }

  function nameOf(el) {
    if (!el || el.nodeType !== 1) return '';
    var aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = by.split(/\s+/).map(function (id) {
        var target = el.ownerDocument.getElementById(id);
        return target ? (target.textContent || '').trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'img') return (el.getAttribute('alt') || '').trim();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      var lab = labelText(el);
      if (lab) return lab;
      var ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim();
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) return (el.value || '').trim();
      return (el.getAttribute('title') || '').trim();
    }
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 300);
    return (el.getAttribute('title') || '').trim();
  }

  function matches(actual, wanted, exact) {
    if (wanted === undefined || wanted === null) return true;
    var a = String(actual || '').replace(/\s+/g, ' ').trim();
    var b = String(wanted).replace(/\s+/g, ' ').trim();
    return exact ? a === b : a.toLowerCase().indexOf(b.toLowerCase()) !== -1;
  }

  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }
  function everyElement() {
    return Array.prototype.slice.call(document.querySelectorAll('*'));
  }
  function leafmost(list) {
    return list.filter(function (el) {
      return !list.some(function (other) { return other !== el && el.contains(other); });
    });
  }

  function attrQuery(attr, text, exact) {
    return everyElement().filter(function (el) {
      var value = el.getAttribute(attr);
      return value !== null && matches(value, text, exact);
    });
  }

  function resolve(locator) {
    if (!locator || typeof locator !== 'object') throw new Error('lucarne: a locator is required');
    switch (locator.by) {
      case 'css': return all(locator.value);
      case 'ref': {
        var el = byRef.get(locator.value);
        return el && el.isConnected ? [el] : [];
      }
      case 'testId': return all('[data-testid="' + String(locator.value).replace(/"/g, '\\"') + '"]');
      case 'role': return everyElement().filter(function (el) {
        return roleOf(el) === locator.role && matches(nameOf(el), locator.name, locator.exact) && visible(el);
      });
      case 'text': return leafmost(everyElement().filter(function (el) {
        return visible(el) && matches(el.innerText || el.textContent, locator.text, locator.exact);
      }));
      case 'label': return everyElement().filter(function (el) {
        var tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return false;
        return matches(labelText(el) || el.getAttribute('aria-label'), locator.text, locator.exact);
      });
      case 'placeholder': return attrQuery('placeholder', locator.text, locator.exact);
      case 'altText': return attrQuery('alt', locator.text, locator.exact);
      case 'title': return attrQuery('title', locator.text, locator.exact);
      default: throw new Error('lucarne: unsupported locator kind ' + String(locator.by));
    }
  }

  function refuse(code, message) {
    var e = new Error(message);
    e.__lucarneCode = code;
    return e;
  }

  function one(locator, index) {
    var list = resolve(locator);
    var el = list[index === undefined ? 0 : index];
    if (!el) throw refuse('NOT_FOUND', 'The locator matched no element.');
    return el;
  }

  function inspect(el) {
    var tag = el.tagName.toLowerCase();
    var out = {
      ref: refFor(el),
      tag: tag,
      role: roleOf(el) || undefined,
      name: nameOf(el) || undefined,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: visible(el)
    };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') out.value = String(el.value == null ? '' : el.value);
    if (typeof el.checked === 'boolean') out.checked = el.checked;
    return out;
  }

  function box(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* detached */ }
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  function centre(el) {
    var b = box(el);
    if (!b) throw refuse('NOT_FOUND', 'The element has no layout box to aim at.');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  // ── aria snapshot ──
  var SNAPSHOT_NODE_CAP = 1500;
  function ariaSnapshot(root) {
    var lines = [];
    var seen = 0;
    function walk(el, depth) {
      if (seen >= SNAPSHOT_NODE_CAP || depth > 24) return;
      for (var i = 0; i < el.children.length; i++) {
        var child = el.children[i];
        var tag = child.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
        var role = roleOf(child);
        var rendered = visible(child);
        if (role && rendered) {
          seen += 1;
          var name = nameOf(child);
          var extra = '';
          if (/^h[1-6]$/.test(tag)) extra += ' [level=' + tag.slice(1) + ']';
          if (typeof child.checked === 'boolean') extra += child.checked ? ' [checked]' : '';
          if (child.disabled) extra += ' [disabled]';
          lines.push(new Array(depth + 1).join('  ') + '- ' + role +
            (name ? ' "' + name.slice(0, 120).replace(/"/g, "'") + '"' : '') + extra + ' [ref=' + refFor(child) + ']');
          walk(child, depth + 1);
        } else if (rendered) {
          walk(child, depth);
        }
      }
    }
    walk(root, 0);
    return lines.join('\n');
  }

  function target() {
    return { url: document.location ? document.location.href : '', title: document.title, revision: revision };
  }

  // ── the Playwright-shaped page shim (shared by the operations and browser.script) ──
  function makeLocator(locator, index) {
    var pick = function () { return one(locator, index === undefined ? 0 : index); };
    var api = {
      async click() { var el = pick(); await request('click', centre(el)); },
      async dblclick() { var el = pick(); await request('click', Object.assign(centre(el), { clickCount: 2 })); },
      async hover() { var el = pick(); await request('hover', centre(el)); },
      async focus() { pick().focus(); },
      async fill(value) {
        var el = pick();
        await request('click', centre(el));
        el.focus();
        await request('selectAll', {});
        if (String(value) === '') { await request('key', { key: 'Delete' }); return; }
        await request('type', { text: String(value) });
      },
      async press(key) { var el = pick(); el.focus(); await request('key', { key: String(key) }); },
      async check() {
        var el = pick();
        if (el.checked === true) return;
        await request('click', centre(el));
      },
      async uncheck() {
        var el = pick();
        if (el.checked === false) return;
        await request('click', centre(el));
      },
      async selectOption(values) {
        var el = pick();
        var wanted = Array.isArray(values) ? values.map(String) : [String(values)];
        if (el.tagName.toLowerCase() !== 'select') throw refuse('UNSUPPORTED', 'selectOption needs a <select> element.');
        var chosen = [];
        for (var i = 0; i < el.options.length; i++) {
          var option = el.options[i];
          var hit = wanted.indexOf(option.value) !== -1 || wanted.indexOf((option.label || option.text || '').trim()) !== -1;
          option.selected = hit;
          if (hit) chosen.push(option.value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return chosen;
      },
      async textContent() { var el = pick(); return el.textContent; },
      async inputValue() { var el = pick(); return String(el.value == null ? '' : el.value); },
      async getAttribute(name) { return pick().getAttribute(name); },
      async isVisible() { try { return visible(pick()); } catch (e) { return false; } },
      async count() { return resolve(locator).length; },
      async boundingBox() { return box(pick()); },
      async inspect() { return inspect(pick()); },
      async inspectAll(limit) { return resolve(locator).slice(0, limit || 50).map(inspect); },
      async ariaSnapshot() { return ariaSnapshot(pick()); },
      first() { return makeLocator(locator, 0); },
      nth(n) { return makeLocator(locator, n); },
      async waitFor(options) {
        var opts = options || {};
        var want = opts.state === 'attached' ? 'attached' : 'visible';
        var deadline = Date.now() + (typeof opts.timeout === 'number' ? opts.timeout : 5000);
        for (;;) {
          var list = resolve(locator);
          var el = list[index === undefined ? 0 : index];
          if (el && (want === 'attached' ? el.isConnected : visible(el))) return;
          if (Date.now() >= deadline) throw refuse('TIMED_OUT', 'The locator never became ' + want + '.');
          await new Promise(function (r) { setTimeout(r, 60); });
        }
      }
    };
    return api;
  }

  var page = {
    locator: function (selector) { return makeLocator({ by: 'css', value: selector }); },
    getByRole: function (role, options) { return makeLocator({ by: 'role', role: role, name: options && options.name, exact: options && options.exact }); },
    getByText: function (text, options) { return makeLocator({ by: 'text', text: text, exact: options && options.exact }); },
    getByTestId: function (value) { return makeLocator({ by: 'testId', value: value }); },
    getByRef: function (value) { return makeLocator({ by: 'ref', value: value }); },
    getByLabel: function (text, options) { return makeLocator({ by: 'label', text: text, exact: options && options.exact }); },
    getByPlaceholder: function (text, options) { return makeLocator({ by: 'placeholder', text: text, exact: options && options.exact }); },
    getByAltText: function (text, options) { return makeLocator({ by: 'altText', text: text, exact: options && options.exact }); },
    getByTitle: function (text, options) { return makeLocator({ by: 'title', text: text, exact: options && options.exact }); },
    ariaSnapshot: async function () { return ariaSnapshot(document.body || document.documentElement); },
    title: async function () { return document.title; },
    url: function () { return document.location ? document.location.href : ''; },
    goBack: async function () { return request('history', { delta: -1 }); },
    goForward: async function () { return request('history', { delta: 1 }); },
    reload: async function () { return request('reload', {}); },
    keyboard: {
      press: function (key) { return request('key', { key: String(key) }); },
      down: function (key) { return request('key', { key: String(key), only: 'down' }); },
      up: function (key) { return request('key', { key: String(key), only: 'up' }); },
      type: function (text) { return request('type', { text: String(text) }); }
    },
    mouse: {
      move: function (x, y) { return request('mouse', { action: 'move', x: x, y: y }); },
      down: function () { return request('mouse', { action: 'down' }); },
      up: function () { return request('mouse', { action: 'up' }); },
      click: function (x, y) { return request('click', { x: x, y: y }); },
      wheel: function (dx, dy) { return request('wheel', { deltaX: dx, deltaY: dy }); },
      drag: function (from, to, steps) { return request('drag', { from: from, to: to, steps: steps }); }
    }
  };

  function serializable(value) {
    try { return JSON.parse(JSON.stringify(value === undefined ? null : value)); }
    catch (e) { return String(value); }
  }

  // One act per mutating operation, so execute() can inspect the target before performing it.
  var ACTS = {
    'browser.click': function (locator) { return locator.click(); },
    'browser.hover': function (locator) { return locator.hover(); },
    'browser.focus': function (locator) { return locator.focus(); },
    'browser.fill': function (locator, input) { return locator.fill(input.value); },
    'browser.check': function (locator) { return locator.check(); },
    'browser.uncheck': function (locator) { return locator.uncheck(); },
    'browser.press': function (locator, input) { return locator.press(input.key); }
  };

  function ok(operation, value) { return { ok: true, operation: operation, target: target(), value: value }; }
  function bad(operation, code, message) { return { ok: false, operation: operation, error: { code: code, message: message }, target: target() }; }

  async function execute(call) {
    var operation = call.operation;
    var input = call.input || {};
    try {
      if (typeof input.expectedRevision === 'number' && input.expectedRevision !== revision) {
        return bad(operation, 'STALE_PAGE', 'The page changed (expected revision ' + input.expectedRevision + ', current revision ' + revision + ').');
      }
      var index = typeof input.index === 'number' ? input.index : 0;
      var locator = input.locator ? makeLocator(input.locator, index) : null;

      if (operation === 'browser.snapshot') {
        var text = input.locator ? await locator.ariaSnapshot() : await page.ariaSnapshot();
        var bounded = text.slice(0, 64000);
        return ok(operation, { text: bounded, truncated: bounded.length < text.length });
      }
      if (operation === 'browser.query') {
        var count = resolve(input.locator).length;
        return ok(operation, { count: count, matches: await locator.inspectAll(50), truncated: count > 50 });
      }
      if (operation === 'browser.wait') {
        await locator.waitFor({ state: input.state, timeout: input.timeout });
        return ok(operation, { ready: true });
      }
      if (operation === 'browser.box') {
        var b = await locator.boundingBox();
        if (!b) return bad(operation, 'NOT_FOUND', 'The locator matched no element with a layout box.');
        return ok(operation, b);
      }
      if (operation === 'browser.scroll') {
        var amount = typeof input.amount === 'number' ? input.amount : Math.max(240, Math.round(window.innerHeight * 0.8));
        var dx = input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0;
        var dy = input.direction === 'up' ? -amount : input.direction === 'down' ? amount : 0;
        await page.mouse.wheel(dx, dy);
        return ok(operation, { direction: input.direction, amount: amount });
      }
      if (operation === 'browser.mouse') {
        if (input.action === 'click') await page.mouse.click(input.x, input.y);
        else if (input.action === 'move') await page.mouse.move(input.x, input.y);
        else if (input.action === 'down') await page.mouse.down();
        else await page.mouse.up();
        return ok(operation, { action: input.action, x: input.x, y: input.y });
      }
      if (operation === 'browser.wheel') {
        await page.mouse.wheel(input.deltaX || 0, input.deltaY || 0);
        return ok(operation, { deltaX: input.deltaX || 0, deltaY: input.deltaY || 0 });
      }
      if (operation === 'browser.drag') {
        var point = async function (endpoint) {
          if (endpoint.locator === undefined) return { x: endpoint.x, y: endpoint.y };
          return centre(one(endpoint.locator, 0));
        };
        var from = await point(input.from);
        var to = await point(input.to);
        await page.mouse.drag(from, to, input.steps);
        return ok(operation, { from: from, to: to });
      }
      if (operation === 'browser.script') {
        var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        var run;
        try { run = new AsyncFunction('page', 'args', String(input.source)); }
        catch (e) { return bad(operation, 'FAILED', 'The script did not parse: ' + e.message); }
        var limit = typeof input.timeout === 'number' ? input.timeout : 30000;
        var timer;
        try {
          var value = await Promise.race([
            run(page, input.args || {}),
            new Promise(function (_r, reject) { timer = setTimeout(function () { reject(new Error('The script exceeded ' + limit + 'ms.')); }, limit); })
          ]);
          return ok(operation, { value: serializable(value) });
        } finally { clearTimeout(timer); }
      }
      if (operation === 'browser.select') return ok(operation, { values: await locator.selectOption(input.values) });
      if (operation === 'browser.press' && !locator) {
        await page.keyboard.press(input.key);
        return ok(operation, { key: input.key });
      }
      if (ACTS[operation]) {
        // The element is described BEFORE the act, never after. A click that navigates or that
        // removes its own button leaves nothing to re-resolve, and re-resolving would report
        // NOT_FOUND for an action that in fact succeeded. The pre-act inspection is the honest
        // answer to "what did you act on"; a target that vanished still reports ok.
        var before = null;
        try { before = inspect(one(input.locator, index)); } catch (e) { /* the act below reports NOT_FOUND itself */ }
        await ACTS[operation](locator, input);
        return ok(operation, before || { acted: true });
      }
      return bad(operation, 'UNSUPPORTED', 'lucarne does not implement ' + String(operation) + ' in the page.');
    } catch (error) {
      var code = error && error.__lucarneCode ? error.__lucarneCode : 'FAILED';
      return bad(operation, code, error && error.message ? error.message : String(error));
    }
  }

  window.__lucarneBrowser = {
    execute: execute,
    target: target,
    page: page,
    revision: function () { return revision; },
    _settle: function (id, error, value) {
      var entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (error) entry.reject(new Error(error)); else entry.resolve(value);
    }
  };
})();
`;
