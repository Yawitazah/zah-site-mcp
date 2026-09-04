/* =========================================================
   ZAH SITE MCP, the store

   One JSON file per site, on disk, under a directory the product owns:
   <dataDir>/zah-site/overlay.json plus history/ (every previous version)
   and assets/ (the client's uploads). No database. A client site is a
   handful of pages and some edits; a file on a Railway volume is the right
   size of machinery, and it is trivially exportable.

   THE MODEL. The files Zah shipped are the permanent default. Everything
   here is an overlay on them:

     {
       version, updatedAt, updatedBy,
       snapshots: { "/": "<body html>" },      // a page the client restructured
       edits:     { "/": { key: {text, html, attrs, hidden} } }, // small keyed edits
       pages:     { "/about": { title, createdAt } },  // pages the client created
       css:       "...",                        // the client's stylesheet, every page
       settings:  { bookingUrl, phone }         // values the host declared
     }

   reset_page drops a page's snapshot and edits; reset_site drops it all.
   Assets are files, kept across resets, deleted only by name.
   ========================================================= */
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ version: 0, updatedAt: null, updatedBy: null, snapshots: {}, edits: {}, pages: {}, css: '', settings: {} });
const clone = (o) => JSON.parse(JSON.stringify(o));

class Store {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'zah-site');
    this.file = path.join(this.dir, 'overlay.json');
    this.historyDir = path.join(this.dir, 'history');
    this.assetsDir = path.join(this.dir, 'assets');
    this._cache = null;
  }

  ensure() {
    fs.mkdirSync(this.historyDir, { recursive: true });
    fs.mkdirSync(this.assetsDir, { recursive: true });
  }

  read() {
    if (this._cache) return this._cache;
    try {
      this._cache = Object.assign(EMPTY(), JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {
      this._cache = EMPTY();
    }
    return this._cache;
  }

  /** Persist a new state. The previous state goes to history first. */
  write(next, by) {
    this.ensure();
    const prev = this.read();
    if (prev.version > 0) {
      const name = `${String(prev.version).padStart(6, '0')}-${(prev.updatedAt || '').replace(/[:.]/g, '-') || 'init'}.json`;
      fs.writeFileSync(path.join(this.historyDir, name), JSON.stringify(prev));
      this.pruneHistory(200);
    }
    const state = Object.assign(EMPTY(), next, {
      version: prev.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: by || 'mcp',
    });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.file);
    this._cache = state;
    return state;
  }

  /** Change the current state through a function and persist it. */
  update(fn, by) {
    const state = clone(this.read());
    fn(state);
    return this.write(state, by);
  }

  applyEdits(page, edits, by) {
    return this.update((state) => {
      const pageEdits = state.edits[page] || (state.edits[page] = {});
      for (const [key, edit] of Object.entries(edits)) {
        if (edit === null) { delete pageEdits[key]; continue; }
        const cur = pageEdits[key] || {};
        if (edit.text !== undefined) { cur.text = edit.text; delete cur.html; }
        if (edit.html !== undefined) { cur.html = edit.html; delete cur.text; }
        if (edit.attrs) cur.attrs = Object.assign({}, cur.attrs || {}, edit.attrs);
        if (edit.hidden !== undefined) cur.hidden = !!edit.hidden;
        pageEdits[key] = cur;
      }
    }, by);
  }

  /** A whole-body snapshot for a page. Keyed edits are folded in by the caller before this. */
  setSnapshot(page, html, by) {
    return this.update((state) => {
      state.snapshots[page] = html;
      delete state.edits[page];
    }, by);
  }

  createPage(pagePath, meta, html, by) {
    return this.update((state) => {
      state.pages[pagePath] = Object.assign({ createdAt: new Date().toISOString() }, meta);
      state.snapshots[pagePath] = html;
      delete state.edits[pagePath];
    }, by);
  }

  deletePage(pagePath, by) {
    return this.update((state) => {
      delete state.pages[pagePath];
      delete state.snapshots[pagePath];
      delete state.edits[pagePath];
    }, by);
  }

  setCss(css, by) {
    return this.update((state) => { state.css = String(css || ''); }, by);
  }

  setSettings(patch, by) {
    return this.update((state) => {
      state.settings = Object.assign({}, state.settings || {}, patch);
      for (const k of Object.keys(state.settings)) if (state.settings[k] === null) delete state.settings[k];
    }, by);
  }

  /** Back to the file as built (or, for a client-created page, gone). */
  clearPage(page, by) {
    return this.update((state) => {
      delete state.snapshots[page];
      delete state.edits[page];
      delete state.pages[page];
    }, by);
  }

  /** Everything back to the build. Assets and settings survive; they are not layout. */
  resetSite(by) {
    return this.update((state) => {
      state.snapshots = {}; state.edits = {}; state.pages = {}; state.css = '';
    }, by);
  }

  history() {
    try {
      return fs.readdirSync(this.historyDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .map((f) => {
          const m = f.match(/^(\d+)-/);
          return { version: m ? Number(m[1]) : null, file: f };
        });
    } catch (e) {
      return [];
    }
  }

  pruneHistory(keep) {
    const all = this.history();
    for (const h of all.slice(keep)) {
      try { fs.unlinkSync(path.join(this.historyDir, h.file)); } catch (e) { /* ignore */ }
    }
  }

  revert(version, by) {
    const entry = this.history().find((h) => h.version === Number(version));
    if (!entry) throw new Error(`no version ${version} in history`);
    const prev = JSON.parse(fs.readFileSync(path.join(this.historyDir, entry.file), 'utf8'));
    return this.write({
      snapshots: prev.snapshots || {}, edits: prev.edits || {}, pages: prev.pages || {},
      css: prev.css || '', settings: prev.settings || {},
    }, by || 'revert');
  }

  /** Bytes used by everything under the product's directory. */
  usageBytes() {
    let total = 0;
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { try { total += fs.statSync(p).size; } catch (x) { /* ignore */ } }
      }
    };
    walk(this.dir);
    return total;
  }
}

module.exports = { Store, EMPTY };
