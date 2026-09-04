/* =========================================================
   ZAH SITE MCP, the store

   One JSON file per site, on disk, under a directory the product owns:
   <dataDir>/zah-site/overlay.json plus a history/ folder of every previous
   version. No database. A client site is a handful of pages and a few dozen
   edits; a file on a Railway volume is the right size of machinery, and it
   is trivially exportable, which the agreement promises.

   Shape:
     {
       version: 12,                       // bumps on every write
       updatedAt: "2026-09-04T...",
       updatedBy: "mcp" | "editor" | "revert",
       snapshots: { "/": "<inner html of the root>" },   // whole-root publishes
       edits:     { "/": { "h1:0": { text, attrs, hidden } } } // keyed edits
     }
   ========================================================= */
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ version: 0, updatedAt: null, updatedBy: null, snapshots: {}, edits: {} });

class Store {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'zah-site');
    this.file = path.join(this.dir, 'overlay.json');
    this.historyDir = path.join(this.dir, 'history');
    this._cache = null;
  }

  ensure() {
    fs.mkdirSync(this.historyDir, { recursive: true });
  }

  read() {
    if (this._cache) return this._cache;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this._cache = Object.assign(EMPTY(), parsed);
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
    }
    const state = Object.assign(EMPTY(), next, {
      version: prev.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: by || 'mcp',
    });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
    this._cache = state;
    return state;
  }

  /** Merge keyed edits into a page. `edits` is { key: {text?, html?, attrs?, hidden?} }. */
  applyEdits(page, edits, by) {
    const state = clone(this.read());
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
    return this.write(state, by);
  }

  setSnapshot(page, html, by) {
    const state = clone(this.read());
    state.snapshots[page] = html;
    // A whole-root publish supersedes keyed edits made before it: the keys
    // may not even exist in the new markup, and the editor's author has
    // just seen the page as they want it.
    delete state.edits[page];
    return this.write(state, by);
  }

  clearPage(page, by) {
    const state = clone(this.read());
    delete state.snapshots[page];
    delete state.edits[page];
    return this.write(state, by);
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

  /** Restore a previous version (by number). The current state is itself archived first. */
  revert(version, by) {
    const entry = this.history().find((h) => h.version === Number(version));
    if (!entry) throw new Error(`no version ${version} in history`);
    const prev = JSON.parse(fs.readFileSync(path.join(this.historyDir, entry.file), 'utf8'));
    return this.write({ snapshots: prev.snapshots || {}, edits: prev.edits || {} }, by || 'revert');
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));

module.exports = { Store };
