/* =========================================================
   ZAH SITE MCP, the renderer

   Turns "the file Zah shipped" plus "the client's overlay" into what a
   visitor sees. The unit of editing is the page BODY. The parts of the body
   that belong to products, not to the page (the Zah Editor toolbar, ZAH
   Pay's note, every <script>), are "chrome": taken from the file, never
   from a snapshot, so a client can never break or lose them.

   Passes, always in this order:

     1. body      snapshot (client restructured the page) or the file's body
     2. chrome    the file's scripts and product nodes re-attached
     3. keys      every editable and structural element gets a data-zs key.
                  (the client's own scripts and forms carry data-zs-keep and
                  are content, not chrome)
                  Elements that already carry one keep it. Others get a
                  positional key ("h2:3", "section:1") when the page is
                  still the file, or a random one ("n:k3j9x2") once the page
                  has been materialised, so later insertions never shift them
     4. edits     small keyed edits (text, attrs, hidden) on top
     5. css       the client's stylesheet, injected before </head>

   Client-created pages render inside the TEMPLATE page's file (its head,
   CSS and chrome), so they look like the site without the AI copying CSS.
   ========================================================= */
const cheerio = require('cheerio');
const crypto = require('crypto');

const DEFAULT_EDITABLE = ['h1', 'h2', 'h3', 'h4', 'h5', 'p', 'li', 'blockquote', 'figcaption', 'a', 'button', 'img', 'video', 'span.badge', 'label'];
const STRUCTURAL = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'figure', 'ul', 'ol', 'div', 'table'];
const DEFAULT_CHROME = ['script:not([data-zs-keep])', 'noscript:not([data-zs-keep])', '#edToggle', '#edBar', '#edBubble', '#edEl', '.edbub', '.zp-modal', '[data-zs-chrome]'];
const ATTR_WHITELIST = ['href', 'src', 'alt', 'title', 'target', 'poster', 'width', 'height', 'loading'];

