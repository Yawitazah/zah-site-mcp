/* =========================================================
   ZAH SITE MCP, the operations

   Everything a tool or a REST route can do to a site, in one place, so the
   MCP and the REST surface cannot drift. The MCP is a thin wrapper.

   "Materialise" is the one idea to understand: a page starts as Zah's file
   plus small keyed edits. The first STRUCTURAL change (insert, remove,
   move, set_html, create_page) renders the page once, bakes the keys into
   the markup, folds the keyed edits in, and stores the whole body as the
   page's snapshot. From then on the snapshot is the page and structural
   edits are DOM edits on it. reset_page throws the snapshot away.
   ========================================================= */
const fs = require('fs');
const path = require('path');
const R = require('./render');

const RESERVED_PREFIXES = ['/zah-', '/api', '/assets', '/healthz', '/robots.txt', '/sitemap'];
const PATH_RE = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*)(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const MAX_CSS = 200 * 1024;
const MAX_HTML = 400 * 1024;

const normalise = (p) => {
  let s = String(p || '/').trim();
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
};

class SiteOps {
  constructor({ store, assets, builtPages, opts, settingsSchema }) {
    this.store = store;
    this.assets = assets;
    this.built = builtPages;               // [{path, file, root}]
    this.template = builtPages[0];
    this.opts = opts;                      // { editable, chrome }
    this.settingsSchema = settingsSchema;
    this.host = '';                        // set by mount from publicUrl; forms may not post here
    this.crm = null;                       // { leadPath, enabled(), contactUrl } from mount
  }

  ctx() { return { host: this.host, crm: this.crm }; }

  /* ---------- pages ---------- */

  isBuilt(p) { return this.built.some((b) => b.path === normalise(p)); }

  page(p) {
    const np = normalise(p);
    const b = this.built.find((x) => x.path === np);
    if (b) return { path: np, file: b.file, root: b.root, custom: false };
    const meta = this.store.read().pages[np];
    if (meta) return { path: np, file: this.template.file, root: this.template.root, custom: true, meta };
    return null;
  }

  listPages() {
    const state = this.store.read();
    const out = this.built.map((b) => ({ path: b.path, built: true, materialised: state.snapshots[b.path] !== undefined, edits: Object.keys(state.edits[b.path] || {}).length }));
    for (const [p, meta] of Object.entries(state.pages)) out.push({ path: p, built: false, title: meta.title, createdAt: meta.createdAt, materialised: true, edits: Object.keys(state.edits[p] || {}).length });
    return out;
  }

  readFile(p) { return fs.readFileSync(p.file, 'utf8'); }

  render(p) { return R.render(this.readFile(p), this.opts, this.store.read(), p.path); }
  list(p) { return this.render(p).elements; }
  outline(p) { return this.render(p).outline; }

  /* ---------- keyed edits ---------- */

  find(p, key) { return this.list(p).find((e) => e.key === key) || null; }

  edit(p, key, edit, by) {
    const el = this.find(p, key);
    if (!el) return { error: `No element "${key}" on ${p.path}. Use list_content.` };
    if (edit.attrs && edit.attrs.href !== undefined && el.tag !== 'a') return { error: `"${key}" is a <${el.tag}>, not a link.` };
    if (edit.attrs && edit.attrs.src !== undefined && !['img', 'video'].includes(el.tag)) return { error: `"${key}" is a <${el.tag}>, not an image or video.` };
    const state = this.store.applyEdits(p.path, { [key]: edit }, by);
    return { ok: true, version: state.version, element: this.find(p, key) };
  }

  editMany(p, edits, by) {
    const known = new Set(this.list(p).map((e) => e.key));
    const batch = {};
    for (const e of edits) {
      if (!known.has(e.key)) return { error: `No element "${e.key}" on ${p.path}. Nothing was changed.` };
      const edit = {};
      if (e.text !== undefined) edit.text = e.text;
      const attrs = {};
      for (const k of ['href', 'src', 'alt']) if (e[k] !== undefined) attrs[k] = e[k];
      if (Object.keys(attrs).length) edit.attrs = attrs;
      if (e.hidden !== undefined) edit.hidden = e.hidden;
      batch[e.key] = edit;
    }
    const state = this.store.applyEdits(p.path, batch, by);
    return { ok: true, version: state.version, changed: Object.keys(batch) };
  }

  /* ---------- structure ---------- */

  /** Render, hand the DOM to fn, key any new nodes, store the body as the snapshot. */
  withDom(p, fn, by) {
    const r = this.render(p);
    const $ = r.$;
    const result = fn($, r) || {};
    if (result.error) return result;
    // New nodes get random keys, existing keys are untouched.
    R.keyBody($, this.opts, 'random');
    const body = R.bodyForSnapshot($, this.opts);
    if (body.length > MAX_HTML * 4) return { error: `The page would be ${Math.round(body.length / 1024)}KB of HTML, over the limit. Put images and video in assets, not inline.` };
    const state = this.store.setSnapshot(p.path, body, by);
    return Object.assign({ ok: true, version: state.version, materialised: true }, result);
  }

  target($, key) {
    if (!key || key === 'body') return $('body');
    const $el = $('body').find(`[data-zs="${R.cssEscape(key)}"]`).first();
    return $el.length ? $el : null;
  }

  getHtml(p, key) {
    const r = this.render(p);
    if (!key || key === 'body') return { html: R.bodyForSnapshot(r.$, this.opts) };
    const $el = this.target(r.$, key);
    if (!$el) return { error: `No element "${key}" on ${p.path}.` };
    return { key, html: r.$.html($el) };
  }

  setHtml(p, key, html, by) {
    if (String(html).length > MAX_HTML) return { error: `That HTML is over ${MAX_HTML / 1024}KB.` };
    return this.withDom(p, ($) => {
      const $el = this.target($, key);
      if (!$el) return { error: `No element "${key}" on ${p.path}.` };
      if ($el.is('body')) { $el.html(R.sanitize(html, this.ctx())); return { replaced: 'body', forms: R.analyzeForms(html, this.ctx()) }; }
      const frag = R.keyFragment(R.sanitize(html, this.ctx()), this.opts);
      $el.replaceWith(frag);
      return { replaced: key, forms: R.analyzeForms(html, this.ctx()) };
    }, by);
  }

  insertHtml(p, html, position, targetKey, by) {
    if (String(html).length > MAX_HTML) return { error: `That HTML is over ${MAX_HTML / 1024}KB.` };
    return this.withDom(p, ($) => {
      const $t = this.target($, targetKey);
      if (!$t) return { error: `No element "${targetKey}" on ${p.path}. Use get_outline to pick a target.` };
      if ($t.is('body') && (position === 'before' || position === 'after')) return { error: 'Use append or prepend with target "body".' };
      const frag = R.keyFragment(R.sanitize(html, this.ctx()), this.opts);
      const $frag = R.load(`<body>${frag}</body>`)('body').children();
      const keys = $frag.map((_, el) => $(el).attr('data-zs')).get().filter(Boolean);
      if (position === 'before') $t.before(frag);
      else if (position === 'after') $t.after(frag);
      else if (position === 'prepend') $t.prepend(frag);
      else $t.append(frag);
      return { inserted: keys, position, target: targetKey || 'body', forms: R.analyzeForms(html, this.ctx()) };
    }, by);
  }

  remove(p, key, by) {
    return this.withDom(p, ($) => {
      const $el = this.target($, key);
      if (!$el || $el.is('body')) return { error: `No element "${key}" on ${p.path}.` };
      if ($el.is('main') || $el.is('header') || $el.is('footer')) return { error: `"${key}" is the page's <${$el[0].tagName.toLowerCase()}>. Hide it with set_hidden or empty it with set_html instead of removing it.` };
      $el.remove();
      return { removed: key };
    }, by);
  }

  move(p, key, position, targetKey, by) {
    return this.withDom(p, ($) => {
      const $el = this.target($, key);
      const $t = this.target($, targetKey);
      if (!$el || $el.is('body')) return { error: `No element "${key}" on ${p.path}.` };
      if (!$t) return { error: `No element "${targetKey}" on ${p.path}.` };
      if ($t.is($el) || $t.parents().is($el)) return { error: 'Cannot move an element into itself.' };
      $el.remove();
      if (position === 'before') $t.before($el);
      else if (position === 'after') $t.after($el);
      else if (position === 'prepend') $t.prepend($el);
      else $t.append($el);
      return { moved: key, position, target: targetKey };
    }, by);
  }

  duplicate(p, key, by) {
    return this.withDom(p, ($) => {
      const $el = this.target($, key);
      if (!$el || $el.is('body')) return { error: `No element "${key}" on ${p.path}.` };
      const html = $.html($el).replace(/\sdata-zs="[^"]*"/g, '');
      const frag = R.keyFragment(html, this.opts);
      $el.after(frag);
      const newKey = R.load(`<body>${frag}</body>`)('body').children().first().attr('data-zs');
      return { duplicated: key, newKey };
    }, by);
  }

  /* ---------- pages ---------- */

  createPage(pagePath, meta, from, html, by) {
    const np = normalise(pagePath);
    if (!PATH_RE.test(np)) return { error: 'Page path must look like /about or /services/massage: lowercase letters, numbers and hyphens.' };
    if (RESERVED_PREFIXES.some((r) => np === r || np.startsWith(r))) return { error: `"${np}" is reserved.` };
    if (this.page(np)) return { error: `A page already exists at ${np}. Edit it, or delete_page first.` };
    const src = this.page(from || this.template.path);
    if (!src) return { error: `No page "${from}" to start from.` };
    const r = this.render(src);
    const $ = r.$;
    // Start from a rendered copy of `from`, keys stripped so this page gets its own.
    $('body').find('[data-zs]').removeAttr('data-zs');
    if (html !== undefined && html !== null) {
      const $root = $('body').find(src.root).first();
      const clean = R.sanitize(html, this.ctx());
      if ($root.length) $root.html(clean); else $('body').append(clean);
    }
    R.keyBody($, this.opts, 'random');
    const body = R.bodyForSnapshot($, this.opts);
    const state = this.store.createPage(np, { title: meta.title || np.slice(1), description: meta.description }, body, by);
    return { ok: true, version: state.version, path: np, url: np, forms: html ? R.analyzeForms(html, this.ctx()) : [] };
  }

  setPageMeta(p, meta, by) {
    const np = p.path;
    const state = this.store.update((s) => {
      if (!s.pages[np]) s.pages[np] = { createdAt: new Date().toISOString(), builtOverride: true };
      if (meta.title !== undefined) s.pages[np].title = meta.title;
      if (meta.description !== undefined) s.pages[np].description = meta.description;
    }, by);
    return { ok: true, version: state.version };
  }

  deletePage(p, by) {
    if (!p.custom) return { error: `${p.path} is part of the site as built. reset_page returns it to the build; it cannot be deleted.` };
    const state = this.store.deletePage(p.path, by);
    return { ok: true, version: state.version, deleted: p.path };
  }

  resetPage(p, by) {
    const state = this.store.clearPage(p.path, by);
    return { ok: true, version: state.version, page: p.path, now: p.custom ? 'deleted (it was client-created)' : 'as built' };
  }

  resetSite(by) {
    const state = this.store.resetSite(by);
    return { ok: true, version: state.version, now: 'every page as built; assets and settings kept' };
  }

  /* ---------- forms and ZAH CRM ---------- */

  /** What a form on this site can do, for the AI to explain to the client. */
  formsInfo() {
    const crm = this.crm || {};
    const connected = !!(crm.enabled && crm.enabled());
    return {
      defaultDestination: 'ZAH CRM',
      zahCrm: {
        connected,
        leadPath: crm.leadPath || null,
        fields: crm.fields || ['name', 'email', 'phone', 'service', 'message'],
        how: connected
          ? `Connected. A form with action="${crm.leadPath}" and method="post" sends every submission to the client's ZAH CRM as a lead. Use the field names listed; anything else goes into the lead's note.`
          : `Not connected on this site yet. Ask the client: would you like this form connected to ZAH CRM? If yes, they contact Zah (${crm.contactUrl || 'https://zahbrandsolutions.com/contact'}) and he switches it on; nothing is built on the site. Until then a form with action="${crm.leadPath || '/api/lead'}" is inert.`,
        trialUrl: crm.trialUrl || 'https://zahcrm.com',
      },
      ownService: 'A form may instead post to the client\'s own outside service (Formspree, Google Forms, Airtable, their own backend) via an https action. Nothing is stored on this site.',
      never: 'This site has no database for form data and none can be added through the MCP. A form aimed at this site itself is made inert.',
    };
  }

  /* ---------- css ---------- */

  getStyles() {
    const s = R.extractStyles(this.readFile(this.template));
    return { siteCss: s.inline, stylesheets: s.links, customCss: this.store.read().css || '' };
  }
  setCss(css, by) {
    if (String(css).length > MAX_CSS) return { error: `CSS is over ${MAX_CSS / 1024}KB.` };
    const state = this.store.setCss(css, by);
    return { ok: true, version: state.version, bytes: String(css).length };
  }
  appendCss(css, by) {
    const cur = this.store.read().css || '';
    return this.setCss((cur ? cur + '\n\n' : '') + String(css), by);
  }

  /* ---------- settings ---------- */

  settings() {
    const stored = this.store.read().settings || {};
    const out = {};
    for (const [k, def] of Object.entries(this.settingsSchema)) out[k] = stored[k] !== undefined ? stored[k] : def.default;
    return out;
  }
  setSetting(key, value, by) {
    const def = this.settingsSchema[key];
    if (!def) return { error: `No setting "${key}". Settings: ${Object.keys(this.settingsSchema).join(', ') || 'none'}` };
    if (value === null || value === '') { this.store.setSettings({ [key]: null }, by); return { ok: true, value: def.default, reset: true }; }
    const v = String(value).trim().slice(0, 2000);
    const problem = KINDS[def.kind](v);
    if (problem) return { error: `${key} ${problem}` };
    this.store.setSettings({ [key]: v }, by);
    return { ok: true, value: v };
  }
}

const KINDS = {
  url: (v) => /^(https?:\/\/|mailto:|tel:|\/|#)/i.test(v) ? null : 'must start with https://, http://, mailto:, tel:, / or #',
  phone: (v) => /\d{7,}/.test(v.replace(/\D/g, '')) ? null : 'must contain at least 7 digits',
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : 'must be an email address',
  text: (v) => v.length <= 500 ? null : 'must be 500 characters or fewer',
};

module.exports = { SiteOps, KINDS, normalise, RESERVED_PREFIXES };
