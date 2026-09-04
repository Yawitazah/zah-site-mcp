/* =========================================================
   ZAH SITE MCP

   Lets a client's own AI (Claude, or anything that speaks MCP) read and
   change their ZAH-built site, and gives Zah Editor a real Publish so edits
   reach every visitor instead of one browser's localStorage.

   ONE ENTRY POINT:

     const zahSite = require('zah-site-mcp');
     zahSite.mount(app, {
       siteId: 'new-vision',
       name: 'New Vision Therapy & Wellness',
       dataDir: process.env.DATA_DIR || '/data',
       token: process.env.SITE_MCP_TOKEN,          // the client's AI presents this
       adminHash: '<sha256 of email:password>',    // Zah Editor login, for Publish
       pages: [{ path: '/', file: path.join(__dirname, 'index.html'), root: 'main' }],
       publicUrl: process.env.PUBLIC_URL,
     });

   Mount it BEFORE express.static, because it serves the listed pages itself
   (file + overlay). Everything it owns lives under /zah-site/* and
   <dataDir>/zah-site/. It reads no site styling and renders no UI.

   Without `token` the MCP and the REST routes refuse every call (fail
   closed: writes are dangerous), but pages still serve, with whatever
   overlay exists. Without `adminHash` the editor cannot publish, but the
   MCP still works.
   ========================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const { render, DEFAULT_EDITABLE } = require('./lib/render');
const { handleMcp } = require('./lib/mcp');

const PREFIX = '/zah-site';

/**
 * @typedef {object} Site
 * @property {string} id
 * @property {string} name
 * @property {Store} store
 * @property {Array<{path:string,file:string,root:string,editable?:string[]}>} pages
 * @property {(p:string)=>object|null} page
 * @property {(p:object)=>Array} list
 * @property {string} [publicUrl]
 */

