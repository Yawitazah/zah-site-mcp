/* =========================================================
   ZAH SITE MCP, the renderer

   Takes a page's HTML file and the overlay, and produces what the visitor
   sees. Three passes, always in this order:

     1. snapshot   a whole-root publish from Zah Editor replaces the root's
                   innerHTML
     2. keys       every editable element gets a stable data-zs key, in
                   document order: "h2:3", "p:12", "img:0"... An element that
                   already carries data-zs keeps it, so a page author can name
                   the things that matter ("hero.title") and the AI sees
                   those names
     3. edits      keyed edits are applied: text, html, attrs, hidden

   Keys are positional, so they are stable as long as the page's STRUCTURE
   is; a text change never moves a key. The MCP never adds or removes
   elements, which is what keeps that true.
   ========================================================= */
const cheerio = require('cheerio');

const DEFAULT_EDITABLE = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'blockquote', 'figcaption', 'a.btn', 'a.button', 'img'];
const ATTR_WHITELIST = ['href', 'src', 'alt', 'title', 'target'];

function load(html) {
  return cheerio.load(html, { decodeEntities: false });
}

/** Assign keys inside root. Returns the list of {key, tag, text, attrs}. */
function keyElements($, rootSel, editable) {
  const root = $(rootSel).first();
  if (!root.length) return [];
  const sel = (editable || DEFAULT_EDITABLE).join(', ');
  const counters = {};
  const out = [];
  root.find(sel).each((_, el) => {
    const $el = $(el);
    // Outermost match wins: a <p> inside an <li> is part of the li's text.
    if ($el.parents(sel).length && !$el.attr('data-zs')) return;
    const tag = el.tagName.toLowerCase();
    let key = $el.attr('data-zs');
    if (!key) {
      const n = counters[tag] || 0;
      counters[tag] = n + 1;
      key = `${tag}:${n}`;
      $el.attr('data-zs', key);
    }
    out.push({ key, tag, text: ownText($el), attrs: pickAttrs($el), hidden: $el.attr('hidden') !== undefined });
  });
  return out;
}

/** The element's text with inline markup flattened, capped for listings. */
function ownText($el) {
  return $el.text().replace(/\s+/g, ' ').trim().slice(0, 300);
}

function pickAttrs($el) {
  const a = {};
  for (const k of ATTR_WHITELIST) {
    const v = $el.attr(k);
    if (v !== undefined) a[k] = v;
  }
  return a;
}

/**
 * Replace an element's text while keeping its child ELEMENTS in place, so a
 * list item keeps its check icon and a heading keeps its kicker span. All
 * direct text nodes are removed and one new text node is appended after the
 * last child element (or as the only content).
 */
function setText($, $el, text) {
  $el.contents().each((_, node) => { if (node.type === 'text') $(node).remove(); });
  $el.append(escapeHtml(text));
}
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function applyEdits($, rootSel, pageEdits) {
  const root = $(rootSel).first();
  if (!root.length || !pageEdits) return;
  for (const [key, edit] of Object.entries(pageEdits)) {
    const $el = root.find(`[data-zs="${cssEscape(key)}"]`).first();
    if (!$el.length) continue;
    if (edit.html !== undefined) $el.html(edit.html);
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

const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');

/**
 * Full render. Returns { html, elements } where elements is the keyed listing
 * AFTER edits (what the visitor actually sees).
 */
function render(fileHtml, { root = 'main', editable } = {}, overlay = {}, page = '/') {
  const $ = load(fileHtml);
  const snap = overlay.snapshots && overlay.snapshots[page];
  if (snap) $(root).first().html(snap);
  keyElements($, root, editable);
  applyEdits($, root, overlay.edits && overlay.edits[page]);
  const elements = keyElements($, root, editable);
  return { html: $.html(), elements };
}

/** Listing only, no edits applied: the source of truth for "what is on this page". */
function listing(fileHtml, opts, overlay, page) {
  return render(fileHtml, opts, overlay, page).elements;
}

module.exports = { render, listing, DEFAULT_EDITABLE, ATTR_WHITELIST };