const load = (html) => cheerio.load(html, { decodeEntities: false });
const randomKey = () => 'n:' + crypto.randomBytes(4).toString('hex').slice(0, 6);
const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------------- sanitiser ----------------
   The client owns the site and may collect data. Where a form may send it:

     1. ZAH CRM, the default. The host declares ctx.crm = { leadPath,
        enabled }. When the CRM seam is switched on, a form whose action is
        that path (e.g. /api/lead) is the ZAH CRM form: leads land in the
        client's CRM. When it is NOT switched on, such a form is kept
        visible but made inert, and the tool result tells the AI to send
        the client to Zah to connect it.
     2. The client's own outside service (Formspree, Google Forms, Airtable,
        their own backend): any https action that is not this site. Their
        business.
     3. Anything else (a relative path, this site's own host) is inert:
        this server has no database for them.

   Embed scripts (Calendly, Mailchimp, a chat widget) are theirs to add.
   Refused everywhere: javascript: URLs, event-handler attributes, srcdoc,
   object/embed/applet/base/meta. Scripts and forms the client adds are
   marked data-zs-keep so the renderer knows they are content, not chrome. */
function formStatus(action, ctx = {}) {
  const a = String(action || '').trim();
  const crm = ctx.crm || null;
  if (crm && crm.leadPath && (a === crm.leadPath || a === (ctx.origin || '') + crm.leadPath)) {
    return crm.enabled && crm.enabled() ? 'zah-crm' : 'zah-crm-off';
  }
  try {
    const u = new URL(a);
    if (u.protocol === 'https:' && (!ctx.host || u.hostname !== ctx.host)) return 'external';
  } catch (e) { /* relative or invalid */ }
  return 'inert';
}

function formNote(status, ctx = {}) {
  const crm = ctx.crm || {};
  const contact = crm.contactUrl || 'https://zahbrandsolutions.com/contact';
  const notice = crm.notice ? ` ${crm.notice}` : '';
  switch (status) {
    case 'zah-crm': return 'This form sends to ZAH CRM: every submission becomes a lead in the client\'s CRM.' + notice;
    case 'zah-crm-off': return `ZAH CRM is not connected on this site yet, so this form is inert until it is. That is the default place for forms on a ZAH site (leads, follow-up, invoicing in one place). Ask the client: would you like this form connected to ZAH CRM? If yes, send them to Zah (${contact}) to switch it on; nothing needs to be built on the site. If they would rather use their own outside service, point the form's action at that service's https address instead.${notice}`;
    case 'external': return 'This form posts to the client\'s own outside service. Nothing is stored on this site. If they would prefer it in ZAH CRM, the default for ZAH sites, ask Zah to connect it.' + notice;
    default: return `This form has nowhere to send to, so it is inert. Forms on a ZAH site go to ZAH CRM by default (ask the client, then Zah connects it: ${contact}), or to the client's own outside service via an https action.`;
  }
}

/** Inspect the forms in a fragment: what each would do and what to tell the client. */
function analyzeForms(html, ctx = {}) {
  const $ = load(`<div id="__zs_root">${html}</div>`);
  const out = [];
  $('#__zs_root form').each((_, el) => {
    const action = String($(el).attr('action') || '');
    const status = formStatus(action, ctx);
    out.push({ action: action || null, status, note: formNote(status, ctx) });
  });
  return out;
}

function sanitize(html, ctx = {}) {
  const $ = load(`<div id="__zs_root">${html}</div>`);
  const root = $('#__zs_root');
  root.find('object, embed, applet, base, meta, link[rel="import"]').remove();
  root.find('form').each((_, el) => {
    const status = formStatus($(el).attr('action'), ctx);
    if (status === 'zah-crm') {
      $(el).attr('method', 'post');
      $(el).attr('data-zs-form', 'zah-crm');
    } else if (status === 'external') {
      $(el).attr('data-zs-form', 'external');
    } else {
      // Keep the visible form so the page still looks right, but make it inert
      // and say why, rather than silently sending visitors' data nowhere.
      $(el).removeAttr('action').attr('data-zs-inert', status === 'zah-crm-off'
        ? 'ZAH CRM is not connected on this site yet; ask Zah to connect it'
        : 'form needs a destination: ZAH CRM (ask Zah) or an https address of your own service');
      $(el).attr('onsubmit', 'return false');
      $(el).attr('data-zs-form', status);
    }
    $(el).attr('data-zs-keep', '');
  });
  root.find('script, noscript').each((_, el) => { $(el).attr('data-zs-keep', ''); });
  root.find('iframe').each((_, el) => {
    const src = String($(el).attr('src') || '');
    let ok = false;
    try { ok = new URL(src).protocol === 'https:'; } catch (e) { ok = false; }
    if (!ok) $(el).remove();
    else { $(el).attr('loading', 'lazy'); $(el).removeAttr('srcdoc'); }
  });
  root.find('*').each((_, el) => {
    const attrs = el.attribs || {};
    for (const name of Object.keys(attrs)) {
      const v = String(attrs[name]);
      if (/^on/i.test(name) && !(name === 'onsubmit' && v === 'return false')) delete el.attribs[name];
      else if ((name === 'href' || name === 'src' || name === 'action' || name === 'formaction' || name === 'xlink:href') && /^\s*(javascript|data:text\/html|vbscript):/i.test(v)) delete el.attribs[name];
      else if (name === 'style' && /expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i.test(v)) delete el.attribs[name];
      else if (name === 'srcdoc') delete el.attribs[name];
    }
  });
  return root.html();
}

/* ---------------- keys ---------------- */
function isChrome($, el, chromeSel) {
  return $(el).is(chromeSel) || $(el).parents(chromeSel).length > 0;
}

/**
 * Assign keys inside <body>. `mode` is 'positional' (page still equals the
 * file) or 'random' (page is materialised; new nodes must not shift others).
 * Returns { elements, outline }.
 */
function keyBody($, opts, mode) {
  const editable = (opts.editable || DEFAULT_EDITABLE).join(', ');
  const structural = STRUCTURAL.join(', ');
  const chromeSel = (opts.chrome || DEFAULT_CHROME).join(', ');
  const body = $('body');
  const counters = {};
  const nextKey = (tag) => {
    if (mode === 'random') return randomKey();
    const n = counters[tag] || 0; counters[tag] = n + 1; return `${tag}:${n}`;
  };
  const elements = [];
  const outline = [];

  // Structural first so a section's key is stable before its children get theirs.
  body.find(structural).each((_, el) => {
    const $el = $(el);
    if (isChrome($, el, chromeSel)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'div' && !$el.attr('data-zs') && !$el.attr('id') && !$el.attr('class')) return; // anonymous wrappers stay anonymous
    let key = $el.attr('data-zs');
    if (!key) { key = nextKey(tag); $el.attr('data-zs', key); }
    outline.push({
      key, tag,
      id: $el.attr('id') || undefined,
      class: $el.attr('class') || undefined,
      depth: $el.parents(structural).length,
      text: $el.text().replace(/\s+/g, ' ').trim().slice(0, 80),
      children: $el.children().length,
    });
  });

  body.find(editable).each((_, el) => {
    const $el = $(el);
    if (isChrome($, el, chromeSel)) return;
    if ($el.parents(editable).length && !$el.attr('data-zs')) return; // outermost match wins
    const tag = el.tagName.toLowerCase();
    let key = $el.attr('data-zs');
    if (!key) { key = nextKey(tag); $el.attr('data-zs', key); }
    elements.push({
      key, tag,
      text: $el.text().replace(/\s+/g, ' ').trim().slice(0, 300),
      attrs: pickAttrs($el),
      hidden: $el.attr('hidden') !== undefined,
      section: $el.parents('[data-zs]').first().attr('data-zs') || undefined,
    });
  });
  return { elements, outline };
}

function pickAttrs($el) {
  const a = {};
  for (const k of ATTR_WHITELIST) { const v = $el.attr(k); if (v !== undefined) a[k] = v; }
  return a;
}

/** Replace text, keeping child elements (a list item keeps its icon). */
function setText($, $el, text) {
  $el.contents().each((_, node) => { if (node.type === 'text') $(node).remove(); });
  $el.append(escapeHtml(text));
}

function applyEdits($, pageEdits) {
  if (!pageEdits) return;
  const body = $('body');
  for (const [key, edit] of Object.entries(pageEdits)) {
    const $el = body.find(`[data-zs="${cssEscape(key)}"]`).first();
    if (!$el.length) continue;
    if (edit.html !== undefined) $el.html(sanitize(edit.html));
    else if (edit.text !== undefined) setText($, $el, edit.text);
    if (edit.attrs) {
      for (const [k, v] of Object.entries(edit.attrs)) {
        if (!ATTR_WHITELIST.includes(k)) continue;
        if (v === null || v === '') $el.removeAttr(k); else $el.attr(k, String(v));
      }
    }
    if (edit.hidden === true) $el.attr('hidden', '');
    if (edit.hidden === false) $el.removeAttr('hidden');
  }
}

/* ---------------- body + chrome ---------------- */

/** Detach the file's chrome nodes (scripts, product UI) and return them. */
function takeChrome($, chromeSel) {
  const nodes = [];
  $('body').children().each((_, el) => { if ($(el).is(chromeSel)) nodes.push(el); });
  // Scripts nested deeper (inside main) still count as chrome; hoist them.
  $('body').find('script:not([data-zs-keep])').each((_, el) => { if (!nodes.includes(el) && !$(el).parents().is(chromeSel)) nodes.push(el); });
  for (const n of nodes) $(n).remove();
  return nodes;
}

/**
 * The full render.
 * @param {string} fileHtml   the file for this page (or the template's file for a client page)
 * @param {object} opts       { editable, chrome, title? }
 * @param {object} overlay    the store state
 * @param {string} page       page path
 * @returns {{ html, elements, outline, materialised }}
 */
function render(fileHtml, opts, overlay, page) {
  const $ = load(fileHtml);
  const chromeSel = (opts.chrome || DEFAULT_CHROME).join(', ');
  const snap = overlay.snapshots && overlay.snapshots[page];
  const meta = overlay.pages && overlay.pages[page];
  let materialised = false;

  if (snap !== undefined) {
    const chrome = takeChrome($, chromeSel);
    $('body').html(snap);
    for (const n of chrome) $('body').append(n);
    materialised = true;
  }
  if (meta && meta.title) $('title').text(meta.title);
  if (meta && meta.description !== undefined) {
    let d = $('meta[name="description"]');
    if (!d.length) { $('head').append('<meta name="description" content="">'); d = $('meta[name="description"]'); }
    d.attr('content', meta.description);
  }

  keyBody($, opts, materialised ? 'random' : 'positional');
  applyEdits($, overlay.edits && overlay.edits[page]);

  $('#zs-custom').remove();
  if (overlay.css) $('head').append(`<style id="zs-custom">\n${overlay.css}\n</style>`);

  const { elements, outline } = keyBody($, opts, materialised ? 'random' : 'positional');
  return { html: $.html(), elements, outline, materialised, $ };
}

/**
 * The body html of a rendered page WITHOUT chrome: what a snapshot stores.
 * Keys are already baked in by render().
 */
function bodyForSnapshot($, opts) {
  const chromeSel = (opts.chrome || DEFAULT_CHROME).join(', ');
  const clone = load($.html());
  takeChrome(clone, chromeSel);
  clone('#zs-custom').remove();
  return clone('body').html();
}

/** Assign random keys to any unkeyed editable/structural nodes in a fragment. */
function keyFragment(html, opts) {
  const $ = load(`<body>${html}</body>`);
  keyBody($, opts, 'random');
  return $('body').html();
}

/** The site's own CSS, so an AI can write markup that matches. */
function extractStyles(fileHtml) {
  const $ = load(fileHtml);
  const inline = $('head style').map((_, el) => $(el).html()).get().join('\n\n');
  const links = $('head link[rel="stylesheet"]').map((_, el) => $(el).attr('href')).get();
  return { inline, links };
}

module.exports = { render, sanitize, analyzeForms, formNote, keyFragment, keyBody, bodyForSnapshot, extractStyles, load, DEFAULT_EDITABLE, DEFAULT_CHROME, STRUCTURAL, ATTR_WHITELIST, cssEscape };