function mount(app, cfg) {
  if (!app || typeof app.use !== 'function') throw new Error('zah-site-mcp: mount(app, cfg) needs an Express app');
  if (!cfg || !cfg.siteId) throw new Error('zah-site-mcp: cfg.siteId is required');
  if (!Array.isArray(cfg.pages) || !cfg.pages.length) throw new Error('zah-site-mcp: cfg.pages must list at least one page');

  const dataDir = cfg.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const store = new Store(dataDir);
  const token = String(cfg.token || '');
  const adminHash = String(cfg.adminHash || '');
  const express = cfg.express || require('express');

  const pages = cfg.pages.map((p) => ({
    path: p.path,
    file: p.file,
    root: p.root || 'main',
    editable: p.editable || DEFAULT_EDITABLE,
  }));

  /** @type {Site} */
  const site = {
    id: cfg.siteId,
    name: cfg.name || cfg.siteId,
    publicUrl: cfg.publicUrl,
    store,
    pages,
    page: (p) => pages.find((x) => x.path === normalise(p)) || null,
    list: (p) => render(readFile(p.file), p, store.read(), p.path).elements,
  };

  // ---------- auth ----------
  const okToken = (presented) => {
    if (!token || !presented) return false;
    const a = Buffer.from(String(presented));
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const bearer = (req) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : (req.params && req.params.token) || '';
  };
  const requireToken = (req, res, next) => {
    if (!token) return res.status(503).json({ error: 'ZAH Site MCP is not switched on for this site (no SITE_MCP_TOKEN).' });
    if (!okToken(bearer(req))) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  const json = express.json({ limit: '2mb' });

  // ---------- pages ----------
  // Cached per page on (file mtime, overlay version).
  const cache = new Map();
  for (const p of pages) {
    app.get(p.path, (req, res, next) => {
      try {
        const stat = fs.statSync(p.file);
        const state = store.read();
        const cacheKey = `${stat.mtimeMs}:${state.version}`;
        let html = cache.get(p.path + '|' + cacheKey);
        if (!html) {
          html = render(readFile(p.file), p, state, p.path).html;
          cache.clear();
          cache.set(p.path + '|' + cacheKey, html);
        }
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Zah-Site-Version', String(state.version));
        res.type('html').send(html);
      } catch (e) {
        console.error('[zah-site] render failed, serving file as is:', e.message);
        next();
      }
    });
  }

  // ---------- MCP ----------
  const mcp = async (req, res) => handleMcp(site, req, res);
  app.post(`${PREFIX}/mcp`, requireToken, json, mcp);
  app.post(`${PREFIX}/mcp/k/:token`, requireToken, json, mcp);
  // Stateless transport: no SSE stream to resume, no session to delete.
  app.get([`${PREFIX}/mcp`, `${PREFIX}/mcp/k/:token`], requireToken, (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC here.' }, id: null }));
  app.delete([`${PREFIX}/mcp`, `${PREFIX}/mcp/k/:token`], requireToken, (_req, res) => res.status(204).end());

  // ---------- REST (what publish.js and any script uses) ----------
  app.get(`${PREFIX}/status`, (_req, res) => {
    const s = store.read();
    res.json({ site: site.id, mcp: !!token, publish: !!adminHash, version: s.version, updatedAt: s.updatedAt, pages: pages.map((p) => p.path) });
  });

  // Zah Editor login → the site token. The editor already gates itself on
  // this same hash client-side; this is the server saying so too, so the
  // token never has to be typed into a page.
  app.post(`${PREFIX}/login`, json, (req, res) => {
    if (!adminHash || !token) return res.status(503).json({ error: 'Publishing is not switched on for this site.' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const h = crypto.createHash('sha256').update(`${email}:${password}`).digest('hex');
    if (h !== adminHash) return res.status(401).json({ error: 'Login failed.' });
    res.json({ token });
  });

  app.get(`${PREFIX}/content`, requireToken, (req, res) => {
    const p = site.page(String(req.query.page || '/'));
    if (!p) return res.status(404).json({ error: 'no such page' });
    res.json({ page: p.path, version: store.read().version, elements: site.list(p) });
  });

  app.post(`${PREFIX}/edits`, requireToken, json, (req, res) => {
    const p = site.page(String((req.body && req.body.page) || '/'));
    if (!p) return res.status(404).json({ error: 'no such page' });
    const edits = req.body && req.body.edits;
    if (!edits || typeof edits !== 'object') return res.status(400).json({ error: 'edits object required' });
    const state = store.applyEdits(p.path, edits, 'rest');
    res.json({ ok: true, version: state.version });
  });

  // Whole-root publish from Zah Editor.
  app.post(`${PREFIX}/snapshot`, requireToken, json, (req, res) => {
    const p = site.page(String((req.body && req.body.page) || '/'));
    if (!p) return res.status(404).json({ error: 'no such page' });
    const html = String((req.body && req.body.html) || '');
    if (!html.trim()) return res.status(400).json({ error: 'html required' });
    if (html.length > 1.5 * 1024 * 1024) return res.status(413).json({ error: 'snapshot too large; embedded images should be uploaded, not pasted' });
    const state = store.setSnapshot(p.path, html, 'editor');
    res.json({ ok: true, version: state.version });
  });

  app.get(`${PREFIX}/history`, requireToken, (_req, res) => {
    const cur = store.read();
    res.json({ current: { version: cur.version, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy }, previous: store.history() });
  });

  app.post(`${PREFIX}/revert`, requireToken, json, (req, res) => {
    try {
      const state = store.revert(Number(req.body && req.body.version), 'revert');
      res.json({ ok: true, version: state.version });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post(`${PREFIX}/reset`, requireToken, json, (req, res) => {
    const p = site.page(String((req.body && req.body.page) || '/'));
    if (!p) return res.status(404).json({ error: 'no such page' });
    res.json({ ok: true, version: store.clearPage(p.path, 'rest').version });
  });

  // The editor bridge, served from the package so every site gets fixes.
  app.get(`${PREFIX}/publish.js`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(__dirname, 'public', 'publish.js'));
  });

  console.log(`[zah-site] ${site.id}: mcp ${token ? 'ON' : 'off (no token)'}, publish ${adminHash && token ? 'ON' : 'off'}, data ${store.dir}, pages ${pages.map((p) => p.path).join(' ')}`);
  return site;
}

const normalise = (p) => {
  let s = String(p || '/').trim();
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
};
const readFile = (f) => fs.readFileSync(f, 'utf8');

module.exports = { mount, PREFIX };
